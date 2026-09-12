import { afterAll, describe, expect, it } from "bun:test";
import { ModelCatalog } from "../catalog";
import { ProviderRegistry } from "../registry";
import { buildCatalogRows, classifyPricing, priceLabel, triState } from "../catalogView";
import { formatModelRef } from "../ref";
import type { ModelDefinition } from "../types";

const PROVIDER = "phase80view";

function model(apiModelId: string, extra: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id: formatModelRef(PROVIDER, apiModelId),
    providerId: PROVIDER,
    apiModelId,
    capabilities: {},
    status: "active",
    ...extra,
  };
}

const catalog = new ModelCatalog();
const registry = new ProviderRegistry(catalog);

registry.register(
  {
    id: PROVIDER,
    name: "Phase 80 View",
    kind: "openai-compatible",
    baseURL: "https://view.invalid/v1",
    models: [
      model("tool-model", {
        capabilities: { tools: true, reasoning: true },
        contextWindow: 200_000,
        pricing: { input: 3, output: 15 },
      }),
      model("plain-model", { capabilities: { tools: false }, contextWindow: 8_000 }),
      model("free-model", { capabilities: { tools: true }, pricing: { input: 0, output: 0 } }),
    ],
  },
  { replace: true },
);

afterAll(() => {
  registry.unregister(PROVIDER);
});

describe("Phase 80 — catalog view", () => {
  it("lists catalogue rows with health and pricing metadata", () => {
    const view = buildCatalogRows({ catalog, registry, filter: { provider: PROVIDER } });
    expect(view.rows).toHaveLength(3);
    const tool = view.rows.find((row) => row.apiModelId === "tool-model");
    expect(tool?.contextWindow).toBe(200_000);
    expect(tool?.capabilities.tools).toBe(true);
    expect(tool?.health).toBe("unknown");
  });

  it("filters by capability and never matches an unknown capability", () => {
    const view = buildCatalogRows({ catalog, registry, filter: { provider: PROVIDER, capability: "tools" } });
    expect(view.rows.map((row) => row.apiModelId).sort()).toEqual(["free-model", "tool-model"]);
  });

  it("filters free/paid and excludes unknown pricing from both", () => {
    const free = buildCatalogRows({ catalog, registry, filter: { provider: PROVIDER, pricing: "free" } });
    expect(free.rows.map((row) => row.apiModelId)).toEqual(["free-model"]);

    const paid = buildCatalogRows({ catalog, registry, filter: { provider: PROVIDER, pricing: "paid" } });
    expect(paid.rows.map((row) => row.apiModelId)).toEqual(["tool-model"]);
  });

  it("searches across id and display name", () => {
    const view = buildCatalogRows({ catalog, registry, filter: { provider: PROVIDER, search: "plain" } });
    expect(view.rows.map((row) => row.apiModelId)).toEqual(["plain-model"]);
  });

  it("reports the total before filtering", () => {
    const view = buildCatalogRows({ catalog, registry, filter: { provider: PROVIDER, search: "nomatch" } });
    expect(view.rows).toHaveLength(0);
    expect(view.totalBeforeFilter).toBeGreaterThanOrEqual(3);
  });

  it("renders tri-state capabilities without promoting unknown to yes", () => {
    expect(triState(true)).toBe("yes");
    expect(triState(false)).toBe("no");
    expect(triState(undefined)).toBe("unknown");
  });

  it("labels prices and classifies pricing origin", () => {
    expect(priceLabel({ input: 3, output: 15 })).toBe("3/15");
    expect(priceLabel(undefined)).toBe("—");
    expect(classifyPricing({ input: 0, output: 0 })).toBe("free");
    expect(classifyPricing({ input: 1, output: 0 })).toBe("paid");
    expect(classifyPricing(undefined)).toBe("unknown");
  });
});
