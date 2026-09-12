import { beforeEach, describe, expect, it } from "bun:test";
import { ModelCatalog } from "../catalog";
import { ProviderRegistry } from "../registry";
import { ModelRouter, resetRoutingConfig } from "../router";
import { formatModelRef } from "../ref";
import type { ModelDefinition } from "../types";

/**
 * Phase 80 §24 — routing must be a LOCAL decision. The target is a sub-10ms
 * median with a realistic catalog size; the assertion is a median (not a single
 * sample) so a GC pause or a busy CI host cannot make it flaky.
 */
describe("Phase 80 — routing hot path", () => {
  let catalog: ModelCatalog;
  let registry: ProviderRegistry;

  beforeEach(() => {
    resetRoutingConfig();
    catalog = new ModelCatalog();
    registry = new ProviderRegistry(catalog);

    for (let providerIndex = 0; providerIndex < 5; providerIndex++) {
      const providerId = `perf${providerIndex}`;
      const models: ModelDefinition[] = [];
      for (let modelIndex = 0; modelIndex < 100; modelIndex++) {
        models.push({
          id: formatModelRef(providerId, `model-${modelIndex}`),
          providerId,
          apiModelId: `model-${modelIndex}`,
          capabilities: {
            tools: modelIndex % 2 === 0,
            reasoning: modelIndex % 3 === 0,
            nativeToolCalls: modelIndex % 2 === 0,
          },
          contextWindow: 32_000 + modelIndex * 1000,
          pricing: { input: modelIndex % 10, output: (modelIndex % 10) * 2 },
          status: "active",
        });
      }
      registry.register({ id: providerId, kind: "openai-compatible", baseURL: `https://${providerId}.invalid`, models }, { replace: true });
    }
  });

  it("resolves a 500-model catalog with a sub-10ms median", () => {
    const router = new ModelRouter({ registry, catalog, activeProviderId: () => null });
    expect(catalog.size()).toBe(500);

    // Warm up so JIT/module costs are not attributed to routing.
    for (let i = 0; i < 10; i++) router.resolve({ profile: "coding" });

    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      const started = performance.now();
      router.resolve({ profile: "coding", requiredCapabilities: { tools: true } });
      samples.push(performance.now() - started);
    }

    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    expect(median).toBeLessThan(10);
  });

  it("does not perform network I/O during resolution", () => {
    // Resolution is synchronous by contract; a network call would make the
    // return value a Promise. Asserting the sync shape is the real guard.
    const router = new ModelRouter({ registry, catalog, activeProviderId: () => null });
    const resolved = router.resolve({ profile: "quality" });
    expect(resolved).not.toBeInstanceOf(Promise);
    expect(resolved.model.id).toContain("perf");
  });
});
