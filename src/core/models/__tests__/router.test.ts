import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ModelCatalog } from "../catalog";
import { ProviderRegistry } from "../registry";
import { ModelRouter, resetRoutingConfig, setRoutingConfig } from "../router";
import { ModelRoutingError, ProviderNotFoundError } from "../errors";
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
  return {
    id: "openrouter",
    kind: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    ...overrides,
  };
}

describe("Phase 79 — ModelRouter", () => {
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

  it("resolves an explicit provider + model pair", () => {
    registry.register(registration({ models: [model("openrouter", "anthropic/claude-sonnet")] }));
    const resolved = router.resolve({ model: "openrouter/anthropic/claude-sonnet" });
    expect(resolved.provider.id).toBe("openrouter");
    expect(resolved.model.apiModelId).toBe("anthropic/claude-sonnet");
    expect(resolved.routingReason).toContain("explicit");
  });

  it("resolves via an explicit provider when only the provider is given", () => {
    registry.register(registration({ models: [model("openrouter", "a"), model("openrouter", "b")] }));
    registry.register(registration({ id: "toolnet", kind: "toolnet", baseURL: "https://t", models: [model("toolnet", "c")] }));

    const resolved = router.resolve({ provider: "toolnet" });
    expect(resolved.provider.id).toBe("toolnet");
    expect(resolved.model.apiModelId).toBe("c");
  });

  it("never silently swaps an explicitly requested model under priority policy", () => {
    registry.register(registration({ priority: 1, models: [model("openrouter", "cheap")] }));
    registry.register(
      registration({ id: "toolnet", kind: "toolnet", baseURL: "https://t", priority: 999, models: [model("toolnet", "preferred")] }),
    );

    const resolved = router.resolve({ model: "toolnet/preferred" });
    expect(resolved.model.id).toBe("toolnet/preferred");
    expect(resolved.candidates).toHaveLength(1);
  });

  it("throws a structured error for an unknown model", () => {
    registry.register(registration({ models: [model("openrouter", "a")] }));
    expect(() => router.resolve({ model: "openrouter/ghost" })).toThrow(ModelRoutingError);
    expect(() => router.resolve({ model: "openrouter/ghost" })).toThrow(/not registered/);
  });

  it("throws ProviderNotFoundError for an unknown explicit provider", () => {
    registry.register(registration({ models: [model("openrouter", "a")] }));
    expect(() => router.resolve({ provider: "ghost" })).toThrow(ProviderNotFoundError);
  });

  it("filters by required capabilities before considering cost or priority", () => {
    registry.register(
      registration({
        priority: 1,
        models: [model("openrouter", "no-tools", { capabilities: { tools: false } })],
      }),
    );
    registry.register(
      registration({
        id: "toolnet",
        kind: "toolnet",
        baseURL: "https://t",
        priority: 999,
        models: [model("toolnet", "with-tools", { capabilities: { tools: true } })],
      }),
    );

    const resolved = router.resolve({ requiredCapabilities: { tools: true } });
    expect(resolved.model.apiModelId).toBe("with-tools");
  });

  it("treats undefined capability as failing a required capability", () => {
    registry.register(registration({ models: [model("openrouter", "maybe", { capabilities: {} })] }));
    expect(() => router.resolve({ requiredCapabilities: { reasoning: true } })).toThrow(ModelRoutingError);
  });

  it("honours priority ordering", () => {
    registry.register(registration({ priority: 100, models: [model("openrouter", "low")] }));
    registry.register(registration({ id: "toolnet", kind: "toolnet", baseURL: "https://t", priority: 5, models: [model("toolnet", "high")] }));

    expect(router.resolve({ policy: "priority" }).model.id).toBe("toolnet/high");
  });

  it("honours cheapest ordering and sorts unknown prices last", () => {
    registry.register(
      registration({
        models: [
          model("openrouter", "pricey", { pricing: { input: 10, output: 30 } }),
          model("openrouter", "unknown-price"),
        ],
      }),
    );
    registry.register(
      registration({
        id: "toolnet",
        kind: "toolnet",
        baseURL: "https://t",
        models: [model("toolnet", "cheap", { pricing: { input: 1, output: 2 } })],
      }),
    );

    // Full chain ordering is only exposed when fallback is enabled.
    setRoutingConfig({ policy: "fallback" });
    const resolved = router.resolve({ policy: "cheapest" });
    expect(resolved.model.apiModelId).toBe("cheap");
    expect(resolved.candidates.map((c) => c.apiModelId)).toEqual(["cheap", "pricey", "unknown-price"]);
    // Unknown price never wins over a declared expensive one.
    expect(resolved.candidates[resolved.candidates.length - 1].apiModelId).toBe("unknown-price");
  });

  it("honours fastest ordering using observed latency", () => {
    registry.register(registration({ models: [model("openrouter", "slow")] }));
    registry.register(registration({ id: "toolnet", kind: "toolnet", baseURL: "https://t", models: [model("toolnet", "fast")] }));

    registry.recordSuccess("openrouter", 900);
    registry.recordSuccess("toolnet", 40);

    expect(router.resolve({ policy: "fastest" }).model.apiModelId).toBe("fast");
  });

  it("honours capability-first using preferred capabilities", () => {
    registry.register(
      registration({
        priority: 1,
        models: [model("openrouter", "plain", { capabilities: { tools: true } })],
      }),
    );
    registry.register(
      registration({
        id: "toolnet",
        kind: "toolnet",
        baseURL: "https://t",
        priority: 900,
        models: [model("toolnet", "reasoner", { capabilities: { tools: true, reasoning: true } })],
      }),
    );

    const resolved = router.resolve({
      policy: "capability-first",
      preferredCapabilities: { reasoning: true },
    });
    expect(resolved.model.apiModelId).toBe("reasoner");
  });

  it("excludes providers", () => {
    registry.register(registration({ priority: 1, models: [model("openrouter", "a")] }));
    registry.register(registration({ id: "toolnet", kind: "toolnet", baseURL: "https://t", priority: 2, models: [model("toolnet", "b")] }));

    expect(router.resolve({ excludedProviders: ["openrouter"] }).provider.id).toBe("toolnet");
  });

  it("skips disabled providers", () => {
    registry.register(registration({ models: [model("openrouter", "a")] }));
    registry.register(registration({ id: "toolnet", kind: "toolnet", baseURL: "https://t", models: [model("toolnet", "b")] }));
    registry.setEnabled("openrouter", false);

    expect(router.resolve({ policy: "priority" }).provider.id).toBe("toolnet");
  });

  it("reports a structured error when no candidate exists", () => {
    registry.register(registration({ models: [] }));
    expect(() => router.resolve({ policy: "priority" })).toThrow(ModelRoutingError);
  });

  it("applies a cost limit", () => {
    registry.register(
      registration({ models: [model("openrouter", "expensive", { pricing: { input: 50, output: 50 } })] }),
    );
    registry.register(
      registration({
        id: "toolnet",
        kind: "toolnet",
        baseURL: "https://t",
        models: [model("toolnet", "affordable", { pricing: { input: 1, output: 1 } })],
      }),
    );

    const resolved = router.resolve({ costLimit: 10 });
    expect(resolved.model.apiModelId).toBe("affordable");
  });

  it("exposes the full candidate chain only when fallback is enabled", () => {
    registry.register(registration({ models: [model("openrouter", "primary"), model("openrouter", "secondary")] }));

    expect(router.resolve({ model: "openrouter/primary" }).candidates).toHaveLength(1);

    setRoutingConfig({ policy: "fallback", fallback: ["openrouter/secondary"] });
    const resolved = router.resolve({ model: "openrouter/primary" });
    expect(resolved.candidates.map((c) => c.apiModelId)).toEqual(["primary", "secondary"]);
    expect(resolved.routingReason).toContain("fallback policy enabled");
  });

  it("ignores unresolvable fallback entries instead of failing", () => {
    registry.register(registration({ models: [model("openrouter", "primary")] }));
    setRoutingConfig({ policy: "fallback", fallback: ["ghost/nope"] });

    const resolved = router.resolve({ model: "openrouter/primary" });
    expect(resolved.model.apiModelId).toBe("primary");
    expect(resolved.candidates).toHaveLength(1);
  });

  it("refuses to route after cancellation", () => {
    registry.register(registration({ models: [model("openrouter", "a")] }));
    const controller = new AbortController();
    controller.abort();
    expect(() => router.resolve({ model: "openrouter/a", signal: controller.signal })).toThrow(ModelRoutingError);
  });

  it("is deterministic across repeated resolutions", () => {
    registry.register(registration({ priority: 10, models: [model("openrouter", "b"), model("openrouter", "a")] }));
    registry.register(registration({ id: "toolnet", kind: "toolnet", baseURL: "https://t", priority: 10, models: [model("toolnet", "c")] }));

    const first = router.resolve({ policy: "priority" }).model.id;
    for (let i = 0; i < 5; i++) {
      expect(router.resolve({ policy: "priority" }).model.id).toBe(first);
    }
    expect(first).toBe("openrouter/a");
  });
});
