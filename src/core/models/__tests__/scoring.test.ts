import { describe, expect, it } from "bun:test";
import { NEUTRAL, evalScore, latencyScore, scoreModel, scoreTotal } from "../scoring";
import { ROUTING_PROFILES } from "../profiles";
import { unknownHealth, type ModelDefinition, type ProviderDefinition, type ProviderHealth } from "../types";
import type { ModelPerformanceProfile } from "../performance";

function model(extra: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: "p/m",
    providerId: "p",
    apiModelId: "m",
    capabilities: {},
    status: "active",
    ...extra,
  };
}

function provider(health: ProviderHealth): ProviderDefinition {
  return {
    id: "p",
    name: "P",
    kind: "openai-compatible",
    baseURL: "https://p.invalid",
    models: ["p/m"],
    status: "connected",
    health,
    priority: 10,
    enabled: true,
  };
}

function input(overrides: {
  model?: ModelDefinition;
  health?: ProviderHealth;
  profile?: keyof typeof ROUTING_PROFILES;
  request?: Parameters<typeof scoreModel>[0]["request"];
  performance?: ModelPerformanceProfile;
}) {
  const health = overrides.health ?? unknownHealth();
  return {
    model: overrides.model ?? model(),
    provider: provider(health),
    health,
    profile: ROUTING_PROFILES[overrides.profile ?? "quality"],
    request: overrides.request ?? {},
    performance: overrides.performance,
  };
}

describe("Phase 80 — ModelScorer", () => {
  it("is deterministic for identical inputs", () => {
    const one = scoreTotal(input({ health: { ...unknownHealth(), state: "healthy", latencyMs: 120, successCount: 5 } }));
    for (let i = 0; i < 5; i++) {
      expect(
        scoreTotal(input({ health: { ...unknownHealth(), state: "healthy", latencyMs: 120, successCount: 5 } })),
      ).toBe(one);
    }
  });

  it("scores a capability-satisfying model above one that lacks it", () => {
    const withReasoning = scoreTotal(
      input({ model: model({ capabilities: { tools: true, reasoning: true, nativeToolCalls: true } }), profile: "coding" }),
    );
    const withoutReasoning = scoreTotal(
      input({ model: model({ capabilities: { tools: true } }), profile: "coding" }),
    );
    expect(withReasoning).toBeGreaterThan(withoutReasoning);
  });

  it("does not award capability credit for an UNKNOWN capability", () => {
    // `undefined` is "unknown", not "yes": it must score below a declared true.
    const unknownCap = scoreTotal(input({ model: model({ capabilities: { tools: true } }), profile: "coding" }));
    const declaredCap = scoreTotal(
      input({ model: model({ capabilities: { tools: true, nativeToolCalls: true } }), profile: "coding" }),
    );
    expect(declaredCap).toBeGreaterThan(unknownCap);
  });

  it("treats unknown pricing as neutral, never as free", () => {
    const free = scoreTotal(
      input({ model: model({ pricing: { input: 0, output: 0 } }), profile: "cheap" }),
    );
    const paid = scoreTotal(
      input({ model: model({ pricing: { input: 40, output: 40 } }), profile: "cheap" }),
    );
    const unknown = scoreTotal(input({ model: model(), profile: "cheap" }));

    expect(free).toBeGreaterThan(paid);
    // Unknown must sit strictly between "free" and "very expensive" — i.e. it is
    // neutral (0.5), not zero.
    expect(unknown).toBeGreaterThan(paid);
    expect(unknown).toBeLessThan(free);
  });

  it("reports insufficient latency samples rather than a latency score", () => {
    const result = latencyScore({ ...unknownHealth(), state: "healthy", successCount: 1, latencyMs: 5 });
    expect(result.sufficient).toBe(false);
    expect(result.value).toBe(NEUTRAL);
    expect(result.note).toContain("insufficient");
  });

  it("scores observed latency once enough samples exist", () => {
    const fast = latencyScore({ ...unknownHealth(), state: "healthy", successCount: 5, latencyMs: 50 });
    const slow = latencyScore({ ...unknownHealth(), state: "healthy", successCount: 5, latencyMs: 4000 });
    expect(fast.sufficient).toBe(true);
    expect(fast.value).toBeGreaterThan(slow.value);
  });

  it("uses health, not model identity, for the health component", () => {
    const healthy = scoreModel(input({ health: { ...unknownHealth(), state: "healthy" } }));
    const unavailable = scoreModel(input({ health: { ...unknownHealth(), state: "unavailable" } }));
    const healthyComponent = healthy.components.find((entry) => entry.key === "health");
    const unavailableComponent = unavailable.components.find((entry) => entry.key === "health");
    expect(healthyComponent?.value).toBe(1);
    expect(unavailableComponent?.value).toBe(0);
  });

  it("stays neutral for eval evidence when there is no data", () => {
    const noData = evalScore(undefined, ["coding"]);
    expect(noData.measured).toBe(false);
    expect(noData.value).toBe(NEUTRAL);

    const enough = evalScore(
      { modelId: "p/m", providerId: "p", samples: 10, scores: { coding: 0.9 }, insufficient: [], updatedAt: 0 },
      ["coding"],
    );
    expect(enough.measured).toBe(true);
    expect(enough.value).toBeCloseTo(0.9, 5);
  });

  it("ignores eval dimensions without a score instead of treating them as zero", () => {
    const partial = evalScore(
      {
        modelId: "p/m",
        providerId: "p",
        samples: 10,
        scores: { coding: 0.8 },
        insufficient: ["toolUse"],
        updatedAt: 0,
      },
      ["coding", "toolUse"],
    );
    expect(partial.value).toBeCloseTo(0.8, 5);
    expect(partial.note).toContain("unmeasured");
  });

  it("scores a declared long context above a short one for the long-context profile", () => {
    const long = scoreTotal(
      input({ model: model({ contextWindow: 200_000 }), profile: "long-context", request: { minContextWindow: 128_000 } }),
    );
    const short = scoreTotal(
      input({ model: model({ contextWindow: 8_000 }), profile: "long-context", request: { minContextWindow: 128_000 } }),
    );
    expect(long).toBeGreaterThan(short);
  });

  it("keeps the total inside 0..1 and records every weighted component", () => {
    const score = scoreModel(input({ model: model({ capabilities: { tools: true } }), profile: "coding" }));
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(1);
    expect(score.components.length).toBeGreaterThan(0);
    for (const component of score.components) {
      expect(component.value).toBeGreaterThanOrEqual(0);
      expect(component.value).toBeLessThanOrEqual(1);
    }
  });

  it("applies no weights for components a profile zeroes out", () => {
    const score = scoreModel(input({ profile: "fast" }));
    const keys = score.components.map((entry) => entry.key);
    expect(keys).not.toContain("eval");
    expect(keys).not.toContain("cost");
    expect(keys).toContain("latency");
  });
});
