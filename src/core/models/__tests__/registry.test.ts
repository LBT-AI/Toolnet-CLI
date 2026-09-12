import { beforeEach, describe, expect, it } from "bun:test";
import { ModelCatalog } from "../catalog";
import { ProviderRegistry } from "../registry";
import { DuplicateProviderError, ModelNotFoundError, ProviderNotFoundError } from "../errors";
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
    name: "OpenRouter",
    kind: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    ...overrides,
  };
}

describe("Phase 79 — ProviderRegistry", () => {
  let catalog: ModelCatalog;
  let registry: ProviderRegistry;

  beforeEach(() => {
    catalog = new ModelCatalog();
    registry = new ProviderRegistry(catalog);
  });

  it("registers a provider and indexes its models", () => {
    registry.register(
      registration({ models: [model("openrouter", "anthropic/claude-sonnet"), model("openrouter", "openai/gpt-4o")] }),
    );
    expect(registry.has("openrouter")).toBe(true);
    expect(registry.get("openrouter")?.models).toEqual([
      "openrouter/anthropic/claude-sonnet",
      "openrouter/openai/gpt-4o",
    ]);
    expect(catalog.size()).toBe(2);
  });

  it("rejects a duplicate registration and allows an explicit replace", () => {
    registry.register(registration());
    expect(() => registry.register(registration())).toThrow(DuplicateProviderError);

    const replacement = registry.register(registration({ name: "OpenRouter v2" }), { replace: true });
    expect(replacement.name).toBe("OpenRouter v2");
    expect(registry.size()).toBe(1);
  });

  it("unregisters a provider and withdraws its models", () => {
    registry.register(registration({ models: [model("openrouter", "m")] }));
    expect(registry.unregister("openrouter")).toBe(true);
    expect(registry.unregister("openrouter")).toBe(false);
    expect(registry.get("openrouter")).toBeUndefined();
    expect(catalog.size()).toBe(0);
    expect(registry.healthOf("openrouter").requestCount).toBe(0);
  });

  it("normalizes ids (case and whitespace)", () => {
    registry.register(registration({ id: "  OpenRouter  " }));
    expect(registry.get("OPENROUTER")?.id).toBe("openrouter");
    expect(registry.get("openrouter")).toBeDefined();
  });

  it("lists enabled providers in deterministic priority order", () => {
    registry.register(registration({ id: "b", priority: 50 }));
    registry.register(registration({ id: "a", priority: 10 }));
    registry.register(registration({ id: "c", priority: 10 }));
    registry.register(registration({ id: "d", priority: 1, enabled: false }));

    expect(registry.enabled().map((p) => p.id)).toEqual(["a", "c", "b"]);
    expect(registry.list().map((p) => p.id).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("tracks disabled status without losing the registration", () => {
    registry.register(registration());
    registry.setEnabled("openrouter", false);
    expect(registry.get("openrouter")?.status).toBe("disabled");
    expect(registry.enabled()).toEqual([]);

    registry.setEnabled("openrouter", true);
    expect(registry.get("openrouter")?.status).toBe("unknown");
  });

  it("resolves a qualified reference and rejects unknown ids/models", () => {
    registry.register(registration({ models: [model("openrouter", "anthropic/claude-sonnet")] }));

    const resolved = registry.resolve({ raw: "openrouter/anthropic/claude-sonnet", providerId: "openrouter", modelId: "anthropic/claude-sonnet" });
    expect(resolved.provider.id).toBe("openrouter");
    expect(resolved.model.apiModelId).toBe("anthropic/claude-sonnet");

    expect(() => registry.resolve({ raw: "nope/x", providerId: "nope", modelId: "x" })).toThrow(ProviderNotFoundError);
    expect(() =>
      registry.resolve({ raw: "openrouter/nope", providerId: "openrouter", modelId: "nope" }),
    ).toThrow(ModelNotFoundError);
  });

  it("resolves an unqualified reference only when it is unambiguous", () => {
    registry.register(registration({ models: [model("openrouter", "anthropic/claude")] }));
    registry.register(
      registration({ id: "toolnet", kind: "toolnet", baseURL: "https://api.toolnet.tech/v1", models: [model("toolnet", "alims-intl.llm")] }),
    );

    const unique = registry.resolve({ raw: "anthropic/claude", modelId: "anthropic/claude" });
    expect(unique.provider.id).toBe("openrouter");

    registry.register(
      registration({ id: "other", kind: "custom", baseURL: "https://x", models: [model("other", "anthropic/claude")] }),
    );
    expect(() => registry.resolve({ raw: "anthropic/claude", modelId: "anthropic/claude" })).toThrow(ModelNotFoundError);
  });

  it("replaces a provider's models atomically via replaceModels", () => {
    registry.register(registration({ models: [model("openrouter", "a")] }));
    registry.replaceModels("openrouter", [model("openrouter", "b"), model("openrouter", "c")]);
    expect(registry.modelsOf("openrouter")).toEqual(["openrouter/b", "openrouter/c"]);
  });

  it("refuses to add models for an unregistered provider", () => {
    expect(registry.addModels("ghost", [model("ghost", "m")])).toEqual([]);
    expect(registry.replaceModels("ghost", [model("ghost", "m")])).toEqual([]);
  });

  it("records health per provider", () => {
    registry.register(registration());
    registry.recordSuccess("openrouter", 120);
    expect(registry.healthOf("openrouter").successCount).toBe(1);
    registry.recordFailure("openrouter", "boom");
    expect(registry.healthOf("openrouter").consecutiveFailures).toBe(1);
    registry.resetHealth("openrouter");
    expect(registry.healthOf("openrouter").successCount).toBe(0);
  });
});
