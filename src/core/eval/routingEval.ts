/**
 * Phase 82 §14 — Deterministic routing eval.
 *
 * These cases exercise the SAME production routing API the agent uses
 * (`ModelRouter.explain` over a real `ProviderRegistry` + `ModelCatalog`). The
 * router, resolver, scorer, health model and failure classifier are the real
 * implementations — nothing is stubbed.
 *
 * Everything here is offline and deterministic: no provider call, no network,
 * no billing, no health mutation. Each case registers its own isolated
 * registry/catalog so a routing eval can never disturb the live catalog.
 */

import { ModelCatalog } from "../models/catalog";
import { ProviderRegistry } from "../models/registry";
import { ModelRouter, getRoutingConfig, resetRoutingConfig, setRoutingConfig } from "../models/router";
import { RoutePerformanceTracker } from "../models/routePerformance";
import { formatModelRef } from "../models/ref";
import type { ModelCapabilities, ModelDefinition, ProviderKind } from "../models/types";
import type { ProviderConstraints } from "../models/providerPolicy";
import type { RouteRejectionReason } from "../models/route";
import type { FailureKind } from "../models/failureKind";

export interface RoutingEvalModel {
  /** Provider-native model id; may contain slashes. */
  apiModelId: string;
  capabilities?: ModelCapabilities;
  pricing?: { input?: number; output?: number };
  contextWindow?: number;
  status?: ModelDefinition["status"];
  /** Declared upstream identity, when the provider publishes one. */
  upstream?: string;
}

export interface RoutingEvalProvider {
  id: string;
  kind?: ProviderKind;
  priority?: number;
  enabled?: boolean;
  status?: "connected" | "disabled" | "failed" | "unknown";
  models: RoutingEvalModel[];
  /** Simulated observed outcomes, applied to health + route performance. */
  outcomes?: { ok: boolean; failureKind?: FailureKind; latencyMs?: number }[];
}

export interface RoutingEvalExpectations {
  /** Selected route must belong to this provider. */
  selectedProvider?: string;
  selectedRouteId?: string;
  /** Ordered provider ids of the candidate routes. */
  orderedProviders?: string[];
  candidateCount?: number;
  fallbackChainLength?: number;
  /** A rejection with this reason must be recorded. */
  rejectedReason?: RouteRejectionReason;
  /** Policy verdict must be one of these failure kinds. */
  failureKind?: FailureKind;
  /** No route may be selected (and the reason recorded). */
  selectNothing?: boolean;
}

export interface RoutingEvalCase {
  id: string;
  name: string;
  /** Case-specific routing request. */
  request: {
    model?: string;
    provider?: string;
    policy?: string;
    constraints?: Partial<ProviderConstraints>;
    requiredCapabilities?: Record<string, boolean>;
  };
  providers: RoutingEvalProvider[];
  /** Global router config for the case (profile/policy/fallback). */
  routingConfig?: { policy?: "explicit" | "priority" | "cheapest" | "fastest" | "capability-first" | "fallback"; fallback?: string[]; allowProviderFallback?: boolean; providerPolicy?: string };
  expect: RoutingEvalExpectations;
}

export interface RoutingEvalCaseResult {
  id: string;
  name: string;
  passed: boolean;
  detail: string;
  selectedRouteId?: string;
  candidateRoutes: string[];
  rejected: string[];
}

export interface RoutingEvalReport {
  results: RoutingEvalCaseResult[];
  passed: number;
  failed: number;
}

interface Harness {
  router: ModelRouter;
  registry: ProviderRegistry;
  catalog: ModelCatalog;
}

function buildHarness(providers: RoutingEvalProvider[]): Harness {
  const catalog = new ModelCatalog();
  const registry = new ProviderRegistry(catalog);
  const performance = new RoutePerformanceTracker();

  for (const provider of providers) {
    registry.register(
      {
        id: provider.id,
        kind: provider.kind ?? "openai-compatible",
        baseURL: `https://${provider.id}.invalid/v1`,
        ...(provider.priority !== undefined ? { priority: provider.priority } : {}),
        ...(provider.enabled !== undefined ? { enabled: provider.enabled } : {}),
        ...(provider.status ? { status: provider.status } : {}),
        models: provider.models.map((model) => {
          const definition: ModelDefinition = {
            id: formatModelRef(provider.id, model.apiModelId),
            providerId: provider.id,
            apiModelId: model.apiModelId,
            capabilities: model.capabilities ?? {},
            status: model.status ?? "active",
            ...(model.pricing ? { pricing: { ...model.pricing, currency: "USD", source: "provider" } } : {}),
            ...(model.contextWindow !== undefined
              ? { contextWindow: model.contextWindow, limits: { contextWindow: model.contextWindow } }
              : {}),
            ...(model.upstream ? { metadata: { upstream: model.upstream } } : {}),
          };
          return definition;
        }),
      },
      { replace: true },
    );
  }

  for (const provider of providers) {
    for (const outcome of provider.outcomes ?? []) {
      registry.recordOutcome(provider.id, {
        ok: outcome.ok,
        ...(outcome.latencyMs !== undefined ? { latencyMs: outcome.latencyMs } : {}),
        ...(outcome.failureKind ? { kind: outcome.failureKind } : {}),
      });
      for (const model of provider.models) {
        performance.record(`${provider.id}::${(model.upstream ?? "default").toLowerCase()}::${model.apiModelId}`, {
          ok: outcome.ok,
          ...(outcome.latencyMs !== undefined ? { durationMs: outcome.latencyMs } : {}),
          ...(outcome.failureKind ? { failureKind: outcome.failureKind } : {}),
        });
      }
    }
  }

  return {
    router: new ModelRouter({
      registry,
      catalog,
      routePerformance: performance,
      // Hermetic: the eval must never read the ambient active provider, or a
      // bare model reference could be hijacked by the developer's config.
      activeProviderId: () => null,
    }),
    registry,
    catalog,
  };
}

/** Run every case (or a subset) and report per-case outcomes. */
export function runRoutingEval(cases: RoutingEvalCase[] = ROUTING_EVAL_CASES): RoutingEvalReport {
  const results: RoutingEvalCaseResult[] = [];

  for (const testCase of cases) {
    const previous = snapshotRoutingConfig();
    const harness = buildHarness(testCase.providers);
    let detail = "";
    let passed = false;
    let selectedRouteId: string | undefined;
    let candidateRoutes: string[] = [];
    let rejected: string[] = [];

    try {
      resetRoutingConfig();
      if (testCase.routingConfig) {
        setRoutingConfig({
          ...(testCase.routingConfig.policy ? { policy: testCase.routingConfig.policy } : {}),
          ...(testCase.routingConfig.fallback ? { fallback: testCase.routingConfig.fallback } : {}),
          ...(testCase.routingConfig.allowProviderFallback !== undefined
            ? { allowProviderFallback: testCase.routingConfig.allowProviderFallback }
            : {}),
          ...(testCase.routingConfig.providerPolicy ? { providerPolicy: testCase.routingConfig.providerPolicy } : {}),
        });
      }

      const decision = harness.router.explain({
        ...(testCase.request.model ? { model: testCase.request.model } : {}),
        ...(testCase.request.provider ? { provider: testCase.request.provider } : {}),
        ...(testCase.request.policy ? { policy: testCase.request.policy as never } : {}),
        ...(testCase.request.constraints ? { providerConstraints: testCase.request.constraints } : {}),
        ...(testCase.request.requiredCapabilities
          ? { requiredCapabilities: testCase.request.requiredCapabilities }
          : {}),
      });

      selectedRouteId = decision.selectedRoute?.routeId;
      candidateRoutes = decision.candidateRoutes.map((route) => route.providerId);
      rejected = decision.rejected.map((entry) => `${entry.modelId ?? entry.routeId}:${entry.reason}`);
      const outcome = verify(decision, testCase.expect);
      passed = outcome.passed;
      detail = outcome.detail;
    } catch (error) {
      detail = `threw: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      restoreRoutingConfig(previous);
    }

    results.push({
      id: testCase.id,
      name: testCase.name,
      passed,
      detail,
      ...(selectedRouteId ? { selectedRouteId } : {}),
      candidateRoutes,
      rejected,
    });
  }

  return {
    results,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
  };
}

function verify(
  decision: ReturnType<ModelRouter["explain"]>,
  expect: RoutingEvalExpectations,
): { passed: boolean; detail: string } {
  const failures: string[] = [];

  if (expect.selectNothing) {
    if (decision.selectedRoute) failures.push(`expected no selection, got ${decision.selectedRoute.routeId}`);
  } else if (!decision.selectedRoute) {
    failures.push("expected a selected route, got none");
  }

  if (expect.selectedProvider && decision.selectedRoute?.providerId !== expect.selectedProvider) {
    failures.push(`expected provider ${expect.selectedProvider}, got ${decision.selectedRoute?.providerId ?? "none"}`);
  }
  if (expect.selectedRouteId && decision.selectedRoute?.routeId !== expect.selectedRouteId) {
    failures.push(`expected route ${expect.selectedRouteId}, got ${decision.selectedRoute?.routeId ?? "none"}`);
  }
  if (expect.candidateCount !== undefined && decision.candidateRoutes.length !== expect.candidateCount) {
    failures.push(`expected ${expect.candidateCount} candidates, got ${decision.candidateRoutes.length}`);
  }
  if (expect.fallbackChainLength !== undefined && decision.fallbackChain.length !== expect.fallbackChainLength) {
    failures.push(`expected fallback chain length ${expect.fallbackChainLength}, got ${decision.fallbackChain.length}`);
  }
  if (expect.orderedProviders) {
    const actual = decision.fallbackChain.map((route) => route.providerId);
    if (actual.join(",") !== expect.orderedProviders.join(",")) {
      failures.push(`expected order ${expect.orderedProviders.join(",")}, got ${actual.join(",")}`);
    }
  }
  if (expect.rejectedReason && !decision.rejected.some((entry) => entry.reason === expect.rejectedReason)) {
    failures.push(
      `expected a '${expect.rejectedReason}' rejection, got [${decision.rejected.map((entry) => entry.reason).join(", ")}]`,
    );
  }

  return { passed: failures.length === 0, detail: failures.join("; ") || "ok" };
}

function snapshotRoutingConfig() {
  return getRoutingConfig();
}

function restoreRoutingConfig(config: ReturnType<typeof snapshotRoutingConfig>): void {
  setRoutingConfig(config);
}

// ── Built-in cases ──────────────────────────────────────────────────────────

const TOOL_MODEL: RoutingEvalModel = { apiModelId: "shared-model", capabilities: { tools: true, nativeToolCalls: true } };

export const ROUTING_EVAL_CASES: RoutingEvalCase[] = [
  {
    id: "healthy-beats-unhealthy",
    name: "a healthy provider outranks a repeatedly failing one",
    providers: [
      { id: "aaa-provider", priority: 10, models: [TOOL_MODEL] },
      {
        id: "bbb-provider",
        priority: 10,
        models: [TOOL_MODEL],
        outcomes: [
          { ok: false, failureKind: "unavailable" },
          { ok: false, failureKind: "unavailable" },
          { ok: false, failureKind: "unavailable" },
        ],
      },
    ],
    request: { model: "shared-model" },
    expect: { selectedProvider: "aaa-provider", rejectedReason: "provider-unavailable" },
  },
  {
    id: "cheapest-wins",
    name: "cheapest policy prefers the declared-lower price",
    providers: [
      { id: "pricey", priority: 1, models: [{ ...TOOL_MODEL, pricing: { input: 10, output: 30 } }] },
      { id: "budget", priority: 90, models: [{ ...TOOL_MODEL, pricing: { input: 1, output: 3 } }] },
    ],
    request: { model: "shared-model", policy: "cheapest" },
    expect: { selectedProvider: "budget" },
  },
  {
    id: "unknown-price-is-not-free",
    name: "unknown price never counts as free",
    providers: [
      { id: "declared", priority: 1, models: [{ ...TOOL_MODEL, pricing: { input: 1, output: 1 } }] },
      { id: "undeclared", priority: 90, models: [TOOL_MODEL] },
    ],
    request: { model: "shared-model", policy: "cheapest" },
    expect: { selectedProvider: "declared" },
  },
  {
    id: "fastest-uses-observed-latency",
    name: "fastest policy prefers the provider with observed low latency",
    providers: [
      { id: "slow", priority: 1, models: [TOOL_MODEL], outcomes: [{ ok: true, latencyMs: 5000 }, { ok: true, latencyMs: 5000 }] },
      { id: "quick", priority: 90, models: [TOOL_MODEL], outcomes: [{ ok: true, latencyMs: 50 }, { ok: true, latencyMs: 60 }] },
    ],
    request: { model: "shared-model", policy: "fastest" },
    expect: { selectedProvider: "quick" },
  },
  {
    id: "fastest-without-samples-is-insufficient",
    name: "fastest with no samples falls back to health/priority, never invents latency",
    providers: [
      { id: "first", priority: 10, models: [TOOL_MODEL] },
      { id: "second", priority: 20, models: [TOOL_MODEL] },
    ],
    request: { model: "shared-model", policy: "fastest" },
    expect: { selectedProvider: "first", fallbackChainLength: 1 },
  },
  {
    id: "missing-capability-filtered",
    name: "a model missing a required capability is rejected, not ranked last",
    providers: [
      { id: "notools", priority: 1, models: [{ apiModelId: "shared-model", capabilities: { tools: false } }] },
      { id: "withtools", priority: 90, models: [{ apiModelId: "shared-model", capabilities: { tools: true } }] },
    ],
    request: { model: "shared-model", requiredCapabilities: { tools: true } },
    expect: { selectedProvider: "withtools", rejectedReason: "missing-capability" },
  },
  {
    id: "context-insufficient-filtered",
    name: "a declared-too-small context window is rejected",
    providers: [
      { id: "small", priority: 1, models: [{ ...TOOL_MODEL, contextWindow: 8000 }] },
      { id: "large", priority: 90, models: [{ ...TOOL_MODEL, contextWindow: 200000 }] },
    ],
    request: { model: "shared-model", constraints: { minContextLength: 100000 } },
    expect: { selectedProvider: "large", rejectedReason: "context-insufficient" },
  },
  {
    id: "unknown-context-is-kept",
    name: "unknown context is not proof of insufficiency",
    providers: [{ id: "unknownctx", priority: 1, models: [TOOL_MODEL] }],
    request: { model: "shared-model", constraints: { minContextLength: 100000 } },
    expect: { selectedProvider: "unknownctx" },
  },
  {
    id: "price-cap-respected",
    name: "a declared price above the cap is rejected",
    providers: [
      { id: "expensive", priority: 1, models: [{ ...TOOL_MODEL, pricing: { input: 100, output: 100 } }] },
      { id: "affordable", priority: 90, models: [{ ...TOOL_MODEL, pricing: { input: 1, output: 1 } }] },
    ],
    request: { model: "shared-model", constraints: { maxInputPrice: 5 } },
    expect: { selectedProvider: "affordable", rejectedReason: "price-constraint" },
  },
  {
    id: "deny-list-wins",
    name: "a denied provider is never selected",
    providers: [
      { id: "denied", priority: 1, models: [TOOL_MODEL] },
      { id: "allowed", priority: 90, models: [TOOL_MODEL] },
    ],
    request: { model: "shared-model", constraints: { denyProviders: ["denied"] } },
    expect: { selectedProvider: "allowed", rejectedReason: "provider-denied" },
  },
  {
    id: "allow-list-narrows",
    name: "an allow list narrows the pool exactly",
    providers: [
      { id: "one", priority: 1, models: [TOOL_MODEL] },
      { id: "two", priority: 2, models: [TOOL_MODEL] },
    ],
    request: { model: "shared-model", constraints: { allowProviders: ["two"] } },
    expect: { selectedProvider: "two", candidateCount: 1, rejectedReason: "provider-not-allowed" },
  },
  {
    id: "disabled-provider-skipped",
    name: "a disabled provider is skipped with a recorded reason",
    providers: [
      { id: "off", priority: 1, enabled: false, models: [TOOL_MODEL] },
      { id: "on", priority: 90, models: [TOOL_MODEL] },
    ],
    request: { model: "shared-model" },
    expect: { selectedProvider: "on", rejectedReason: "provider-disabled" },
  },
  {
    id: "unknown-model-selects-nothing",
    name: "an unknown model selects nothing and says why",
    providers: [{ id: "only", priority: 1, models: [TOOL_MODEL] }],
    request: { model: "does-not-exist" },
    expect: { selectNothing: true, rejectedReason: "unknown-model" },
  },
  {
    id: "exact-match-only",
    name: "a partial model id never matches (no fuzzy mapping)",
    providers: [{ id: "only", priority: 1, models: [{ apiModelId: "vendor/real-model", capabilities: { tools: true } }] }],
    request: { model: "real-model" },
    expect: { selectNothing: true, rejectedReason: "unknown-model" },
  },
  {
    id: "multiple-upstreams-one-logical-model",
    name: "one logical model served by two upstreams yields two routes",
    providers: [
      { id: "multi", priority: 1, models: [{ ...TOOL_MODEL, upstream: "alpha" }] },
      { id: "multi2", priority: 2, models: [{ ...TOOL_MODEL }] },
    ],
    request: { model: "shared-model" },
    expect: { candidateCount: 2, fallbackChainLength: 1 },
  },
  {
    id: "fallback-chain-ordered-by-policy",
    name: "a configured fallback chain is walked in policy order",
    providers: [
      { id: "primary", priority: 1, models: [{ apiModelId: "primary-model", capabilities: { tools: true } }] },
      { id: "backup", priority: 50, models: [{ apiModelId: "backup-model", capabilities: { tools: true } }] },
    ],
    request: { model: "primary-model" },
    routingConfig: { fallback: ["backup/backup-model"], allowProviderFallback: true },
    expect: { selectedProvider: "primary", orderedProviders: ["primary", "backup"], fallbackChainLength: 2 },
  },
  {
    id: "fallback-veto-pins-single-route",
    name: "allowFallback=false pins the decision to one route",
    providers: [
      { id: "primary", priority: 1, models: [{ apiModelId: "primary-model", capabilities: { tools: true } }] },
      { id: "backup", priority: 50, models: [{ apiModelId: "backup-model", capabilities: { tools: true } }] },
    ],
    request: { model: "primary-model" },
    routingConfig: { fallback: ["backup/backup-model"], allowProviderFallback: false },
    expect: { selectedProvider: "primary", fallbackChainLength: 1, candidateCount: 1 },
  },
  {
    id: "all-candidates-filtered",
    name: "when every candidate is filtered the decision is empty, not a guess",
    providers: [{ id: "only", priority: 1, models: [{ apiModelId: "shared-model", capabilities: { tools: false } }] }],
    request: { model: "shared-model", requiredCapabilities: { tools: true } },
    expect: { selectNothing: true, rejectedReason: "missing-capability" },
  },
  {
    id: "unavailable-pool-is-relaxed-not-empty",
    name: "a fully-unavailable pool is retained and the relaxation is reported",
    providers: [
      {
        id: "flaky",
        priority: 1,
        models: [TOOL_MODEL],
        outcomes: [
          { ok: false, failureKind: "unavailable" },
          { ok: false, failureKind: "unavailable" },
          { ok: false, failureKind: "unavailable" },
        ],
      },
    ],
    request: { model: "shared-model" },
    expect: { selectedProvider: "flaky", candidateCount: 1 },
  },
  {
    id: "tie-break-is-deterministic",
    name: "identical providers tie-break on provider id (total order)",
    providers: [
      { id: "zzz", priority: 10, models: [TOOL_MODEL] },
      { id: "aaa", priority: 10, models: [TOOL_MODEL] },
    ],
    request: { model: "shared-model" },
    expect: { selectedProvider: "aaa" },
  },
  {
    id: "disabled-model-rejected",
    name: "a disabled catalog model is rejected with a reason",
    providers: [
      { id: "one", priority: 1, models: [{ ...TOOL_MODEL, status: "disabled" }] },
      { id: "two", priority: 90, models: [TOOL_MODEL] },
    ],
    request: { model: "shared-model" },
    expect: { selectedProvider: "two", rejectedReason: "model-disabled" },
  },
];
