import { afterEach, describe, expect, it } from "bun:test";
import { ModelCatalog } from "../catalog";
import { ProviderRegistry } from "../registry";
import { refreshProvider } from "../discovery";
import { createFakeOpenAiServer, type FakeOpenAiServer } from "./helpers/fakeOpenRouterServer";

let server: FakeOpenAiServer | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/**
 * Regression: discovery used to gate on `instance instanceof OpenRouterProvider`.
 * The provider factory builds adapters through `require` while the discovery
 * module imported the class through ESM, so the two identities could differ and
 * the raw OpenRouter discovery silently returned an EMPTY catalog.
 */
describe("Phase 80 — OpenRouter discovery through refresh", () => {
  it("fetches and normalizes models from the provider's raw catalogue", async () => {
    server = createFakeOpenAiServer({
      models: ["fixture/model-a"],
      openRouter: true,
    });

    const catalog = new ModelCatalog();
    const registry = new ProviderRegistry(catalog);
    registry.register(
      {
        id: "openrouter",
        kind: "openrouter",
        baseURL: server.url,
        authentication: { apiKeyEnv: "OPENROUTER_API_KEY", scheme: "bearer", hasApiKey: true },
      },
      { skipModels: true },
    );

    const result = await refreshProvider("openrouter", { registry });
    expect(result.ok).toBe(true);
    expect(result.modelCount).toBeGreaterThan(0);
    expect(server.callCount()).toBeGreaterThan(0);

    const models = catalog.listByProvider("openrouter");
    expect(models.map((model) => model.apiModelId)).toContain("fixture/model-a");
    // OpenRouter capability declarations must survive normalization.
    expect(models[0].capabilities.tools).toBe(true);
  });

  it("preserves the previous catalogue when discovery fails", async () => {
    server = createFakeOpenAiServer({ models: [], failWithStatus: 500, openRouter: true });

    const catalog = new ModelCatalog();
    const registry = new ProviderRegistry(catalog);
    registry.register(
      {
        id: "openrouter",
        kind: "openrouter",
        baseURL: server.url,
        models: [
          {
            id: "openrouter/previous-model",
            providerId: "openrouter",
            apiModelId: "previous-model",
            capabilities: { tools: true },
            status: "active",
          },
        ],
      },
      { replace: true },
    );

    const result = await refreshProvider("openrouter", { registry });
    expect(result.ok).toBe(false);
    expect(result.preservedPrevious).toBe(true);
    expect(catalog.listByProvider("openrouter").map((model) => model.apiModelId)).toEqual(["previous-model"]);
  });
});
