import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ModelCatalog } from "../catalog";
import { ProviderRegistry } from "../registry";
import { ModelRouter, invokeWithFallback, isRetryableFailure, resetRoutingConfig, setRoutingConfig } from "../router";
import {
  ModelCapabilityError,
  ModelRoutingError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from "../errors";
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

describe("Phase 79 — fallback classification", () => {
  it("retries transient failures", () => {
    expect(isRetryableFailure(new ProviderRateLimitError("p"))).toBe(true);
    expect(isRetryableFailure(new ProviderUnavailableError("p"))).toBe(true);
    expect(isRetryableFailure(new Error("HTTP 503: upstream down"))).toBe(true);
    expect(isRetryableFailure(new Error("HTTP 502 Bad Gateway"))).toBe(true);
    expect(isRetryableFailure(new Error("HTTP 429: slow down"))).toBe(true);
    expect(isRetryableFailure(new Error("fetch failed"))).toBe(true);
    expect(isRetryableFailure(new Error("read ECONNRESET"))).toBe(true);
    expect(isRetryableFailure(new Error("request timeout after 30s"))).toBe(true);
  });

  it("never retries terminal failures", () => {
    expect(isRetryableFailure(new ProviderAuthError("p"))).toBe(false);
    expect(isRetryableFailure(new ModelCapabilityError("m", ["tools"]))).toBe(false);
    expect(isRetryableFailure(new Error("HTTP 401: unauthorized"))).toBe(false);
    expect(isRetryableFailure(new Error("HTTP 403: forbidden"))).toBe(false);
    expect(isRetryableFailure(new Error("HTTP 400: invalid request"))).toBe(false);
    expect(isRetryableFailure(new Error("HTTP 422: invalid tool schema"))).toBe(false);
    expect(isRetryableFailure(new Error("Permission Denied"))).toBe(false);
    expect(isRetryableFailure(new Error("authentication failed"))).toBe(false);
  });

  it("never retries cancellation", () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    expect(isRetryableFailure(aborted)).toBe(false);
    expect(isRetryableFailure(new Error("Request cancelled by user"))).toBe(false);
  });

  it("treats an unknown error as terminal (fails closed)", () => {
    expect(isRetryableFailure(new Error("something unusual"))).toBe(false);
    expect(isRetryableFailure("a string")).toBe(false);
  });
});

describe("Phase 79 — bounded fallback execution", () => {
  let catalog: ModelCatalog;
  let registry: ProviderRegistry;
  let router: ModelRouter;

  beforeEach(() => {
    catalog = new ModelCatalog();
    registry = new ProviderRegistry(catalog);
    router = new ModelRouter({ registry, catalog, activeProviderId: () => null });
    resetRoutingConfig();
    setRoutingConfig({ policy: "fallback", fallback: [], maxAttempts: 3 });
  });

  afterEach(() => {
    resetRoutingConfig();
  });

  function register(overrides: Partial<ProviderRegistration> & { id: string }): void {
    registry.register({
      name: overrides.id,
      kind: "custom",
      baseURL: `https://${overrides.id}`,
      ...overrides,
    });
  }

  it("falls back to the next candidate on a retryable failure", async () => {
    register({ id: "a", kind: "custom", baseURL: "https://a", priority: 1, models: [model("a", "primary")] });
    register({ id: "b", kind: "custom", baseURL: "https://b", priority: 2, models: [model("b", "backup")] });

    const attempted: string[] = [];
    const result = await invokeWithFallback(
      { policy: "fallback", model: "a/primary" },
      async (resolved) => {
        attempted.push(resolved.model.id);
        if (resolved.model.providerId === "a") throw new Error("HTTP 503: unavailable");
        return resolved.model.id;
      },
      { router, registry },
    );

    expect(result.result).toBe("b/backup");
    expect(attempted).toEqual(["a/primary", "b/backup"]);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0].retryable).toBe(true);
    expect(result.attempts[1].ok).toBe(true);
  });

  it("does not fall back on an auth failure", async () => {
    register({ id: "a", kind: "custom", baseURL: "https://a", models: [model("a", "primary")] });
    register({ id: "b", kind: "custom", baseURL: "https://b", models: [model("b", "backup")] });

    const attempted: string[] = [];
    await expect(
      invokeWithFallback(
        { policy: "fallback", model: "a/primary" },
        async (resolved) => {
          attempted.push(resolved.model.id);
          throw new Error("HTTP 401: unauthorized");
        },
        { router, registry },
      ),
    ).rejects.toThrow(/401/);

    expect(attempted).toEqual(["a/primary"]);
  });

  it("does not fall back on cancellation", async () => {
    register({ id: "a", kind: "custom", baseURL: "https://a", models: [model("a", "primary")] });
    register({ id: "b", kind: "custom", baseURL: "https://b", models: [model("b", "backup")] });

    const attempted: string[] = [];
    await expect(
      invokeWithFallback(
        { policy: "fallback", model: "a/primary" },
        async (resolved) => {
          attempted.push(resolved.model.id);
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        },
        { router, registry },
      ),
    ).rejects.toThrow(/aborted/);

    expect(attempted).toEqual(["a/primary"]);
  });

  it("never exceeds maxAttempts", async () => {
    register({
      id: "a",
      kind: "custom",
      baseURL: "https://a",
      models: [model("a", "m1"), model("a", "m2"), model("a", "m3"), model("a", "m4")],
    });

    const attempted: string[] = [];
    await expect(
      invokeWithFallback(
        { policy: "fallback", model: "a/m1" },
        async (resolved) => {
          attempted.push(resolved.model.id);
          throw new Error("HTTP 503: down");
        },
        { router, registry, maxAttempts: 2 },
      ),
    ).rejects.toThrow(/503/);

    expect(attempted).toHaveLength(2);
  });

  it("records health per attempt", async () => {
    register({ id: "a", kind: "custom", baseURL: "https://a", priority: 1, models: [model("a", "primary")] });
    register({ id: "b", kind: "custom", baseURL: "https://b", priority: 2, models: [model("b", "backup")] });

    await invokeWithFallback(
      { policy: "fallback", model: "a/primary" },
      async (resolved) => {
        if (resolved.model.providerId === "a") throw new Error("HTTP 503: down");
        return "ok";
      },
      { router, registry },
    );

    expect(registry.healthOf("a").failureCount).toBe(1);
    expect(registry.healthOf("b").successCount).toBe(1);
    expect(registry.healthOf("b").state).toBe("healthy");
  });

  it("surfaces the last error when every attempt fails", async () => {
    register({ id: "a", kind: "custom", baseURL: "https://a", models: [model("a", "m1"), model("a", "m2")] });

    await expect(
      invokeWithFallback(
        { policy: "fallback", model: "a/m1" },
        async () => {
          throw new Error("socket hang up");
        },
        { router, registry },
      ),
    ).rejects.toThrow(/socket hang up/);
  });

  it("refuses to route a request with no candidate", async () => {
    await expect(
      invokeWithFallback({ policy: "fallback", model: "ghost/none" }, async () => "never", { router, registry }),
    ).rejects.toThrow(ModelRoutingError);
  });
});
