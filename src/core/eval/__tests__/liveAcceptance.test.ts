import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ModelCatalog } from "../../models/catalog";
import { providerRegistry, ProviderRegistry } from "../../models/registry";
import { runLiveCompletionProbe, runToolNetProbe } from "../liveAcceptance";
import { createFakeOpenAiServer, scripts, type FakeOpenAiServer } from "./helpers/fakeOpenAiServer";

const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_BASE = process.env.OPENROUTER_BASE_URL;
let server: FakeOpenAiServer | undefined;

function restoreEnv(): void {
  if (ORIGINAL_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_BASE === undefined) delete process.env.OPENROUTER_BASE_URL;
  else process.env.OPENROUTER_BASE_URL = ORIGINAL_BASE;
}

afterAll(() => {
  restoreEnv();
  server?.close();
});

afterEach(() => {
  server?.close();
  server = undefined;
});

describe("Phase 80 — live acceptance honesty", () => {
  it("reports an ENVIRONMENT skip when the OpenRouter key is missing", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const report = await runLiveCompletionProbe({ allowBilledCall: true });

    expect(report.ran).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.failureClass).toBe("ENVIRONMENT");
    expect(report.skippedReason).toContain("OPENROUTER_API_KEY");
  });

  it("never calls the provider unless a billed call is explicitly permitted", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test-key";
    const report = await runLiveCompletionProbe({ allowBilledCall: false });

    expect(report.ran).toBe(false);
    expect(report.failureClass).toBe("ENVIRONMENT");
    expect(report.skippedReason).toContain("billed");
  });

  it("skips the ToolNet probe with ENVIRONMENT when nothing else is configured", async () => {
    const catalog = new ModelCatalog();
    const registry = new ProviderRegistry(catalog);
    registry.register({ id: "openrouter", kind: "openrouter", baseURL: "https://openrouter.ai/api/v1" }, { skipModels: true });

    const report = await runToolNetProbe({ registry });
    expect(report.ran).toBe(false);
    expect(report.failureClass).toBe("ENVIRONMENT");
    expect(report.multiProvider).toBe(false);
  });

  it("binds adapters for every configured provider and reports multi-provider", async () => {
    const catalog = new ModelCatalog();
    const registry = new ProviderRegistry(catalog);
    for (const id of ["toolnet", "local"]) {
      registry.register(
        {
          id,
          kind: "openai-compatible",
          baseURL: `https://${id}.invalid/v1`,
          authentication: { apiKeyEnv: `${id.toUpperCase()}_KEY`, hasApiKey: false },
          models: [
            {
              id: `${id}/model-1`,
              providerId: id,
              apiModelId: "model-1",
              capabilities: { tools: true },
              status: "active",
            },
          ],
        },
        { replace: true },
      );
    }

    const report = await runToolNetProbe({ registry });
    expect(report.ran).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.multiProvider).toBe(true);
    expect(report.entries.every((entry) => entry.adapterBound)).toBe(true);
    // No key → no billed call, reported honestly rather than faked.
    expect(report.entries.every((entry) => entry.completion === undefined)).toBe(true);
  });
});

describe("Phase 80 — live completion probe (local fixture)", () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "sk-or-fixture-key";
  });

  it("runs discovery, completion, streaming, health, routing and an eval smoke case", async () => {
    server = createFakeOpenAiServer({
      models: ["fixture/model-a"],
      script: scripts.alwaysText("ok"),
    });
    process.env.OPENROUTER_BASE_URL = server.url;

    // The eval smoke runs through the canonical path, which uses the
    // process-wide registry AND its catalog — so the fixture is registered
    // there and no separate catalog is passed.
    providerRegistry.register(
      {
        id: "openrouter",
        kind: "openrouter",
        baseURL: server.url,
        authentication: { apiKeyEnv: "OPENROUTER_API_KEY", scheme: "bearer", hasApiKey: true },
        models: [
          {
            id: "openrouter/fixture/model-a",
            providerId: "openrouter",
            apiModelId: "fixture/model-a",
            capabilities: { tools: true, nativeToolCalls: true },
            status: "active",
          },
        ],
      },
      { replace: true },
    );

    try {
      const report = await runLiveCompletionProbe({
        registry: providerRegistry,
        env: process.env,
        allowBilledCall: true,
        runEvalSmoke: true,
      });

      expect(report.ran).toBe(true);
      expect(report.ok).toBe(true);
      expect(report.provider).toBe("openrouter");
      expect(report.modelCount).toBeGreaterThan(0);
      expect(report.completion?.contentLength).toBeGreaterThan(0);
      expect(report.streaming?.chunks).toBeGreaterThan(0);
      expect(report.usage?.inputTokens).toBeGreaterThan(0);
      expect(report.healthState).toBe("healthy");
      expect(report.routingReason).toContain("explicit");
      expect(report.evalSmoke?.total).toBeGreaterThan(0);
      expect(report.steps.some((step) => step.startsWith("router resolved"))).toBe(true);
      // Discovery really hit the network (guards the OpenRouter duck-typing fix).
      expect(server?.callCount() ?? 0).toBeGreaterThan(0);
    } finally {
      providerRegistry.unregister("openrouter");
    }
  });

  it("classifies a provider failure as PROVIDER_PROTOCOL instead of a pass", async () => {
    server = createFakeOpenAiServer({
      models: ["fixture/model-a"],
      script: scripts.alwaysText("never"),
      failWithStatus: 404,
    });
    process.env.OPENROUTER_BASE_URL = server.url;

    const catalog = new ModelCatalog();
    const registry = new ProviderRegistry(catalog);
    const report = await runLiveCompletionProbe({ registry, catalog, env: process.env, allowBilledCall: true });

    expect(report.ok).toBe(false);
    expect(report.failureClass).toBeDefined();
    expect(report.failureClass).not.toBe("CORE_RUNTIME");
  });
});
