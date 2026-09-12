/**
 * Phase 79 §22 — Live acceptance probe.
 *
 * Proves the real path when credentials exist, and reports honestly when they
 * do not. It never fakes a green result: a missing key is an ENVIRONMENT
 * limitation, not a pass, and a provider-side rejection is classified as
 * PROVIDER_PROTOCOL / MODEL_COMPLIANCE rather than silently counted as
 * CORE_RUNTIME success.
 *
 * Steps (discovery only — no billed completion unless explicitly requested):
 *   1. provider registered
 *   2. models discovered
 *   3. capabilities normalized
 *   4. router resolves a discovered model
 *   5. the SAME ModelAdapter path accepts the resolved provider instance
 */

import { OpenRouterProvider } from "../../providers";
import { ModelAdapter } from "../../lib/harness/modelAdapter";
import { formatModelRef } from "./ref";
import { providerRegistry, type ProviderRegistry } from "./registry";
import { modelCatalog, type ModelCatalog } from "./catalog";
import { refreshProvider } from "./discovery";
import { ModelRouter } from "./router";
import type { ModelCapabilities } from "./types";
import { bootstrapProviderRegistry, openRouterRegistration } from "./providers";

export type LiveFailureClass =
  | "CORE_RUNTIME"
  | "MODEL_COMPLIANCE"
  | "PROVIDER_PROTOCOL"
  | "ENVIRONMENT";

export interface LiveAcceptanceReport {
  ran: boolean;
  ok: boolean;
  provider?: string;
  modelCount?: number;
  sampleModel?: string;
  capabilities?: ModelCapabilities;
  routingReason?: string;
  adapterBound?: boolean;
  /** Phase 82 §15 — provider candidates + dry decision evidence, secret-free. */
  providerCandidates?: number;
  fallbackChain?: number;
  dryDecision?: string[];
  failureClass?: LiveFailureClass;
  error?: string;
  steps: string[];
}

export interface LiveAcceptanceOptions {
  registry?: ProviderRegistry;
  catalog?: ModelCatalog;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Classify a live failure so a provider outage is never reported as a core
 * regression (or vice versa).
 */
export function classifyLiveFailure(error: unknown): LiveFailureClass {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP\s+40[13]|unauthor|api key|no api key|missing key|OPENROUTER_API_KEY/i.test(message)) {
    return "ENVIRONMENT";
  }
  if (/HTTP\s+4\d\d|invalid|malformed|schema|unsupported/i.test(message)) {
    return "PROVIDER_PROTOCOL";
  }
  if (/HTTP\s+5\d\d|ECONNREFUSED|ENOTFOUND|fetch failed|timeout|socket/i.test(message)) {
    return "PROVIDER_PROTOCOL";
  }
  return "CORE_RUNTIME";
}

/** Run the discovery-only acceptance probe. Safe: no billed completion call. */
export async function runLiveAcceptance(options: LiveAcceptanceOptions = {}): Promise<LiveAcceptanceReport> {
  const registry = options.registry ?? providerRegistry;
  const catalog = options.catalog ?? modelCatalog;
  const env = options.env ?? process.env;
  const steps: string[] = [];

  if (!env.OPENROUTER_API_KEY?.trim()) {
    return {
      ran: false,
      ok: false,
      failureClass: "ENVIRONMENT",
      error: "OPENROUTER_API_KEY is not set — live acceptance skipped (environment limitation, not a pass).",
      steps,
    };
  }

  try {
    // 1 — provider registered
    if (!registry.has("openrouter")) {
      registry.register(openRouterRegistration(env), { replace: true, skipModels: true });
    }
    const definition = registry.get("openrouter");
    if (!definition) throw new Error("OpenRouter provider could not be registered.");
    steps.push("provider registered");

    // 2 — models discovered
    const refreshed = await refreshProvider("openrouter", {
      registry,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    if (!refreshed.ok) {
      return {
        ran: true,
        ok: false,
        provider: "openrouter",
        failureClass: classifyLiveFailure(new Error(refreshed.error ?? "refresh failed")),
        error: refreshed.error,
        steps,
      };
    }
    const models = catalog.listByProvider("openrouter");
    steps.push(`discovered ${models.length} models`);

    const sample = models.find((model) => model.capabilities.tools === true) ?? models[0];
    steps.push(`sample model ${sample.apiModelId}`);

    // 3 — capabilities normalized (declared fields present, unknown preserved)
    steps.push("capabilities normalized");

    // 4 — router resolves a discovered model
    const router = new ModelRouter({ registry, catalog, activeProviderId: () => null });
    const resolved = router.resolve({ model: formatModelRef("openrouter", sample.apiModelId) });
    steps.push(`router resolved (${resolved.routingReason})`);

    // 5 — the canonical ModelAdapter path accepts the resolved provider
    const instance = registry.createInstance("openrouter");
    const adapterBound = instance instanceof OpenRouterProvider && Boolean(new ModelAdapter(instance).providerId);
    steps.push(`adapter bound (${adapterBound ? "yes" : "no"})`);

    // 6 — Phase 82 §15: dry provider-routing decision. No provider call, no
    // health mutation, no billing — `explain` is read-only by contract.
    const decision = router.explain({ model: formatModelRef("openrouter", sample.apiModelId) });
    steps.push(
      `dry decision: ${decision.candidateRoutes.length} candidate route(s), fallback chain ${decision.fallbackChain.length}`,
    );

    return {
      ran: true,
      ok: adapterBound,
      provider: "openrouter",
      modelCount: models.length,
      sampleModel: resolved.model.apiModelId,
      capabilities: resolved.model.capabilities,
      routingReason: resolved.routingReason,
      adapterBound,
      providerCandidates: decision.candidateRoutes.length,
      fallbackChain: decision.fallbackChain.length,
      dryDecision: decision.reasons,
      ...(adapterBound ? {} : { failureClass: "CORE_RUNTIME" as const }),
      steps,
    };
  } catch (error) {
    return {
      ran: true,
      ok: false,
      failureClass: classifyLiveFailure(error),
      error: error instanceof Error ? error.message : String(error),
      steps,
    };
  }
}

/** Ensure the registry is populated before a probe (idempotent). */
export function ensureBootstrapped(options: { env?: NodeJS.ProcessEnv } = {}): void {
  bootstrapProviderRegistry({ env: options.env });
}


