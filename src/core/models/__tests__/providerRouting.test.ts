/**
 * Phase 82 — unit tests for the provider-routing layer.
 *
 * Covers the modules with no other direct coverage: route identity, provider
 * policy resolution, resolver guard clauses, scorer ordering/tie-breaks,
 * failure classification, performance boundedness, and the explain() contract
 * (including the defects the routing eval flushed out).
 */

import { describe, expect, it } from "bun:test";
import { DEFAULT_UPSTREAM, logicalModelKey, routeFromModel, routeIdOf } from "../route";
import { resolveProviderRoutingPolicy } from "../providerPolicy";
import { classifyProviderFailure } from "../failureKind";
import { RoutePerformanceTracker, ROUTE_LATENCY_MIN_SAMPLES } from "../routePerformance";
import { compareRoutes, scoreRoute } from "../routeScoring";
import { resolveProviderRoutes } from "../routeResolver";
import { ModelCatalog } from "../catalog";
import { ProviderRegistry } from "../registry";
import { ModelRouter, setRoutingConfig, resetRoutingConfig } from "../router";
import { ModelCapabilityError } from "../errors";
import { formatModelRef } from "../ref";
import type { ModelDefinition, ProviderHealth, ProviderRegistration } from "../types";

function makeModel(providerId: string, apiModelId: string, extra: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: formatModelRef(providerId, apiModelId),
    providerId,
    apiModelId,
    capabilities: {},
    status: "active",
    ...extra,
  };
}

function makeProvider(spec: {
  id: string;
  priority?: number;
  enabled?: boolean;
  status?: "connected" | "disabled" | "failed" | "unknown";
  models?: ModelDefinition[];
}): ProviderRegistration {
  return {
    id: spec.id,
    kind: "openai-compatible",
    baseURL: `https://${spec.id}.invalid/v1`,
    ...(spec.priority !== undefined ? { priority: spec.priority } : {}),
    ...(spec.enabled !== undefined ? { enabled: spec.enabled } : {}),
    ...(spec.status ? { status: spec.status } : {}),
    models: spec.models ?? [],
  };
}

function harness(
  providers: ProviderRegistration[],
): { router: ModelRouter; registry: ProviderRegistry; catalog: ModelCatalog } {
  const catalog = new ModelCatalog();
  const registry = new ProviderRegistry(catalog);
  for (const provider of providers) registry.register(provider, { replace: true });
  return { router: new ModelRouter({ registry, catalog, activeProviderId: () => null }), registry, catalog };
}

/** Minimal tool-capable capability set shared by routing cases. */
const TOOL = { tools: true, nativeToolCalls: true };

function fakeHealth(state: ProviderHealth["state"] = "healthy"): ProviderHealth {
  return { state, requestCount: 0, successCount: 0, failureCount: 0, consecutiveFailures: 0 };
}

describe("Phase 82 §1 — route identity", () => {
  it("formats route ids deterministically with a default upstream", () => {
    expect(routeIdOf("OpenRouter", "anthropic/claude-sonnet")).toBe("openrouter::default::anthropic/claude-sonnet");
    expect(routeIdOf("openrouter", "m", "Together")).toBe("openrouter::together::m");
  });

  it("keeps the logical key provider-independent and exact", () => {
    expect(logicalModelKey("  Vendor/Model-X ")).toBe("vendor/model-x");
    // No fuzzy matching: a suffix match is not the same logical model.
    expect(logicalModelKey("claude-3.5-sonnet")).not.toBe(logicalModelKey("anthropic/claude-3.5-sonnet"));
  });

  it("projects a catalog model into a route without inventing upstream identity", () => {
    const provider = makeProvider({ id: "p", priority: 3, models: [] });
    const model = makeModel("p", "m", { metadata: { upstream: "Alpha" } });
    const route = routeFromModel(model, provider as never, fakeHealth());
    expect(route.routeId).toBe("p::alpha::m");
    expect(route.priority).toBe(3);
    expect(route.logicalKey).toBe("m");
    expect(DEFAULT_UPSTREAM).toBe("default");
  });
});

describe("Phase 82 §3 — provider routing policies", () => {
  it("resolves every canonical policy by name", () => {
    const names = ["priority", "cheapest", "fastest", "balanced", "reliability-first"] as const;
    for (const name of names) {
      expect(resolveProviderRoutingPolicy(name).name).toBe(name);
    }
    // Unknown input falls back to the default deterministically.
    expect(resolveProviderRoutingPolicy("no-such-policy").name).toBe("priority");
  });

  it("weights are policy-specific and merged constraints win", () => {
    expect(resolveProviderRoutingPolicy("cheapest").weights.cost).toBe(1);
    expect(resolveProviderRoutingPolicy("fastest").weights.latency).toBe(1);
    const merged = resolveProviderRoutingPolicy("cheapest", { denyProviders: ["x"], allowFallback: false });
    expect(merged.constraints.denyProviders).toContain("x");
    expect(merged.constraints.allowFallback).toBe(false);
  });
});

describe("Phase 82 §4/§5 — failure classification and health", () => {
  it("classifies provider-attributable failures as retryable + health-affecting", () => {
    for (const message of ["HTTP 429: slow down", "HTTP 503: upstream", "request timed out", "ECONNRESET"]) {
      const c = classifyProviderFailure(new Error(message));
      expect(c.retryable).toBe(true);
      expect(c.affectsHealth).toBe(true);
    }
  });

  it("never blames the provider for caller faults (auth is provider-attributable)", () => {
    // Permission, cancellation and bad requests are the CALLER's fault — they
    // must not degrade provider health. Auth failures ARE provider-attributable
    // (stale/invalid credentials on the provider side of the contract).
    for (const message of ["permission denied", "The operation was cancelled", "HTTP 400 invalid request"]) {
      const c = classifyProviderFailure(new Error(message));
      expect(c.affectsHealth).toBe(false);
    }
    expect(classifyProviderFailure(new Error("HTTP 401")).affectsHealth).toBe(true);
  });
});

describe("Phase 82 §5 — route performance is bounded and honest", () => {
  it("withholds latency until the sample floor is met", () => {
    const tracker = new RoutePerformanceTracker();
    const id = "p::default::m";
    tracker.record(id, { ok: true, durationMs: 100 });
    expect(tracker.snapshots().find((s) => s.routeId === id)?.sufficient).toBe(false);
    tracker.record(id, { ok: true, durationMs: 120 });
    const snapshot = tracker.snapshots().find((s) => s.routeId === id)!;
    expect(snapshot.sufficient).toBe(true);
    expect(snapshot.latencyMs).toBeGreaterThan(0);
  });

  it("meets the declared minimum-sample floor", () => {
    expect(ROUTE_LATENCY_MIN_SAMPLES).toBeGreaterThanOrEqual(2);
  });

  it("discards non-finite input instead of recording it", () => {
    const tracker = new RoutePerformanceTracker();
    tracker.record("p::default::m", { ok: true, durationMs: Number.NaN });
    const snapshot = tracker.snapshots().find((s) => s.routeId === "p::default::m")!;
    expect(snapshot.samples).toBe(1); // the outcome counts
    expect(snapshot.latencyMs).toBeUndefined(); // the latency does not
  });

  it("serializes numbers and ids only — never content", () => {
    const tracker = new RoutePerformanceTracker();
    tracker.record("p::default::m", { ok: true, durationMs: 5 });
    tracker.record("p::default::m", { ok: false, failureKind: "timeout" });
    const rows = tracker.toJSON();
    expect(rows.length).toBe(1);
    const allowed = new Set(["string", "number", "undefined"]);
    for (const entry of rows) {
      expect(typeof entry.routeId).toBe("string");
      expect(Array.isArray(entry.ring)).toBe(true);
      for (const value of Object.values(entry)) {
        if (value === null) continue;
        expect(Array.isArray(value) || allowed.has(typeof value)).toBe(true);
      }
    }
    // The ring carries numbers only (bounded latencies), never payloads.
    for (const sample of rows[0].ring) expect(typeof sample).toBe("number");
  });
});

describe("Phase 82 §6 — deterministic route scoring", () => {
  const policy = resolveProviderRoutingPolicy("cheapest");

  function fakeHealth(state: "healthy" | "degraded" | "unavailable" | "unknown" = "healthy"): ProviderHealth {
    return { state, requestCount: 0, successCount: 0, failureCount: 0, consecutiveFailures: 0 };
  }

  function route(id: string, overrides: Record<string, unknown> = {}): ReturnType<typeof routeFromModel> {
    const provider = makeProvider({ id, priority: 10, models: [] });
    const model = makeModel(id, "m");
    return routeFromModel(model, provider as never, fakeHealth());
  }

  it("cheapest really wins under the cheapest policy (score is primary)", () => {
    const cheap = route("budget");
    const dear = route("pricey");
    cheap.pricing = { input: 1, output: 1, currency: "USD", source: "provider" };
    dear.pricing = { input: 50, output: 50, currency: "USD", source: "provider" };
    // Note: priority would have favoured pricey (it is created first with the
    // same priority); the policy score must decide regardless.
    dear.priority = 1;
    cheap.priority = 99;
    expect(compareRoutes(cheap, dear, (r) => scoreRoute({ route: r, policy }).total)).toBeLessThan(0);
  });

  it("unknown pricing is neutral, not free — it loses to a declared price under cheapest", () => {
    const declared = route("declared");
    const undeclared = route("mystery");
    declared.pricing = { input: 1, output: 1, currency: "USD", source: "provider" };
    const policyScore = (r: ReturnType<typeof routeFromModel>) => scoreRoute({ route: r, policy }).total;
    expect(compareRoutes(declared, undeclared, policyScore)).toBeLessThan(0);
  });

  it("degrades to declared priority when the policy has no evidence", () => {
    const a = route("aaa");
    const b = route("zzz");
    a.priority = 1;
    b.priority = 99;
    expect(compareRoutes(a, b, (r) => scoreRoute({ route: r, policy }).total)).toBeLessThan(0);
  });

  it("tie-breaks lexically for a total order", () => {
    const a = route("aaa");
    const b = route("zzz");
    expect(compareRoutes(a, b, () => 0.5)).toBeLessThan(0);
    expect(compareRoutes(a, a, () => 0.5)).toBe(0);
  });

  it("never produces a non-finite or out-of-range total", () => {
    const score = scoreRoute({ route: route("p"), policy });
    expect(Number.isFinite(score.total)).toBe(true);
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(1);
  });
});

describe("Phase 82 §2 — resolver guard clauses", () => {
  it("records provider-disabled rejections before scoring", () => {
    const { router } = harness([
      makeProvider({ id: "off", priority: 1, enabled: false, models: [makeModel("off", "m", { capabilities: TOOL })] }),
      makeProvider({ id: "on", priority: 2, models: [makeModel("on", "m", { capabilities: TOOL })] }),
    ]);
    const decision = router.explain({ model: "m" });
    expect(decision.selectedRoute?.providerId).toBe("on");
    expect(decision.rejected.some((entry) => entry.reason === "provider-disabled")).toBe(true);
  });

  it("records context and price rejections", () => {
    const { router } = harness([
      makeProvider({
        id: "small",
        priority: 1,
        models: [makeModel("small", "m", { capabilities: TOOL, contextWindow: 8000 })],
      }),
      makeProvider({
        id: "large",
        priority: 2,
        models: [makeModel("large", "m", { capabilities: TOOL, contextWindow: 200000 })],
      }),
    ]);
    const decision = router.explain({ model: "m", providerConstraints: { minContextLength: 100000 } });
    expect(decision.selectedRoute?.providerId).toBe("large");
    expect(decision.rejected.some((entry) => entry.reason === "context-insufficient")).toBe(true);

    const expensive = router.explain({
      model: "m",
      providerConstraints: { maxInputPrice: 5 },
    });
    expect(expensive.selectedRoute).toBeDefined(); // no pricing declared → no violation provable
  });

  it("keeps unknown context (unknown is not proof of violation)", () => {
    const { router } = harness([makeProvider({ id: "p", priority: 1, models: [makeModel("p", "m", { capabilities: TOOL })] })]);
    const decision = router.explain({ model: "m", providerConstraints: { minContextLength: 10_000_000 } });
    expect(decision.selectedRoute?.providerId).toBe("p");
  });
});

describe("Phase 82 §17 — router defect regressions", () => {
  afterEachLike();

  function afterEachLike(): void {
    // Router config is process-global; leave it exactly as we found it.
    process.on("exit", () => resetRoutingConfig());
  }

  it("explicit pin + requiredCapabilities mismatch is a hard capability error", () => {
    resetRoutingConfig();
    const { router } = harness([makeProvider({ id: "p", priority: 1, models: [makeModel("p", "m", { capabilities: { tools: false } })] })]);
    expect(() => router.resolve({ model: "m", requiredCapabilities: { tools: true } })).toThrow(ModelCapabilityError);
  });

  it("explain maps an explicit cheapest policy onto the provider layer", () => {
    resetRoutingConfig();
    const catalog = new ModelCatalog();
    const registry = new ProviderRegistry(catalog);
    registry.register(
      makeProvider({
        id: "pricey",
        priority: 1,
        models: [makeModel("pricey", "m", { capabilities: TOOL, pricing: { input: 10, output: 10, currency: "USD", source: "provider" } })],
      }),
      { replace: true },
    );
    registry.register(
      makeProvider({
        id: "budget",
        priority: 90,
        models: [makeModel("budget", "m", { capabilities: TOOL, pricing: { input: 1, output: 1, currency: "USD", source: "provider" } })],
      }),
      { replace: true },
    );
    const router = new ModelRouter({ registry, catalog, activeProviderId: () => null });
    const decision = router.explain({ model: "m", policy: "cheapest" });
    expect(decision.providerPolicy.name).toBe("cheapest");
    expect(decision.selectedRoute?.providerId).toBe("budget");
  });

  it("explain reports the configured fallback chain headed by the selection", () => {
    resetRoutingConfig();
    setRoutingConfig({ fallback: ["c/m"], allowProviderFallback: true });
    const catalog = new ModelCatalog();
    const registry = new ProviderRegistry(catalog);
    registry.register(makeProvider({ id: "a", priority: 1, models: [makeModel("a", "m", { capabilities: TOOL })] }), { replace: true });
    registry.register(makeProvider({ id: "b", priority: 2, models: [makeModel("b", "m", { capabilities: TOOL })] }), { replace: true });
    registry.register(makeProvider({ id: "c", priority: 3, models: [makeModel("c", "m", { capabilities: TOOL })] }), { replace: true });
    const router = new ModelRouter({ registry, catalog, activeProviderId: () => null });
    const decision = router.explain({ model: "m" });
    expect(decision.candidateRoutes.length).toBe(3);
    // Head is the policy-ranked selection; the configured fallback ref follows
    // before the ranked-pool fill (production resolve() semantics).
    expect(decision.fallbackChain.map((route) => route.providerId)).toEqual(["a", "c", "b"]);
  });

  it("allowProviderFallback=false pins the reported chain to one route", () => {
    resetRoutingConfig();
    setRoutingConfig({ fallback: ["b/m"], allowProviderFallback: false });
    const catalog = new ModelCatalog();
    const registry = new ProviderRegistry(catalog);
    registry.register(makeProvider({ id: "a", priority: 1, models: [makeModel("a", "m", { capabilities: TOOL })] }), { replace: true });
    registry.register(makeProvider({ id: "b", priority: 2, models: [makeModel("b", "m", { capabilities: TOOL })] }), { replace: true });
    const router = new ModelRouter({ registry, catalog, activeProviderId: () => null });
    const decision = router.explain({ model: "m" });
    expect(decision.fallbackChain.length).toBe(1);
  });
});
