import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ModelCatalog } from "../catalog";
import { ProviderRegistry } from "../registry";
import { classifyRefreshError, normalizeListedModel, refreshAllProviders, refreshProvider } from "../discovery";
import type { ModelDefinition, ProviderRegistration } from "../types";
import { formatModelRef } from "../ref";

function model(providerId: string, apiModelId: string): ModelDefinition {
  return {
    id: formatModelRef(providerId, apiModelId),
    providerId,
    apiModelId,
    capabilities: {},
    status: "active",
  };
}

function registration(overrides: Partial<ProviderRegistration> = {}): ProviderRegistration {
  return {
    id: "openrouter",
    kind: "openrouter",
    baseURL: "https://openrouter.example/api/v1",
    ...overrides,
  };
}

describe("Phase 79 — discovery normalization", () => {
  it("preserves tools and nativeToolCalls from gateway metadata", () => {
    const gateway = normalizeListedModel(
      {
        id: "alims-intl.llm",
        name: "Alibaba Intl LLM",
        object: "model",
        created: 0,
        owned_by: "combo",
        capabilities: { reasoning: true, tools: true, nativeToolCalls: false, vision: true, streaming: true },
      },
      "toolnet",
    );

    expect(gateway).not.toBeNull();
    expect(gateway!.capabilities.tools).toBe(true);
    expect(gateway!.capabilities.nativeToolCalls).toBe(false);
    expect(gateway!.capabilities.reasoning).toBe(true);
    expect(gateway!.capabilities.vision).toBe(true);
  });

  it("keeps undeclared capabilities unknown for a plain listing", () => {
    const listed = normalizeListedModel(
      { id: "plain-model", object: "model", created: 0, owned_by: "vendor" },
      "vendor",
    );
    expect(listed!.capabilities.tools).toBeUndefined();
    expect(listed!.capabilities.reasoning).toBeUndefined();
  });

  it("declines a listing row without an id", () => {
    expect(normalizeListedModel({ id: "" } as never, "p")).toBeNull();
  });

  it("classifies refresh errors by cause", () => {
    expect(classifyRefreshError(new Error("HTTP 401: nope")).errorClass).toBe("auth");
    expect(classifyRefreshError(new Error("HTTP 404: nope")).errorClass).toBe("not-found");
    expect(classifyRefreshError(new Error("HTTP 429: slow")).errorClass).toBe("rate-limit");
    expect(classifyRefreshError(new Error("HTTP 503: down")).errorClass).toBe("network");
    expect(classifyRefreshError(new Error("fetch failed")).errorClass).toBe("network");
    expect(classifyRefreshError(new Error("invalid json")).errorClass).toBe("protocol");
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    expect(classifyRefreshError(timeout).errorClass).toBe("cancelled");
    expect(classifyRefreshError(new Error("weird")).errorClass).toBe("unknown");
  });
});

describe("Phase 79 — refresh atomicity", () => {
  let catalog: ModelCatalog;
  let registry: ProviderRegistry;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    catalog = new ModelCatalog();
    registry = new ProviderRegistry(catalog);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("replaces the provider catalog on success and marks it connected", async () => {
    registry.register(registration({ models: [model("openrouter", "stale")] }));
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ id: "anthropic/claude", supported_parameters: ["tools"] }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await refreshProvider("openrouter", { registry });
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBe(1);
    expect(catalog.get("openrouter/anthropic/claude")).toBeDefined();
    expect(catalog.get("openrouter/stale")).toBeUndefined();
    expect(registry.get("openrouter")?.status).toBe("connected");
    expect(registry.healthOf("openrouter").state).toBe("healthy");
  });

  it("preserves the previous catalog when refresh fails", async () => {
    registry.register(registration({ models: [model("openrouter", "stable")] }));
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const result = await refreshProvider("openrouter", { registry });
    expect(result.ok).toBe(false);
    expect(result.preservedPrevious).toBe(true);
    expect(result.errorClass).toBe("network");
    expect(catalog.get("openrouter/stable")).toBeDefined();
    expect(registry.healthOf("openrouter").failureCount).toBe(1);
  });

  it("treats an empty listing as a failure rather than wiping the catalog", async () => {
    registry.register(registration({ models: [model("openrouter", "stable")] }));
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;

    const result = await refreshProvider("openrouter", { registry });
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe("protocol");
    expect(catalog.get("openrouter/stable")).toBeDefined();
  });

  it("reports a missing provider without throwing", async () => {
    const result = await refreshProvider("ghost", { registry });
    expect(result.ok).toBe(false);
    expect(result.errorClass).toBe("not-found");
  });

  it("isolates a failing provider from a healthy one", async () => {
    registry.register(registration({ id: "a", kind: "openai-compatible", baseURL: "https://a.example/v1", priority: 1 }));
    registry.register(registration({ id: "b", kind: "openai-compatible", baseURL: "https://b.example/v1", priority: 2 }));

    globalThis.fetch = (async (url: string | URL | Request) => {
      const target = String(url);
      if (target.startsWith("https://a.example")) {
        return new Response(JSON.stringify({ data: [{ id: "a-model", owned_by: "a" }] }), { status: 200 });
      }
      return new Response("down", { status: 500 });
    }) as unknown as typeof fetch;

    const results = await refreshAllProviders({ registry });
    const byId = Object.fromEntries(results.map((r) => [r.providerId, r]));

    expect(byId["a"].ok).toBe(true);
    expect(byId["b"].ok).toBe(false);
    expect(catalog.get("a/a-model")).toBeDefined();
    expect(catalog.listByProvider("b")).toEqual([]);
    expect(registry.healthOf("a").state).toBe("healthy");
    expect(registry.healthOf("b").failureCount).toBe(1);
  });

  it("skips disabled providers during a bulk refresh", async () => {
    registry.register(registration({ id: "a", kind: "openai-compatible", baseURL: "https://a.example/v1" }));
    registry.register(registration({ id: "b", kind: "openai-compatible", baseURL: "https://b.example/v1", enabled: false }));

    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: [{ id: "m", owned_by: "x" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const results = await refreshAllProviders({ registry });
    expect(results.map((r) => r.providerId)).toEqual(["a"]);
    expect(calls).toBe(1);
  });
});
