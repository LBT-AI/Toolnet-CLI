import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ModelCatalog } from "../catalog";
import { ProviderRegistry } from "../registry";
import { ModelRouter, providerSpeed, resetRoutingConfig, setRoutingConfig } from "../router";
import { formatModelRef } from "../ref";
import type { ModelDefinition, ProviderRegistration } from "../types";

function model(providerId: string, apiModelId: string, extra: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: formatModelRef(providerId, apiModelId),
    providerId,
    apiModelId,
    capabilities: {},
    status: "active",
    ...extra,
  };
}

function registration(overrides: Partial<ProviderRegistration> = {}): ProviderRegistration {
  return { id: "openrouter", kind: "openrouter", baseURL: "https://openrouter.ai/api/v1", ...overrides };
}

describe("Phase 80 — profile-driven routing", () => {
  let catalog: ModelCatalog;
  let registry: ProviderRegistry;
  let router: ModelRouter;

  beforeEach(() => {
    catalog = new ModelCatalog();
    registry = new ProviderRegistry(catalog);
    router = new ModelRouter({ registry, catalog, activeProviderId: () => null });
    resetRoutingConfig();
  });

  afterEach(() => {
    resetRoutingConfig();
  });

  it("keeps default routing on the Phase 79 priority ordering", () => {
    registry.register(registration({ priority: 100, models: [model("openrouter", "low")] }));
    registry.register(
      registration({ id: "toolnet", kind: "toolnet", baseURL: "https://t", priority: 5, models: [model("toolnet", "high")] }),
    );
    const resolved = router.resolve({});
    expect(resolved.model.id).toBe("toolnet/high");
    expect(resolved.profile).toBe("auto");
  });

  it("requires tools for the coding profile even when the caller did not ask", () => {
    registry.register(
      registration({
        priority: 1,
        models: [model("openrouter", "chat-only", { capabilities: { tools: false }, contextWindow: 200_000 })],
      }),
    );
    registry.register(
      registration({
        id: "toolnet",
        kind: "toolnet",
        baseURL: "https://t",
        priority: 900,
        models: [model("toolnet", "coder", { capabilities: { tools: true }, contextWindow: 200_000 })],
      }),
    );

    const resolved = router.resolve({ profile: "coding" });
    expect(resolved.model.apiModelId).toBe("coder");
    expect(resolved.profile).toBe("coding");
    expect(resolved.routingReason).toContain("coding/");
  });

  it("drops models whose declared context window is too small for the profile", () => {
    registry.register(
      registration({
        priority: 1,
        models: [
          model("openrouter", "tiny", { capabilities: { tools: true }, contextWindow: 8_000 }),
          model("openrouter", "big", { capabilities: { tools: true }, contextWindow: 200_000 }),
        ],
      }),
    );

    const resolved = router.resolve({ profile: "long-context" });
    expect(resolved.model.apiModelId).toBe("big");
  });

  it("keeps a model with an UNKNOWN context window (unknown is not insufficiency)", () => {
    registry.register(
      registration({ models: [model("openrouter", "unknown-ctx", { capabilities: { tools: true } })] }),
    );
    const resolved = router.resolve({ profile: "coding", requiredCapabilities: { tools: true } });
    expect(resolved.model.apiModelId).toBe("unknown-ctx");
  });

  it("lets an explicit policy win over a scoring profile", () => {
    registry.register(
      registration({
        models: [
          model("openrouter", "pricey", { capabilities: { tools: true }, pricing: { input: 20, output: 20 } }),
          model("openrouter", "cheap", { capabilities: { tools: true }, pricing: { input: 1, output: 1 } }),
        ],
      }),
    );

    const resolved = router.resolve({ profile: "coding", policy: "cheapest" });
    expect(resolved.model.apiModelId).toBe("cheap");
    expect(resolved.routingReason).toContain("cheapest");
  });

  it("reports a score for score-ranked profiles", () => {
    registry.register(
      registration({ models: [model("openrouter", "a", { capabilities: { tools: true, reasoning: true } })] }),
    );
    const resolved = router.resolve({ profile: "quality" });
    expect(typeof resolved.score).toBe("number");
    expect(resolved.score).toBeGreaterThanOrEqual(0);
    expect(resolved.routingReason).toContain("scored");
  });

  it("never swaps an explicitly requested model even under a scoring profile", () => {
    registry.register(
      registration({
        priority: 1,
        models: [
          model("openrouter", "weak", { capabilities: { tools: true }, contextWindow: 200_000 }),
          model("openrouter", "strong", { capabilities: { tools: true, reasoning: true }, contextWindow: 200_000 }),
        ],
      }),
    );

    const resolved = router.resolve({ model: "openrouter/weak", profile: "quality" });
    expect(resolved.model.apiModelId).toBe("weak");
    expect(resolved.candidates[0].apiModelId).toBe("weak");
  });

  it("uses optional eval data when provided, and routing still works without it", () => {
    registry.register(
      registration({
        models: [
          model("openrouter", "a", { capabilities: { tools: true } }),
          model("openrouter", "b", { capabilities: { tools: true } }),
        ],
      }),
    );

    const withoutEval = new ModelRouter({ registry, catalog, activeProviderId: () => null });
    expect(withoutEval.resolve({ profile: "coding" }).model).toBeDefined();

    const withEval = new ModelRouter({
      registry,
      catalog,
      activeProviderId: () => null,
      performance: () => [
        {
          modelId: "openrouter/b",
          providerId: "openrouter",
          samples: 10,
          scores: { coding: 1, toolUse: 1, reliability: 1 },
          insufficient: [],
          updatedAt: Date.now(),
        },
      ],
    });
    const resolved = withEval.resolve({ profile: "coding" });
    expect(resolved.model.apiModelId).toBe("b");
  });

  it("falls back to capability/health when eval data is insufficient", () => {
    registry.register(
      registration({
        priority: 1,
        models: [
          model("openrouter", "a", { capabilities: { tools: true } }),
          model("openrouter", "b", { capabilities: { tools: true } }),
        ],
      }),
    );
    const withEmptyEval = new ModelRouter({
      registry,
      catalog,
      activeProviderId: () => null,
      performance: () => [
        {
          modelId: "openrouter/b",
          providerId: "openrouter",
          samples: 1,
          scores: {},
          insufficient: ["coding", "reliability"],
          updatedAt: 0,
        },
      ],
    });
    // Deterministic tie-break by id: 'a' wins because no eval signal separates them.
    expect(withEmptyEval.resolve({ profile: "coding" }).model.apiModelId).toBe("a");
  });

  it("reports insufficient latency data for the fastest policy", () => {
    registry.register(registration({ models: [model("openrouter", "a")] }));
    expect(providerSpeed(registry, "openrouter").sufficient).toBe(false);
    registry.recordSuccess("openrouter", 20);
    registry.recordSuccess("openrouter", 25);
    const speed = providerSpeed(registry, "openrouter");
    expect(speed.sufficient).toBe(true);
    expect(speed.samples).toBe(2);
  });

  it("honours the persisted default profile from routing config", () => {
    registry.register(registration({ priority: 1, models: [model("openrouter", "plain", { capabilities: { tools: true } })] }));
    registry.register(
      registration({
        id: "toolnet",
        kind: "toolnet",
        baseURL: "https://t",
        priority: 900,
        models: [model("toolnet", "reasoner", { capabilities: { tools: true, reasoning: true } })],
      }),
    );

    setRoutingConfig({ profile: "reasoning" });
    const resolved = router.resolve({});
    expect(resolved.model.apiModelId).toBe("reasoner");
    expect(resolved.profile).toBe("reasoning");
  });

  it("is deterministic under a scoring profile", () => {
    registry.register(
      registration({
        models: [
          model("openrouter", "a", { capabilities: { tools: true, reasoning: true } }),
          model("openrouter", "b", { capabilities: { tools: true } }),
          model("openrouter", "c", { capabilities: { tools: true, nativeToolCalls: true } }),
        ],
      }),
    );
    const first = router.resolve({ profile: "coding" }).model.id;
    for (let i = 0; i < 5; i++) {
      expect(router.resolve({ profile: "coding" }).model.id).toBe(first);
    }
  });
});
