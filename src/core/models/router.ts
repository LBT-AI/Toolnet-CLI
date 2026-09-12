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
import { ProviderError, ModelRoutingError, ModelCapabilityError, ProviderNotFoundError, ProviderUnavailableError } from "./errors";
import { healthRank } from "./health";
import { missingCapabilities } from "./capabilities";
import { parseModelRef } from "./ref";
import { providerRegistry, ProviderRegistry } from "./registry";
import type { ModelDefinition, ModelRef, ProviderDefinition, ProviderHealth, ResolvedModel, RoutingPolicy, RoutingRequest } from "./types";
import { blendedPrice, satisfiesCapabilities } from "./types";
import { indexProfiles, type ModelPerformanceProfile } from "./performance";
import { routeFromModel, routeLabel, type ProviderRoute, type RouteRejection } from "./route";
import type { ProviderRoutingPolicy } from "./providerPolicy";
import { resolveProviderRoutes, type RouteRelaxation, type RouteResolutionRequest } from "./routeResolver";
import { classifyProviderFailure } from "./failureKind";
import { routePerformance, type RoutePerformanceTracker } from "./routePerformance";
import type { RouteScore } from "./routeScoring";
import {
  DEFAULT_ROUTING_PROFILE,
  resolveRoutingProfile,
  type RoutingProfileDefinition,
  type RoutingProfileName,
} from "./profiles";
import { latencyScore, scoreModel } from "./scoring";

export interface RoutingConfig {
  policy: RoutingPolicy;
  /** Phase 80 — default routing profile when a request names none. */
  profile: RoutingProfileName;
  /** Ordered fallback references appended after the head candidate. */
  fallback: string[];
  /** Attempts per routing decision, including the head. */
  maxAttempts: number;
  /** Providers never considered unless explicitly named. */
  excludedProviders: string[];
  /** Phase 82 — provider/upstream ordering policy. */
  providerPolicy: string;
  /** Phase 82 — whether a retryable failure may try the next route. */
  allowProviderFallback: boolean;
}

let routingConfig: RoutingConfig = {
  policy: "priority",
  profile: DEFAULT_ROUTING_PROFILE,
  fallback: [],
  maxAttempts: 3,
  excludedProviders: [],
  providerPolicy: "priority",
  allowProviderFallback: true,
};

export function setRoutingConfig(patch: Partial<RoutingConfig>): RoutingConfig {
  routingConfig = { ...routingConfig, ...patch };
  return { ...routingConfig };
}

export function getRoutingConfig(): RoutingConfig {
  return { ...routingConfig };
}

export function resetRoutingConfig(): void {
  routingConfig = {
    policy: "priority",
    profile: DEFAULT_ROUTING_PROFILE,
    fallback: [],
    maxAttempts: 3,
    excludedProviders: [],
    providerPolicy: "priority",
    allowProviderFallback: true,
  };
}

/**
 * Phase 82 §10 — provider-level decision evidence.
 *
 * Produced without any provider call, health mutation or billing, so `explain`
 * and `simulate` are safe to run at any time.
 */
export interface RoutingDecision {
  request: RoutingRequest;
  /** Phase 80 model-selection profile. */
  profile: string;
  /** Phase 79/80 model-selection policy. */
  modelPolicy: RoutingPolicy;
  /** Phase 82 provider/upstream policy. */
  providerPolicy: ProviderRoutingPolicy;
  selectedRoute?: ProviderRoute;
  /** Ordered the way fallback would walk them. */
  candidateRoutes: ProviderRoute[];
  scores: RouteScore[];
  rejected: RouteRejection[];
  relaxed: RouteRelaxation[];
  /** The bounded chain that would actually be attempted. */
  fallbackChain: ProviderRoute[];
  /** Human-readable, secret-free evidence. */
  reasons: string[];
  /** Provider-independent model identity, when one model was requested. */
  logicalKey?: string;
}

interface Candidate {
  provider: ProviderDefinition;
  model: ModelDefinition;
  rank: number;
  reason: string;
  /** Phase 80 — scorer total when a scoring profile ranked this candidate. */
  score?: number;
}

export interface RouterOptions {
  registry?: ProviderRegistry;
  catalog?: ModelCatalog;
  /** Active-provider lookup used to qualify bare references. Injectable so
   *  routing decisions are reproducible in tests. */
  activeProviderId?: () => string | null;
  /**
   * Phase 80 — OPTIONAL eval evidence. When absent (the default), routing works
   * purely from capability/health/metadata; the eval component scores NEUTRAL.
   * Never a hard dependency, so a fresh install routes the same as before.
   */
  performance?: () => ModelPerformanceProfile[] | Map<string, ModelPerformanceProfile>;
  /** Phase 82 — injectable per-route performance tracker (defaults to the singleton). */
  routePerformance?: RoutePerformanceTracker;
}

export class ModelRouter {
  private readonly registry: ProviderRegistry;
  private readonly catalog: ModelCatalog;
  private readonly activeProviderId: () => string | null;
  private readonly performanceSource?: () => ModelPerformanceProfile[] | Map<string, ModelPerformanceProfile>;
  private readonly routePerf: RoutePerformanceTracker;

  constructor(options: RouterOptions = {}) {
    this.registry = options.registry ?? providerRegistry;
    this.catalog = options.catalog ?? modelCatalog;
    this.activeProviderId = options.activeProviderId ?? activeProviderId;
    this.performanceSource = options.performance;
    this.routePerf = options.routePerformance ?? routePerformance;
  }

  // ── Resolution ────────────────────────────────────────────────────────────

  resolve(request: RoutingRequest = {}): ResolvedModel {
    if (request.signal?.aborted) {
      throw new ModelRoutingError("Routing cancelled by caller.", { retryable: false });
    }

    // Phase 80 — resolve the profile first; it supplies default policy, weights
    // and (optionally) required capabilities / context floor.
    const profile = resolveRoutingProfile(request.profile ?? routingConfig.profile);
    const policy: RoutingPolicy =
      request.policy ?? (profile.ranking === "score" ? profile.policy : routingConfig.policy);
    const excluded = new Set(
      [...routingConfig.excludedProviders, ...(request.excludedProviders ?? [])].map((id) => id.toLowerCase()),
    );

    const pinned = this.resolvePinned(request, excluded);

    // Explicit pin with provider fallback DISABLED: the chain is exactly that
    // model. When a configured fallback chain (or the `fallback` policy) is in
    // effect, the pin stays the head but the chain continues — otherwise an
    // explicitly requested model could never fall back, which is the whole point
    // of the feature.
    if (pinned && policy === "explicit" && !providerFallbackEnabled()) {
      return this.buildResolved(pinned, [pinned], `explicit ${pinned.model.id}`);
    }

    const candidates = this.rankCandidates(request, policy, excluded, profile);

    // Phase 82 §17 (defect hunt) — an explicit pin is a PIN, not a capability
    // waiver. If the requested model fails the request's required capabilities
    // (including the profile's), that is a hard error, not a silent downgrade
    // to a model that cannot do the job.
    if (pinned) {
      const required = { ...(profile.requiredCapabilities ?? {}), ...(request.requiredCapabilities ?? {}) };
      const missing = missingCapabilities(pinned.model.capabilities, required);
      if (missing.length > 0) {
        throw new ModelCapabilityError(pinned.model.id, missing, pinned.provider.id);
      }
    }

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
    const appliedFallback = providerFallbackEnabled(policy);
    // The configured fallback list is honoured in order, then the policy-ranked
    // pool fills the remainder. The head never moves.
    const chain = appliedFallback
      ? dedupeById([ordered[0], ...this.resolveFallbackChain(routingConfig.fallback, excluded), ...ordered])
      : [ordered[0]];
    const head = chain[0];

    const reason = pinned
      ? `explicit ${head.model.id}${appliedFallback ? " (fallback policy enabled)" : ""}`
      : `${profile.id}/${policy} → ${head.model.id} (${head.reason})`;

    return this.buildResolved(head, chain, reason, profile.id, head.score);
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
        // Phase 82 §1/§9 — one logical model served by several providers is the
        // SUPPORTED case, not an error: pick the best provider route with the
        // deterministic provider policy (health → priority → id) and let the
        // fallback chain keep the alternates reachable. Throwing here would
        // make the advertised multi-upstream routing unusable from the bare-id
        // path.
        const eligible: Array<{ model: ModelDefinition; provider: ProviderDefinition }> = [];
        for (const model of matches) {
          const provider = this.registry.get(model.providerId);
          if (!provider || excluded.has(provider.id)) continue;
          if (!provider.enabled || provider.status === "disabled") continue;
          eligible.push({ model, provider });
        }
        if (eligible.length > 0) {
          eligible.sort((a, b) => {
            const healthDelta = healthRank(this.registry.healthOf(a.provider.id).state) -
              healthRank(this.registry.healthOf(b.provider.id).state);
            if (healthDelta !== 0) return healthDelta;
            if (a.provider.priority !== b.provider.priority) return a.provider.priority - b.provider.priority;
            return a.provider.id.localeCompare(b.provider.id);
          });
          const [head, ...rest] = eligible;
          return this.describe({ provider: head.provider, model: head.model },
            `explicit request — best of ${eligible.length} serving providers`);
        }
        // All matching providers excluded/disabled: fall through to the
        // structured error below so the caller learns why nothing is usable.
      }
      if (matches.length === 1) {
        const provider = this.registry.get(matches[0].providerId);
        if (provider && !excluded.has(provider.id)) {
          return this.describe({ provider, model: matches[0] }, "explicit request");
        }
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

  private rankCandidates(
    request: RoutingRequest,
    policy: RoutingPolicy,
    excluded: Set<string>,
    profile: RoutingProfileDefinition,
  ): Candidate[] {
    // The profile may impose its own requirements (e.g. `coding` requires tools);
    // an explicit request requirement always wins on conflict.
    const required = { ...(profile.requiredCapabilities ?? {}), ...(request.requiredCapabilities ?? {}) };
    const minContext = request.minContextWindow ?? profile.minContextWindow;

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
        if (!satisfiesCapabilities(model.capabilities, required)) continue;
        if (!this.meetsContext(model, minContext)) continue;
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

    // A scoring profile ranks by the deterministic scorer UNLESS the caller
    // explicitly asked for a policy (cheapest/fastest/...), which wins.
    const useScore = profile.ranking === "score" && request.policy === undefined;
    if (useScore) {
      const performance = this.performanceIndex();
      const scores = new Map<string, number>();
      for (const candidate of pool) {
        scores.set(
          candidate.model.id,
          scoreModel({
            model: candidate.model,
            provider: candidate.provider,
            health: this.registry.healthOf(candidate.provider.id),
            profile,
            request,
            performance: performance?.get(candidate.model.id),
          }).total,
        );
      }
      pool.sort((a, b) => {
        const delta = (scores.get(b.model.id) ?? 0) - (scores.get(a.model.id) ?? 0);
        return delta !== 0 ? delta : this.tieBreak(a, b);
      });
      return pool.map((candidate) =>
        this.finalize(candidate, policy, request, profile, scores.get(candidate.model.id)),
      );
    }

    pool.sort((a, b) => this.compare(a, b, policy, request));
    return pool.map((candidate) => this.finalize(candidate, policy, request));
  }

  /** Merge the optional eval profiles into a lookup, once per resolve. */
  private performanceIndex(): Map<string, ModelPerformanceProfile> | undefined {
    const source = this.performanceSource?.();
    if (!source) return undefined;
    if (source instanceof Map) return source;
    return indexProfiles(source);
  }

  /** Unknown context is NOT proof of insufficiency, so it is kept. */
  private meetsContext(model: ModelDefinition, minContext: number | undefined): boolean {
    if (!minContext || minContext <= 0) return true;
    const context = model.contextWindow ?? model.limits?.contextWindow;
    if (typeof context !== "number" || !Number.isFinite(context)) return true;
    return context >= minContext;
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
    return this.tieBreak(a, b);
  }

  /** Deterministic, profile-independent tie-breakers. */
  private tieBreak(a: Candidate, b: Candidate): number {
    const healthDelta = healthRank(this.registry.healthOf(a.provider.id).state) -
      healthRank(this.registry.healthOf(b.provider.id).state);
    if (healthDelta !== 0) return healthDelta;
    if (a.provider.priority !== b.provider.priority) return a.provider.priority - b.provider.priority;
    return a.model.id.localeCompare(b.model.id);
  }

  private finalize(
    candidate: Candidate,
    policy: RoutingPolicy,
    request: RoutingRequest,
    profile?: RoutingProfileDefinition,
    score?: number,
  ): Candidate {
    const preferred = preferredScore(candidate.model, request.preferredCapabilities);
    const reason =
      profile && score !== undefined
        ? `scored ${score.toFixed(3)} by profile '${profile.id}'`
        : `selected by '${policy}' across '${candidate.provider.id}'`;
    return { ...candidate, rank: preferred, reason, ...(score !== undefined ? { score } : {}) };
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

  private buildResolved(
    head: Candidate,
    chain: Candidate[],
    reason: string,
    profile?: string,
    score?: number,
  ): ResolvedModel {
    const ordered = dedupeById(chain);
    // Phase 82 §1 — expose the same chain as provider routes so bounded fallback
    // and diagnostics operate on provider/upstream identity, not on model ids.
    const routes = ordered.map((candidate) =>
      routeFromModel(candidate.model, candidate.provider, this.registry.healthOf(candidate.provider.id)),
    );
    return {
      provider: head.provider,
      model: head.model,
      capabilities: head.model.capabilities,
      routingReason: reason,
      candidates: ordered.map((candidate) => candidate.model),
      ...(profile ? { profile } : {}),
      ...(score !== undefined ? { score } : {}),
      routes,
      ...(routes[0] ? { route: routes[0] } : {}),
    };
  }

  // ── Phase 82 §10 — routing explanation ────────────────────────────────────

  /**
   * Full decision evidence for one request, with NO provider call, no health
   * mutation and no billing. This is what `toolnet routing explain/simulate`
   * and the TUI consume, so diagnostics can never diverge from the real
   * decision path.
   */
  explain(request: RoutingRequest = {}): RoutingDecision {
    const profile = resolveRoutingProfile(request.profile ?? routingConfig.profile);
    const policy: RoutingPolicy =
      request.policy ?? (profile.ranking === "score" ? profile.policy : routingConfig.policy);
    const excluded = [
      ...routingConfig.excludedProviders,
      ...(request.excludedProviders ?? []),
    ];

    // Phase 82 §3 — an explicit request policy governs the provider layer too:
    // `explain({ policy: "cheapest" })` must mean the same thing to model
    // selection and provider ordering. A provider-pinning policy like
    // `explicit`/`fallback` maps to the declared-priority route policy.
    const MODEL_ONLY_POLICIES: ReadonlySet<string> = new Set(["explicit", "fallback", "capability-first"]);
    const routePolicy = MODEL_ONLY_POLICIES.has(policy) ? this.providerPolicyName : policy;

    const routeRequest: RouteResolutionRequest = {
      model: request.model,
      provider: request.provider,
      requiredCapabilities: {
        ...(profile.requiredCapabilities ?? {}),
        ...(request.requiredCapabilities ?? {}),
      } as Record<string, boolean>,
      policy: routePolicy,
      constraints: {
        ...(request.providerConstraints ?? {}),
        allowFallback: request.providerConstraints?.allowFallback ?? routingConfig.allowProviderFallback,
      },
      excludedProviders: excluded,
    };

    const resolution = resolveProviderRoutes(routeRequest, {
      registry: this.registry,
      catalog: this.catalog,
      performance: this.performance,
    });

    // The model-selection layer (Phase 79/80) owns WHICH logical model; the
    // route policy owns which PROVIDER serves it (§16). When the request names
    // a model, the two layers agree on the pool, so the policy-ranked route
    // order wins and the resolved chain only contributes models the route
    // layer cannot see (e.g. models from an otherwise-disabled provider the
    // explicit pin legitimately reaches).
    let chain: ProviderRoute[] = resolution.routes;
    let modelReason = `${profile.id}/${policy}`;
    try {
      const resolved = this.resolve(request);
      modelReason = resolved.routingReason;
      const resolvedRoutes = resolved.routes ?? [];
      if (request.model) {
        // Pinned logical model: merge resolved-only routes INTO the policy
        // order, so the provider policy still decides provider ordering.
        const routeIds = new Set(resolution.routes.map((route) => route.routeId));
        const extras = resolvedRoutes.filter((route) => !routeIds.has(route.routeId));
        if (extras.length > 0) chain = dedupeRoutes([...resolution.routes, ...extras]);
      } else if (resolvedRoutes.length > 0) {
        // Discovery-style request: model-selection rank leads, route policy
        // orders providers within it.
        chain = dedupeRoutes([...resolvedRoutes, ...resolution.routes]);
      }
    } catch (error) {
      // A model-selection failure is reported as evidence, not thrown: explain
      // must always be able to say why nothing was selected.
      if (resolution.routes.length === 0) {
        return {
          request,
          profile: profile.id,
          modelPolicy: policy,
          providerPolicy: resolution.policy,
          candidateRoutes: [],
          scores: [],
          rejected: resolution.rejected,
          relaxed: resolution.relaxed,
          fallbackChain: [],
          reasons: [
            `model selection failed: ${error instanceof Error ? error.message : String(error)}`,
            ...resolution.rejected.map((entry) => `rejected ${routeLabelOf(entry)}: ${entry.reason} — ${entry.detail}`),
          ],
          ...(resolution.logicalKey ? { logicalKey: resolution.logicalKey } : {}),
        };
      }
    }

    // Phase 82 §7 — the chain can never contain a route the policy layer
    // rejected (allow/deny list, disabled, capability, context, price).
    // Without this filter the model-selection merge could re-introduce a
    // provider the route policy excluded, letting fallback bypass constraints.
    const rejectedRouteIds = new Set<string>();
    const rejectedProviderIds = new Set<string>();
    for (const entry of resolution.rejected) {
      rejectedRouteIds.add(entry.routeId);
      rejectedProviderIds.add(entry.providerId);
    }
    chain = chain.filter(
      (route) => !rejectedRouteIds.has(route.routeId) && !rejectedProviderIds.has(route.providerId),
    );

    const scoreByRoute = new Map(resolution.scores.map((score) => [score.routeId, score]));
    // The reported fallback chain mirrors what production `resolve()` would
    // attempt: head + configured fallback references, gated by the same
    // `providerFallbackEnabled()` predicate — never "every candidate".
    const fallbackChain = providerFallbackEnabled(policy)
      ? dedupeRoutes([chain[0], ...this.fallbackRefRoutes(chain[0]), ...chain.slice(1)].filter(Boolean))
      : chain.slice(0, 1);
    const reasons: string[] = [`model: ${modelReason}`];
    if (chain[0]) {
      reasons.push(`route: ${routeLabel(chain[0])}`);
      const score = scoreByRoute.get(chain[0].routeId);
      if (score) reasons.push(...score.reasons.map((reason) => `  ${reason}`));
    }
    for (const entry of resolution.rejected) {
      reasons.push(`rejected ${routeLabelOf(entry)}: ${entry.reason} — ${entry.detail}`);
    }
    for (const entry of resolution.relaxed) {
      reasons.push(`relaxed ${entry.constraint}: ${entry.detail}`);
    }

    return {
      request,
      profile: profile.id,
      modelPolicy: policy,
      providerPolicy: resolution.policy,
      ...(chain[0] ? { selectedRoute: chain[0] } : {}),
      candidateRoutes: chain,
      scores: resolution.scores,
      rejected: resolution.rejected,
      relaxed: resolution.relaxed,
      fallbackChain,
      reasons,
      ...(resolution.logicalKey ? { logicalKey: resolution.logicalKey } : {}),
    };
  }

  /** Provider routing policy currently in effect (Phase 82). */
  private get providerPolicyName(): string {
    return routingConfig.providerPolicy;
  }

  /**
   * Resolve the configured fallback references to concrete routes, in order,
   * for decision evidence. Unresolvable entries are skipped (advisory, same
   * as `resolveFallbackChain`), and no health/performance state is mutated.
   */
  private fallbackRefRoutes(head: ProviderRoute | undefined): ProviderRoute[] {
    if (routingConfig.fallback.length === 0) return [];
    const seen = new Set(head ? [head.routeId] : []);
    const routes: ProviderRoute[] = [];
    for (const reference of routingConfig.fallback) {
      try {
        const candidate = this.resolvePinned({ model: reference }, new Set());
        if (!candidate) continue;
        const health = this.registry.healthOf(candidate.provider.id);
        const route = routeFromModel(candidate.model, candidate.provider, health);
        if (!seen.has(route.routeId)) {
          seen.add(route.routeId);
          routes.push(route);
        }
      } catch {
        // Unresolvable fallback entries are advisory; evidence continues.
      }
    }
    return routes;
  }

  private get performance(): RoutePerformanceTracker {
    return this.routePerf;
  }
}

/**
 * Phase 82 §7 — is provider/upstream fallback enabled for this decision?
 *
 * `allowProviderFallback: false` is an absolute veto: it pins the decision to a
 * single route even when a configured chain exists.
 */
function providerFallbackEnabled(policy?: RoutingPolicy): boolean {
  if (!routingConfig.allowProviderFallback) return false;
  return policy === "fallback" || routingConfig.policy === "fallback" || routingConfig.fallback.length > 0;
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

/**
 * Phase 80 §5 — observed provider speed. `sufficient: false` means there are
 * not enough successful samples to judge, so `fastest` routing must fall back to
 * health/priority rather than inventing a latency.
 */
export function providerSpeed(
  registry: ProviderRegistry,
  providerId: string,
): { sufficient: boolean; latencyMs?: number; samples: number } {
  const health: ProviderHealth = registry.healthOf(providerId);
  const latency = latencyScore(health);
  return {
    sufficient: latency.sufficient,
    latencyMs: latency.sufficient ? health.latencyMs : undefined,
    samples: health.successCount,
  };
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
  /** Phase 82 — the provider route that was attempted. */
  routeId?: string;
  ok: boolean;
  error?: string;
  retryable?: boolean;
  /** Phase 82 — normalized failure classification. */
  failureKind?: string;
  /** Rolling TTFT observation for streaming attempts. */
  ttftMs?: number;
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

  // Phase 82 §7 — ONE executor. `invokeWithFallback` is the request-level
  // convenience wrapper over the route-aware chain below; there is no second
  // fallback implementation anywhere in the codebase.
  const routes = resolved.routes ?? [];
  if (routes.length === 0) {
    throw new ModelRoutingError("Routing produced no candidate route.", {
      model: request.model,
      retryable: false,
    });
  }

  const chain = await invokeRouteChain(
    routes,
    async (route) => run(withRoute(resolved, route, registry)),
    {
      registry,
      maxAttempts: options.maxAttempts ?? routingConfig.maxAttempts,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(options.onAttempt ? { onAttempt: options.onAttempt } : {}),
      ...(options.isTerminal ? { isTerminal: options.isTerminal } : {}),
    },
  );

  return {
    result: chain.result,
    resolved: withRoute(resolved, chain.route, registry),
    attempts: chain.attempts,
  };
}

/** Re-point a resolved model at one concrete route, keeping the chain intact. */
function withRoute(
  resolved: ResolvedModel,
  route: ProviderRoute,
  registry: ProviderRegistry,
): ResolvedModel {
  const model = resolved.candidates.find((candidate) => candidate.id === route.modelId);
  return {
    ...resolved,
    provider: registry.get(route.providerId) ?? resolved.provider,
    model: model ?? resolved.model,
    capabilities: model?.capabilities ?? resolved.model.capabilities,
    route,
  };
}

/**
 * Phase 82 §7 — bounded, route-aware fallback execution.
 *
 * Contract:
 *  - each route is attempted AT MOST ONCE per invocation;
 *  - only RETRYABLE failures advance the chain (timeout, 429, 5xx, network,
 *    unavailable) — auth, malformed request, permission denial and
 *    cancellation are terminal and rethrown immediately;
 *  - the caller's AbortSignal is checked before every attempt AND passed to
 *    `run`, so a cancellation mid-chain stops at the next boundary;
 *  - health and route performance are recorded from real outcomes only, and a
 *    caller-fault failure never degrades the provider.
 */
export async function invokeRouteChain<T>(
  routes: ProviderRoute[],
  run: (route: ProviderRoute) => Promise<T>,
  options: RouteChainOptions = {},
): Promise<RouteChainResult<T>> {
  const registry = options.registry ?? providerRegistry;
  const performance = options.performance ?? routePerformance;
  const signal = options.signal;
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? routingConfig.maxAttempts, routes.length));
  const attempts: AttemptRecord[] = [];
  let lastError: unknown;

  for (let index = 0; index < maxAttempts; index++) {
    if (signal?.aborted) {
      throw new ModelRoutingError("Routing cancelled by caller.", { retryable: false });
    }

    const route = routes[index];
    const startedAt = Date.now();
    try {
      const result = await run(route);
      const durationMs = Date.now() - startedAt;
      registry.recordSuccess(route.providerId, durationMs);
      performance.record(route.routeId, { ok: true, durationMs });
      const record: AttemptRecord = {
        modelId: route.modelId,
        providerId: route.providerId,
        routeId: route.routeId,
        ok: true,
        durationMs,
      };
      attempts.push(record);
      options.onAttempt?.(record);
      return { result, route, attempts };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const classification = classifyProviderFailure(error);
      const terminalByCaller = options.isTerminal?.(error) ?? false;
      const retryable = !terminalByCaller && classification.retryable;
      const message = classification.detail ?? (error instanceof Error ? error.message : String(error));
      const record: AttemptRecord = {
        modelId: route.modelId,
        providerId: route.providerId,
        routeId: route.routeId,
        ok: false,
        error: message,
        retryable,
        failureKind: classification.kind,
        durationMs,
      };
      attempts.push(record);
      options.onAttempt?.(record);

      // Real observed outcome. Health is moved only by provider-attributable
      // failures; a caller-fault failure (permission, cancellation, bad request,
      // schema) is recorded but can never degrade the provider. This is
      // independent of retryability — "do not retry this" is not "do not learn
      // from this".
      registry.recordOutcome(route.providerId, {
        ok: false,
        error,
        kind: classification.kind,
        affectsHealth: classification.affectsHealth,
      });
      performance.record(route.routeId, {
        ok: false,
        durationMs,
        failureKind: classification.kind,
        affectsHealth: classification.affectsHealth,
      });

      // Terminal: rethrow immediately, no fallback.
      if (!retryable) throw error;
      lastError = error;
    }
  }

  throw lastError ?? new ModelRoutingError("All routing attempts failed.", { retryable: false });
}

export interface RouteChainOptions {
  maxAttempts?: number;
  signal?: AbortSignal;
  /** Extra terminal predicate evaluated before the built-in classifier. */
  isTerminal?: (error: unknown) => boolean;
  onAttempt?: (record: AttemptRecord) => void;
  registry?: ProviderRegistry;
  performance?: RoutePerformanceTracker;
}

export interface RouteChainResult<T> {
  result: T;
  /** The route that succeeded. */
  route: ProviderRoute;
  attempts: AttemptRecord[];
}

export function dedupeRoutes(routes: ProviderRoute[]): ProviderRoute[] {
  const seen = new Set<string>();
  const out: ProviderRoute[] = [];
  for (const route of routes) {
    if (seen.has(route.routeId)) continue;
    seen.add(route.routeId);
    out.push(route);
  }
  return out;
}

/** Label for a rejection — the route id when a model was considered. */
function routeLabelOf(rejection: RouteRejection): string {
  return rejection.modelId ?? rejection.routeId;
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
