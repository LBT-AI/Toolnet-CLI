/**
 * Phase 79 §10/§11/§13 — Canonical ModelRouter.
 *
 * One router, deterministic rules, no ML. Selection order:
 *
 *   1. explicit provider + model
 *   2. explicit model
 *   3. policy-selected model (priority | cheapest | fastest | capability-first)
 *   4. configured fallback chain
 *   5. structured ModelRoutingError
 *
 * Two invariants that keep routing honest:
 *
 *  - An explicitly requested model is NEVER silently swapped. The candidate
 *    chain stays pinned to it unless the policy is `fallback` (or a configured
 *    fallback chain exists), and even then the explicit model stays first.
 *  - Fallback only happens for RETRYABLE failures. Auth failures, invalid
 *    requests, permission denials, schema errors and user cancellation are
 *    terminal — retrying them burns budget and hides the real error.
 */

import { getActiveProviderConfig } from "../../providers";
import { modelCatalog, ModelCatalog } from "./catalog";
import { ProviderError, ModelRoutingError, ProviderNotFoundError, ProviderUnavailableError } from "./errors";
import { healthRank } from "./health";
import { missingCapabilities } from "./capabilities";
import { parseModelRef } from "./ref";
import { providerRegistry, ProviderRegistry } from "./registry";
import type { ModelDefinition, ModelRef, ProviderDefinition, ResolvedModel, RoutingPolicy, RoutingRequest } from "./types";
import { blendedPrice, satisfiesCapabilities } from "./types";

export interface RoutingConfig {
  policy: RoutingPolicy;
  /** Ordered fallback references appended after the head candidate. */
  fallback: string[];
  /** Attempts per routing decision, including the head. */
  maxAttempts: number;
  /** Providers never considered unless explicitly named. */
  excludedProviders: string[];
}

let routingConfig: RoutingConfig = {
  policy: "priority",
  fallback: [],
  maxAttempts: 3,
  excludedProviders: [],
};

export function setRoutingConfig(patch: Partial<RoutingConfig>): RoutingConfig {
  routingConfig = { ...routingConfig, ...patch };
  return { ...routingConfig };
}

export function getRoutingConfig(): RoutingConfig {
  return { ...routingConfig };
}

export function resetRoutingConfig(): void {
  routingConfig = { policy: "priority", fallback: [], maxAttempts: 3, excludedProviders: [] };
}

interface Candidate {
  provider: ProviderDefinition;
  model: ModelDefinition;
  rank: number;
  reason: string;
}

export interface RouterOptions {
  registry?: ProviderRegistry;
  catalog?: ModelCatalog;
  /** Active-provider lookup used to qualify bare references. Injectable so
   *  routing decisions are reproducible in tests. */
  activeProviderId?: () => string | null;
}

export class ModelRouter {
  private readonly registry: ProviderRegistry;
  private readonly catalog: ModelCatalog;
  private readonly activeProviderId: () => string | null;

  constructor(options: RouterOptions = {}) {
    this.registry = options.registry ?? providerRegistry;
    this.catalog = options.catalog ?? modelCatalog;
    this.activeProviderId = options.activeProviderId ?? activeProviderId;
  }

  // ── Resolution ────────────────────────────────────────────────────────────

  resolve(request: RoutingRequest = {}): ResolvedModel {
    if (request.signal?.aborted) {
      throw new ModelRoutingError("Routing cancelled by caller.", { retryable: false });
    }

    const policy: RoutingPolicy = request.policy ?? routingConfig.policy;
    const excluded = new Set(
      [...routingConfig.excludedProviders, ...(request.excludedProviders ?? [])].map((id) => id.toLowerCase()),
    );

    const pinned = this.resolvePinned(request, excluded);

    // Explicit pin under a non-fallback policy: the chain is exactly that model.
    if (pinned && policy === "explicit") {
      return this.buildResolved(pinned, [pinned], `explicit ${pinned.model.id}`);
    }

    const candidates = this.rankCandidates(request, policy, excluded);

    // The explicit pin always heads the chain, even when the policy would have
    // ranked another model first.
    const ordered = pinned
      ? [this.describe(pinned, "explicit request"), ...candidates.filter((c) => c.model.id !== pinned.model.id)]
      : candidates;

    if (ordered.length === 0) {
      throw new ModelRoutingError(
        `No model satisfies the routing request${request.model ? ` for '${request.model}'` : ""}` +
          `${request.requiredCapabilities ? ` with capabilities ${JSON.stringify(request.requiredCapabilities)}` : ""}.`,
        { model: request.model, provider: request.provider, retryable: false },
      );
    }

    // Fallback is a config-level capability: it is enabled by an explicit
    // `fallback` policy, by the configured policy, or by a configured chain —
    // even when the request overrides only the ORDERING policy.
    const appliedFallback =
      policy === "fallback" || routingConfig.policy === "fallback" || routingConfig.fallback.length > 0;
    // The configured fallback list is honoured in order, then the policy-ranked
    // pool fills the remainder. The head never moves.
    const chain = appliedFallback
      ? dedupeById([ordered[0], ...this.resolveFallbackChain(routingConfig.fallback, excluded), ...ordered])
      : [ordered[0]];
    const head = chain[0];

    const reason = pinned
      ? `explicit ${head.model.id}${appliedFallback ? " (fallback policy enabled)" : ""}`
      : `${policy} → ${head.model.id} (${head.reason})`;

    return this.buildResolved(head, chain, reason);
  }

  /**
   * Resolve the configured fallback references, in order, skipping any that do
   * not resolve (an invalid fallback entry must not break routing).
   */
  private resolveFallbackChain(references: string[], excluded: Set<string>): Candidate[] {
    const chain: Candidate[] = [];
    for (const reference of references) {
      try {
        const candidate = this.resolvePinned({ model: reference }, excluded);
        if (candidate) chain.push(candidate);
      } catch {
        // Unresolvable fallback entries are advisory; routing continues.
      }
    }
    return chain;
  }

  /** Ordered candidate chain without throwing when only the head is needed. */
  candidateChain(request: RoutingRequest = {}): ModelDefinition[] {
    try {
      return this.resolve(request).candidates;
    } catch {
      return [];
    }
  }

  // ── Pinned (explicit) resolution ──────────────────────────────────────────

  private resolvePinned(request: RoutingRequest, excluded: Set<string>): Candidate | null {
    if (!request.model) return null;

    const ref: ModelRef = parseModelRef(request.model, {
      knownProviders: this.registry.ids(),
      defaultProvider: request.provider ?? this.activeProviderId() ?? undefined,
    });

    // Case A — the model id is exactly a registered model (qualified or not).
    const direct = this.catalog.get(ref.providerId ? `${ref.providerId}/${ref.modelId}` : ref.modelId);
    if (direct) {
      const provider = this.registry.get(direct.providerId);
      if (!provider) throw new ProviderNotFoundError(direct.providerId);
      if (excluded.has(provider.id)) {
        throw new ModelRoutingError(`Provider '${provider.id}' is excluded from routing.`, {
          provider: provider.id,
          model: direct.id,
        });
      }
      return this.describe({ provider, model: direct }, "explicit request");
    }

    // Case B — unqualified: match by provider-native id.
    if (!ref.providerId) {
      const matches = this.catalog.filter((entry) => entry.apiModelId === ref.modelId);
      if (matches.length === 1) {
        const provider = this.registry.get(matches[0].providerId);
        if (provider && !excluded.has(provider.id)) {
          return this.describe({ provider, model: matches[0] }, "explicit request");
        }
      }
      if (request.provider) {
        const provider = this.registry.get(request.provider);
        if (!provider) throw new ProviderNotFoundError(request.provider);
        throw new ModelRoutingError(
          `Model '${request.model}' is not available from provider '${provider.id}'.`,
          { provider: provider.id, model: request.model },
        );
      }
      if (matches.length > 1) {
        throw new ModelRoutingError(
          `Model '${request.model}' is ambiguous across providers: ${matches.map((m) => m.providerId).join(", ")}.`,
          { model: request.model },
        );
      }
      throw new ModelRoutingError(`Unknown model '${request.model}'.`, { model: request.model });
    }

    // Case C — qualified but unknown model: distinguish "no such provider".
    const provider = this.registry.get(ref.providerId);
    if (!provider) throw new ProviderNotFoundError(ref.providerId);
    throw new ModelRoutingError(`Model '${ref.providerId}/${ref.modelId}' is not registered.`, {
      provider: provider.id,
      model: `${ref.providerId}/${ref.modelId}`,
    });
  }

  // ── Candidate ranking ─────────────────────────────────────────────────────

  private rankCandidates(request: RoutingRequest, policy: RoutingPolicy, excluded: Set<string>): Candidate[] {
    const providers = new Map<string, ProviderDefinition>();
    for (const provider of this.registry.list()) {
      if (!provider.enabled || provider.status === "disabled") continue;
      if (excluded.has(provider.id)) continue;
      // An explicit provider request overrides health-based skips.
      providers.set(provider.id, provider);
    }

    let pool: Candidate[] = [];
    for (const provider of providers.values()) {
      if (request.provider && provider.id !== request.provider.toLowerCase()) continue;
      for (const model of this.catalog.listByProvider(provider.id)) {
        if (model.status === "disabled") continue;
        if (!satisfiesCapabilities(model.capabilities, request.requiredCapabilities)) continue;
        if (!this.withinCostLimit(model, request.costLimit)) continue;
        pool.push({
          provider,
          model,
          rank: 0,
          reason: `${provider.id} priority=${provider.priority} health=${this.registry.healthOf(provider.id).state}`,
        });
      }
    }

    if (request.provider && !providers.has(request.provider.toLowerCase())) {
      const provider = this.registry.get(request.provider);
      if (!provider) throw new ProviderNotFoundError(request.provider);
      if (provider.status === "disabled") {
        throw new ProviderUnavailableError(provider.id, `Provider '${provider.id}' is disabled.`);
      }
    }

    // Provider health filtering: healthy/unknown providers are preferred, but a
    // provider is only dropped entirely when the pool would otherwise be empty
    // (so an explicit capability requirement can still be satisfied).
    const healthyPool = pool.filter((c) => this.registry.healthOf(c.provider.id).state !== "unavailable");
    if (healthyPool.length > 0) pool = healthyPool;

    pool.sort((a, b) => this.compare(a, b, policy, request));
    return pool.map((candidate) => this.finalize(candidate, policy, request));
  }

  private compare(a: Candidate, b: Candidate, policy: RoutingPolicy, request: RoutingRequest): number {
    const priorities = request.preferredCapabilities;

    switch (policy) {
      case "cheapest": {
        const priceA = blendedPrice(a.model);
        const priceB = blendedPrice(b.model);
        // Unknown prices sort last — never treat "unknown" as free.
        if (priceA === undefined && priceB !== undefined) return 1;
        if (priceB === undefined && priceA !== undefined) return -1;
        if (priceA !== undefined && priceB !== undefined && priceA !== priceB) return priceA - priceB;
        break;
      }
      case "fastest": {
        const latA = this.registry.healthOf(a.provider.id).latencyMs;
        const latB = this.registry.healthOf(b.provider.id).latencyMs;
        if (latA === undefined && latB !== undefined) return 1;
        if (latB === undefined && latA !== undefined) return -1;
        if (latA !== undefined && latB !== undefined && latA !== latB) return latA - latB;
        break;
      }
      case "capability-first": {
        const scoreA = preferredScore(a.model, priorities);
        const scoreB = preferredScore(b.model, priorities);
        if (scoreA !== scoreB) return scoreB - scoreA;
        break;
      }
      case "priority":
      case "fallback":
      case "explicit":
      default:
        break;
    }

    // Common tie-breakers: health, then declared priority, then stable id.
    const healthDelta = healthRank(this.registry.healthOf(a.provider.id).state) -
      healthRank(this.registry.healthOf(b.provider.id).state);
    if (healthDelta !== 0) return healthDelta;
    if (a.provider.priority !== b.provider.priority) return a.provider.priority - b.provider.priority;
    return a.model.id.localeCompare(b.model.id);
  }

  private finalize(candidate: Candidate, policy: RoutingPolicy, request: RoutingRequest): Candidate {
    const preferred = preferredScore(candidate.model, request.preferredCapabilities);
    return {
      ...candidate,
      rank: preferred,
      reason: `selected by '${policy}' across '${candidate.provider.id}'`,
    };
  }

  private describe(pair: { provider: ProviderDefinition; model: ModelDefinition }, reason: string): Candidate {
    return { ...pair, rank: 0, reason };
  }

  private withinCostLimit(model: ModelDefinition, costLimit: number | undefined): boolean {
    if (costLimit === undefined) return true;
    const price = blendedPrice(model);
    // An unknown price cannot be proven to exceed the limit, so it is kept.
    if (price === undefined) return true;
    return price <= costLimit;
  }

  // ── Output ────────────────────────────────────────────────────────────────

  private buildResolved(head: Candidate, chain: Candidate[], reason: string): ResolvedModel {
    return {
      provider: head.provider,
      model: head.model,
      capabilities: head.model.capabilities,
      routingReason: reason,
      candidates: dedupeById(chain).map((candidate) => candidate.model),
    };
  }
}

function dedupeById(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.model.id)) continue;
    seen.add(candidate.model.id);
    out.push(candidate);
  }
  return out;
}

function preferredScore(model: ModelDefinition, preferred: RoutingRequest["preferredCapabilities"]): number {
  if (!preferred) return 0;
  let score = 0;
  for (const [key, value] of Object.entries(preferred)) {
    if (value === true && model.capabilities[key as keyof typeof model.capabilities] === true) score += 1;
  }
  return score;
}

function activeProviderId(): string | null {
  try {
    return getActiveProviderConfig()?.id ?? null;
  } catch {
    return null;
  }
}

// ── Fallback execution ──────────────────────────────────────────────────────

export interface AttemptRecord {
  modelId: string;
  providerId: string;
  ok: boolean;
  error?: string;
  retryable?: boolean;
  durationMs: number;
}

export interface FallbackOptions {
  maxAttempts?: number;
  /** Extra terminal predicate evaluated before the built-in classifier. */
  isTerminal?: (error: unknown) => boolean;
  onAttempt?: (record: AttemptRecord) => void;
  /** Injectable for tests — defaults to the process-wide registry/router. */
  registry?: ProviderRegistry;
  router?: ModelRouter;
}

export interface FallbackResult<T> {
  result: T;
  resolved: ResolvedModel;
  attempts: AttemptRecord[];
}

/**
 * Invoke `run` against the resolved model, falling back through the candidate
 * chain ONLY on retryable failures.
 */
export async function invokeWithFallback<T>(
  request: RoutingRequest,
  run: (resolved: ResolvedModel) => Promise<T>,
  options: FallbackOptions = {},
): Promise<FallbackResult<T>> {
  const registry = options.registry ?? providerRegistry;
  const router = options.router ?? new ModelRouter({ registry });
  const resolved = router.resolve(request);

  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? routingConfig.maxAttempts, resolved.candidates.length));
  const attempts: AttemptRecord[] = [];
  let lastError: unknown;

  for (let index = 0; index < maxAttempts; index++) {
    if (request.signal?.aborted) {
      throw new ModelRoutingError("Routing cancelled by caller.", { retryable: false });
    }

    const model = resolved.candidates[index];
    const providerId = model.providerId;
    const singleResolved: ResolvedModel = {
      ...resolved,
      provider: registry.get(providerId) ?? resolved.provider,
      model,
      capabilities: model.capabilities,
    };

    const startedAt = Date.now();
    try {
      const result = await run(singleResolved);
      const durationMs = Date.now() - startedAt;
      registry.recordSuccess(providerId, durationMs);
      const record: AttemptRecord = { modelId: model.id, providerId, ok: true, durationMs };
      attempts.push(record);
      options.onAttempt?.(record);
      return { result, resolved: singleResolved, attempts };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const retryable = !(options.isTerminal?.(error) ?? false) && isRetryableFailure(error);
      const record: AttemptRecord = {
        modelId: model.id,
        providerId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryable,
        durationMs,
      };
      attempts.push(record);
      options.onAttempt?.(record);

      if (retryable) registry.recordFailure(providerId, record.error);

      // Terminal: rethrow immediately, no fallback.
      if (!retryable) throw error;
      lastError = error;
    }
  }

  throw lastError ?? new ModelRoutingError("All routing attempts failed.", { retryable: false });
}

/** Aliases kept for readability at call sites. */
export const invokeModel = invokeWithFallback;

/**
 * Whether a failure may be retried on another model/provider.
 * Explicitly NOT retryable: auth, invalid request, permission denial,
 * cancellation, malformed schema, and anything a caller marks terminal.
 */
export function isRetryableFailure(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable;

  if (error instanceof Error) {
    if (error.name === "AbortError") return false;
    const message = error.message ?? "";
    if (/abort|cancel/i.test(message)) return false;
    if (/permission|denied|not allowed|forbidden/i.test(message)) return false;
    if (/invalid (request|tool|schema|argument)/i.test(message)) return false;
    if (/authenticat|unauthoriz/i.test(message)) return false;

    const status = /HTTP\s+(\d{3})/.exec(message)?.[1];
    if (status) {
      if (status === "429") return true;
      if (/^5\d\d$/.test(status)) return true;
      return false; // 4xx other than 429 is terminal.
    }

    if (/rate.?limit|too many requests|overloaded|temporarily unavailable/i.test(message)) return true;
    if (/timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket hang up|fetch failed|network/i.test(message)) {
      return true;
    }
  }
  return false;
}

/** Process-wide canonical router. */
export const modelRouter = new ModelRouter();
