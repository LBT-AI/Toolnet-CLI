import { afterEach, describe, expect, it } from "bun:test";
import { OpenRouterProvider } from "../../../providers/openrouter";
import { normalizeOpenRouterModel, normalizeOpenRouterModels, normalizeOpenRouterPricing } from "../openrouter";
import { classifyRefreshError } from "../discovery";

const REAL_RECORD = {
  id: "anthropic/claude-sonnet-4",
  name: "Anthropic: Claude Sonnet 4",
  description: "Fast and capable.",
  created: 1_700_000_000,
  context_length: 200_000,
  architecture: {
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    modality: "text+image->text",
  },
  pricing: { prompt: "0.000003", completion: "0.000015", input_cache_read: "0.0000003" },
  top_provider: { context_length: 200_000, max_completion_tokens: 64_000, is_moderated: false },
  supported_parameters: ["tools", "tool_choice", "reasoning", "response_format", "structured_outputs"],
};

describe("Phase 79 — OpenRouter normalization", () => {
  it("normalizes a real record without losing tool capabilities", () => {
    const model = normalizeOpenRouterModel(REAL_RECORD, "openrouter");
    expect(model).not.toBeNull();
    expect(model!.id).toBe("openrouter/anthropic/claude-sonnet-4");
    expect(model!.apiModelId).toBe("anthropic/claude-sonnet-4");
    expect(model!.capabilities.tools).toBe(true);
    expect(model!.capabilities.nativeToolCalls).toBe(true);
    expect(model!.capabilities.reasoning).toBe(true);
    expect(model!.capabilities.structuredOutput).toBe(true);
    expect(model!.capabilities.jsonMode).toBe(true);
    // Declared by architecture.input_modalities, not guessed from the id.
    expect(model!.capabilities.vision).toBe(true);
    expect(model!.capabilities.embeddings).toBeUndefined();
  });

  it("keeps unknown fields unknown instead of defaulting them to true", () => {
    const model = normalizeOpenRouterModel({ id: "vendor/mystery" }, "openrouter");
    expect(model!.capabilities.tools).toBeUndefined();
    expect(model!.capabilities.nativeToolCalls).toBeUndefined();
    expect(model!.contextWindow).toBeUndefined();
    expect(model!.pricing).toBeUndefined();
  });

  it("converts per-token pricing to USD per 1M tokens", () => {
    const pricing = normalizeOpenRouterPricing({ prompt: "0.000003", completion: "0.000015" });
    expect(pricing?.input).toBe(3);
    expect(pricing?.output).toBe(15);
    expect(pricing?.currency).toBe("USD");
  });

  it("treats -1 (not applicable) pricing as unknown, not negative", () => {
    expect(normalizeOpenRouterPricing({ prompt: "-1", completion: "-1" })).toBeUndefined();
    const model = normalizeOpenRouterModel({ id: "a/b", pricing: { prompt: "-1", completion: "-1" } }, "openrouter");
    expect(model!.pricing).toBeUndefined();
  });

  it("skips malformed records and keeps the good ones", () => {
    expect(normalizeOpenRouterModel(null, "openrouter")).toBeNull();
    expect(normalizeOpenRouterModel({}, "openrouter")).toBeNull();
    expect(normalizeOpenRouterModel({ id: 42 }, "openrouter")).toBeNull();

    const models = normalizeOpenRouterModels([REAL_RECORD, { id: 42 } as unknown, { id: "x/y" }], "openrouter");
    expect(models.map((m) => m.apiModelId)).toEqual(["anthropic/claude-sonnet-4", "x/y"]);
  });

  it("merges provider defaults underneath model declarations", () => {
    const model = normalizeOpenRouterModel({ id: "a/b" }, "openrouter", { streaming: true });
    expect(model!.capabilities.streaming).toBe(true);
  });

  it("records max output tokens from top_provider", () => {
    const model = normalizeOpenRouterModel(REAL_RECORD, "openrouter");
    expect(model!.maxOutputTokens).toBe(64_000);
    expect(model!.limits?.contextWindow).toBe(200_000);
  });
});

describe("Phase 79 — OpenRouter discovery", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function provider(): OpenRouterProvider {
    return new OpenRouterProvider({
      id: "openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.example/api/v1",
      apiKeyEnv: "PHASE79_UNSET_KEY",
    });
  }

  it("returns raw records from a successful listing", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ data: [REAL_RECORD] }), { status: 200 });
    }) as unknown as typeof fetch;

    const records = await provider().discoverModels();
    expect(seenUrl).toBe("https://openrouter.example/api/v1/models");
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("anthropic/claude-sonnet-4");
  });

  it("throws on an auth failure so the caller preserves the old catalog", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    await expect(provider().discoverModels()).rejects.toThrow(/HTTP 401/);
    expect(classifyRefreshError(new Error("OpenRouter model discovery failed: HTTP 401 — nope")).errorClass).toBe("auth");
  });

  it("returns an empty list for a malformed payload rather than inventing models", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ nope: true }), { status: 200 })) as unknown as typeof fetch;
    expect(await provider().discoverModels()).toEqual([]);
  });

  it("redacts an authorization header value from a thrown message", async () => {
    globalThis.fetch = (async () =>
      new Response(`upstream echoed sk-live-abcdefghijklmnopqrstuvwxyz0123`, { status: 500 })) as unknown as typeof fetch;
    let message = "";
    try {
      await provider().discoverModels();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    const { message: redacted } = classifyRefreshError(new Error(message));
    expect(redacted).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz0123");
  });
});
