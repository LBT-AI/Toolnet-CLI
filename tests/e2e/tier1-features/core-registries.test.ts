import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { modelCatalog, modelRouter, providerRegistry, bootstrapProviderRegistry } from "../../../src/core/models";
import { repositoryIntelligence } from "../../../src/core/repo/intelligence";

describe("Tier 1 Feature Coverage: Core Singletons & Registries Integration", () => {
  beforeAll(async () => {
    await bootstrapProviderRegistry();
    // Register canonical test models
    modelCatalog.add({
      id: "toolnet/gpt-4o",
      providerId: "toolnet",
      apiModelId: "gpt-4o",
      displayName: "GPT-4o",
      status: "active",
      contextWindow: 128000,
      maxOutputTokens: 4096,
      pricing: { input: 5, output: 15 },
      capabilities: { streaming: true, tools: true, vision: true },
    });
  });

  // The catalog is a process-wide singleton: without this cleanup, the
  // fixture leaks into later suites in the same run (e.g. context budget
  // tests) and changes which limits resolve for "gpt-4o".
  afterAll(() => {
    modelCatalog.remove("toolnet/gpt-4o");
  });

  it("F5.1: ModelCatalog registers, queries, and lists models", () => {
    const models = modelCatalog.list();
    expect(models.length).toBeGreaterThan(0);

    const gpt4 = modelCatalog.get("toolnet/gpt-4o");
    expect(gpt4).toBeDefined();
    expect(gpt4?.providerId).toBe("toolnet");
    expect(gpt4?.capabilities.tools).toBe(true);
  });

  it("F5.2: ModelRouter resolves model references to candidates through candidateChain", () => {
    const chain = modelRouter.candidateChain({ model: "toolnet/gpt-4o" });
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0].providerId).toBe("toolnet");
  });

  it("F6.1: ProviderRegistry enumerates all registered providers", () => {
    const providers = providerRegistry.list();
    expect(providers.length).toBeGreaterThan(0);

    const ids = providerRegistry.ids();
    expect(ids.length).toBeGreaterThan(0);
    expect(providerRegistry.has(ids[0])).toBe(true);
  });

  it("F6.2: ProviderRegistry tracks provider status and definitions", () => {
    const ids = providerRegistry.ids();
    const providerId = ids[0];
    const provider = providerRegistry.get(providerId);

    expect(provider).toBeDefined();
    expect(provider?.id).toBe(providerId);
  });

  it("F7.1: RepositoryIntelligence returns compact context with detected project root and git VCS", async () => {
    const cwd = process.cwd();
    const context = await repositoryIntelligence.getCompactContext(cwd);

    expect(context).toBeDefined();
    expect(context.profile).toBeDefined();
    expect(context.profile.root).toBe(cwd);
    expect(context.profile.vcs).toBe("git");
    expect(Array.isArray(context.profile.languages)).toBe(true);
    expect(context.profile.languages).toContain("typescript");
  });

  it("F7.2: RepositoryIntelligence determines change impact for user prompts", async () => {
    const cwd = process.cwd();
    const impact = await repositoryIntelligence.determineChangeImpact("refactor src/tui/layout.ts", cwd);

    expect(impact).toBeDefined();
    expect(Array.isArray(impact.primaryFiles)).toBe(true);
    expect(impact.primaryFiles).toContain("src/tui/layout.ts");
    expect(impact.risk).toBeDefined();
  });
});
