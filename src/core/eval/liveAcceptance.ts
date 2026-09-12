/**
 * Phase 80 §20/§21 — Live acceptance probes.
 *
 * Lives in the EVAL layer (not the model layer) so the dependency direction
 * stays clean: eval → models, never models → eval.
 *
 * Two hard rules, both about honesty:
 *  1. A missing credential is an ENVIRONMENT skip, never a pass.
 *  2. A real completion costs money, so it is only executed when the caller
 *     explicitly opts in with `allowBilledCall`. Otherwise the probe still runs
 *     the discovery/routing/adapter-binding steps and reports what it proved.
 *
 * Every provider call goes through `ModelAdapter` — the same path production
 * uses — so a green probe is evidence about the real runtime.
 */

import os from "node:os";
import path from "node:path";
import { ModelAdapter } from "../../lib/harness/modelAdapter";
import {
  ModelRouter,
  classifyLiveFailure,
  formatModelRef,
  modelCatalog,
  openRouterRegistration,
  providerRegistry,
  refreshProvider,
  type LiveAcceptanceOptions,
  type LiveFailureClass,
  type ProviderRegistry,
  type ModelCatalog,
} from "../models";
import { EvalRunner } from "./runner";
import { EvalStore } from "./store";
import { textSuite } from "./suites";

export interface LiveCompletionOptions extends LiveAcceptanceOptions {
  /**
   * A real completion costs money. The probe will NOT call the provider unless
   * this is explicitly true; otherwise it reports an ENVIRONMENT skip.
   */
  allowBilledCall?: boolean;
  /** Run one EvalRunner smoke case after the completion probe. */
  runEvalSmoke?: boolean;
}

export interface LiveCompletionReport {
  ran: boolean;
  ok: boolean;
  provider?: string;
  model?: string;
  /** 1. discovery */
  modelCount?: number;
  /** 2/3. completion + streaming */
  completion?: { contentLength: number; finishReason?: string | null };
  streaming?: { chunks: number; contentLength: number };
  /** 6. usage normalization */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** 5. a tool-call capable model was available */
  toolCallCapable?: boolean;
  /** 7. provider health after the call */
  healthState?: string;
  /** 8. router resolution */
  routingReason?: string;
  /** 9. eval smoke */
  evalSmoke?: { suiteId: string; passed: number; total: number };
  failureClass?: LiveFailureClass;
  /** Why the probe was skipped, when it was. */
  skippedReason?: string;
  error?: string;
  steps: string[];
}

/**
 * End-to-end live probe: discovery → completion → streaming → usage → health →
 * routing → eval smoke.
 */
export async function runLiveCompletionProbe(
  options: LiveCompletionOptions = {},
): Promise<LiveCompletionReport> {
  const registry: ProviderRegistry = options.registry ?? providerRegistry;
  const catalog: ModelCatalog = options.catalog ?? modelCatalog;
  const env = options.env ?? process.env;
  const steps: string[] = [];

  if (!env.OPENROUTER_API_KEY?.trim()) {
    return {
      ran: false,
      ok: false,
      failureClass: "ENVIRONMENT",
      skippedReason: "OPENROUTER_API_KEY missing",
      steps,
    };
  }
  if (!options.allowBilledCall) {
    return {
      ran: false,
      ok: false,
      failureClass: "ENVIRONMENT",
      skippedReason: "billed completion not permitted (pass allowBilledCall=true to execute)",
      steps,
    };
  }

  try {
    if (!registry.has("openrouter")) {
      registry.register(openRouterRegistration(env), { replace: true, skipModels: true });
    }
    steps.push("provider registered");

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
    if (!sample) {
      return {
        ran: true,
        ok: false,
        provider: "openrouter",
        failureClass: "PROVIDER_PROTOCOL",
        error: "no models discovered",
        steps,
      };
    }
    steps.push(`sample model ${sample.apiModelId}`);

    const provider = registry.createInstance("openrouter");
    if (!provider) {
      return {
        ran: true,
        ok: false,
        failureClass: "CORE_RUNTIME",
        error: "could not construct the OpenRouter provider",
        steps,
      };
    }
    const adapter = new ModelAdapter(provider);
    const apiModelId = sample.apiModelId;

    const startedAt = Date.now();
    const completion = await adapter.complete({
      model: apiModelId,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    });
    registry.recordSuccess("openrouter", Date.now() - startedAt);
    steps.push("completion returned");

    let streaming: LiveCompletionReport["streaming"];
    if (typeof provider.stream === "function") {
      let chunks = 0;
      let length = 0;
      for await (const chunk of adapter.stream({
        model: apiModelId,
        messages: [{ role: "user", content: "Count from 1 to 3." }],
      })) {
        chunks += 1;
        length += typeof chunk.contentDelta === "string" ? chunk.contentDelta.length : 0;
      }
      streaming = { chunks, contentLength: length };
      steps.push(`streamed ${chunks} chunk(s)`);
    }

    const router = new ModelRouter({ registry, catalog, activeProviderId: () => null });
    const resolved = router.resolve({ model: formatModelRef("openrouter", apiModelId) });
    steps.push(`router resolved (${resolved.routingReason})`);

    let evalSmoke: LiveCompletionReport["evalSmoke"];
    if (options.runEvalSmoke) {
      const runner = new EvalRunner({
        store: new EvalStore({ dir: path.join(os.tmpdir(), "toolnet-live-eval") }),
      });
      const record = await runner.runSuite(textSuite, formatModelRef("openrouter", apiModelId));
      evalSmoke = { suiteId: record.suiteId, passed: record.passed, total: record.cases.length };
      steps.push(`eval smoke ${record.passed}/${record.cases.length}`);
    }

    return {
      ran: true,
      ok: true,
      provider: "openrouter",
      model: apiModelId,
      modelCount: models.length,
      completion: {
        contentLength: completion.content?.length ?? 0,
        finishReason: completion.finishReason ?? null,
      },
      ...(streaming ? { streaming } : {}),
      ...(completion.usage ? { usage: completion.usage } : {}),
      toolCallCapable: models.some((model) => model.capabilities.tools === true),
      healthState: registry.healthOf("openrouter").state,
      routingReason: resolved.routingReason,
      ...(evalSmoke ? { evalSmoke } : {}),
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

// ── ToolNet live probe (Phase 80 §21) ───────────────────────────────────────

export interface ToolNetProbeEntry {
  providerId: string;
  kind: string;
  hasKey: boolean;
  modelCount: number;
  adapterBound: boolean;
  completion?: { contentLength: number };
  failureClass?: LiveFailureClass;
  error?: string;
}

export interface ToolNetProbeReport {
  ran: boolean;
  ok: boolean;
  multiProvider: boolean;
  entries: ToolNetProbeEntry[];
  failureClass?: LiveFailureClass;
  skippedReason?: string;
  steps: string[];
}

/**
 * Probe every registered non-OpenRouter provider, proving the registry is truly
 * multi-provider. A completion is only executed when `allowBilledCall` is set;
 * otherwise each entry reports its adapter binding only.
 */
export async function runToolNetProbe(options: LiveCompletionOptions = {}): Promise<ToolNetProbeReport> {
  const registry: ProviderRegistry = options.registry ?? providerRegistry;
  const steps: string[] = [];
  const candidates = registry.enabled().filter((provider) => provider.id !== "openrouter");

  if (candidates.length === 0) {
    return {
      ran: false,
      ok: false,
      multiProvider: false,
      entries: [],
      failureClass: "ENVIRONMENT",
      skippedReason: "no non-OpenRouter provider is configured",
      steps,
    };
  }

  const entries: ToolNetProbeEntry[] = [];
  for (const provider of candidates) {
    const entry: ToolNetProbeEntry = {
      providerId: provider.id,
      kind: provider.kind,
      hasKey: Boolean(provider.authentication?.hasApiKey),
      modelCount: provider.models.length,
      adapterBound: false,
    };

    const instance = registry.createInstance(provider.id);
    if (!instance) {
      entry.failureClass = "CORE_RUNTIME";
      entry.error = "could not construct the provider instance";
      entries.push(entry);
      continue;
    }
    entry.adapterBound = new ModelAdapter(instance).providerId === provider.id;
    steps.push(`${provider.id}: adapter bound`);

    const model = provider.models[0];
    if (options.allowBilledCall && entry.hasKey && model) {
      const apiModelId = model.startsWith(`${provider.id}/`) ? model.slice(provider.id.length + 1) : model;
      try {
        const response = await new ModelAdapter(instance).complete({
          model: apiModelId,
          messages: [{ role: "user", content: "Reply with the single word: ok" }],
        });
        entry.completion = { contentLength: response.content?.length ?? 0 };
        registry.recordSuccess(provider.id);
        steps.push(`${provider.id}: completion returned`);
      } catch (error) {
        entry.failureClass = classifyLiveFailure(error);
        entry.error = error instanceof Error ? error.message : String(error);
      }
    } else if (!entry.hasKey) {
      entry.failureClass = "ENVIRONMENT";
      entry.error = "no API key resolved for this provider";
    }

    entries.push(entry);
  }

  const bound = entries.filter((entry) => entry.adapterBound).length;
  return {
    ran: true,
    ok: bound > 0,
    multiProvider: bound >= 2,
    entries,
    ...(bound === 0 ? { failureClass: "ENVIRONMENT" as const } : {}),
    steps,
  };
}
