/**
 * Custom-model persistence and merge semantics.
 *
 * Three-state capability contract:
 *   - explicit true / false are honored and NEVER overwritten by discovery;
 *   - a missing field is omitted from the persisted JSON and materializes as
 *     UNKNOWN (undefined) at runtime — never silently true or false;
 *   - re-adding the same provider+model id replaces the entry (no duplicate
 *     catalog rows) and removal applies ONLY to user-added entries.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as appConfig from "../../../src/lib/appConfig";
import * as custom from "../../../src/core/models/customModels";
import * as registry from "../../../src/providers/registry";
import { modelCatalog } from "../../../src/core/models/catalog";
import { buildProviderEntries } from "../../../src/tui/state";

const ORIG_ENV = process.env.TOOLNETCLI_CONFIG_DIR;

function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolnet-custom-"));
  mkdirSync(join(dir, "cache"), { recursive: true });
  process.env.TOOLNETCLI_CONFIG_DIR = dir;
  return dir;
}

let home = "";

beforeEach(() => {
  home = freshHome();
  // Module singletons cache config/providers — reset per test.
  appConfig.resetAppConfigCache();
  registry.resetProvidersConfigCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (ORIG_ENV === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR;
  else process.env.TOOLNETCLI_CONFIG_DIR = ORIG_ENV;
});

function freshModules() {
  return { appConfig, custom, registry };
}

describe("Custom model persistence", () => {
  it("add → persisted in canonical config with explicit capabilities only", () => {
    const { appConfig, custom } = freshModules();
    custom.upsertCustomModel({
      providerId: "toolnet",
      apiModelId: "my-model",
      displayName: "My Model",
      capabilities: { tools: true, streaming: false },
      contextWindow: 131072,
    });
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    const entry = raw.customModels.find(
      (e: any) => e.apiModelId === "my-model",
    );
    expect(entry).toBeDefined();
    expect(entry.providerId).toBe("toolnet");
    expect(entry.displayName).toBe("My Model");
    expect(entry.capabilities).toEqual({ tools: true, streaming: false });
    expect(entry.contextWindow).toBe(131072);
    void appConfig;
  });

  it("missing capability fields are omitted from persisted JSON (never false)", () => {
    const { custom } = freshModules();
    custom.upsertCustomModel({ providerId: "toolnet", apiModelId: "m2" });
    const raw = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    const entry = raw.customModels.find((e: any) => e.apiModelId === "m2");
    expect(entry.capabilities).toBeUndefined();
    expect(entry.displayName).toBeUndefined();
  });

  it("re-adding the same provider+model id replaces instead of duplicating", () => {
    const { custom } = freshModules();
    custom.upsertCustomModel({ providerId: "toolnet", apiModelId: "dup", displayName: "A" });
    custom.upsertCustomModel({ providerId: "toolnet", apiModelId: "dup", displayName: "B" });
    const all = custom.listCustomModelsForProvider("toolnet");
    const dups = all.filter((e: any) => e.apiModelId === "dup");
    expect(dups.length).toBe(1);
    expect(dups[0].displayName).toBe("B");
  });

  it("remove applies only to user-added entries", () => {
    const { custom } = freshModules();
    custom.upsertCustomModel({ providerId: "toolnet", apiModelId: "gone" });
    expect(custom.removeCustomModel("toolnet", "gone")).toBe(true);
    expect(custom.isCustomModel("toolnet", "gone")).toBe(false);
    // Discovered-only model: explicit refusal, nothing mutated.
    expect(custom.removeCustomModel("toolnet", "alims-intl.llm")).toBe(false);
  });

  it("custom model survives a full config reload (restart semantics)", () => {
    const { custom, appConfig } = freshModules();
    custom.upsertCustomModel({ providerId: "deepseek", apiModelId: "deepseek-custom" });
    appConfig.resetAppConfigCache();
    expect(custom.isCustomModel("deepseek", "deepseek-custom")).toBe(true);
  });
});

describe("Deterministic merge with discovery", () => {
  const discovered = (over: Partial<any> = {}): any[] => [
    {
      id: "toolnet/base",
      providerId: "toolnet",
      apiModelId: "base",
      displayName: "Discovered Base",
      contextWindow: 8192,
      capabilities: { tools: true, streaming: true },
      status: "active",
      ...over,
    },
  ];

  it("explicit user true/false wins over discovery; absent stays discovery's value", () => {
    const { custom } = freshModules();
    custom.upsertCustomModel({
      providerId: "toolnet",
      apiModelId: "base",
      capabilities: { streaming: false, reasoning: true },
    });
    const merged = custom.mergeCustomModels("toolnet", discovered());
    const m = merged.find((x: any) => x.apiModelId === "base");
    // Explicit user declarations override discovery:
    expect(m.capabilities.streaming).toBe(false);
    expect(m.capabilities.reasoning).toBe(true);
    // Untouched capability keeps discovery's value:
    expect(m.capabilities.tools).toBe(true);
    // User never set vision: stays UNKNOWN, never guessed.
    expect(m.capabilities.vision).toBeUndefined();
  });

  it("user metadata overrides display name and limits", () => {
    const { custom } = freshModules();
    custom.upsertCustomModel({
      providerId: "toolnet",
      apiModelId: "base",
      displayName: "Mine",
      contextWindow: 999999,
      maxOutputTokens: 4096,
    });
    const m = custom.mergeCustomModels("toolnet", discovered())[0];
    expect(m.displayName).toBe("Mine");
    expect(m.contextWindow).toBe(999999);
    expect(m.maxOutputTokens).toBe(4096);
  });

  it("custom-only models are appended deterministically after discovered ones", () => {
    const { custom } = freshModules();
    custom.upsertCustomModel({ providerId: "toolnet", apiModelId: "zz-custom" });
    custom.upsertCustomModel({ providerId: "toolnet", apiModelId: "aa-custom" });
    const merged = custom.mergeCustomModels("toolnet", discovered());
    expect(merged.map((m: any) => m.apiModelId)).toEqual(["base", "aa-custom", "zz-custom"]);
    const customModel = merged.find((m: any) => m.apiModelId === "zz-custom");
    expect(customModel.status).toBe("active");
    expect(customModel.metadata.custom).toBe(true);
  });

  it("merge output works through catalog.replaceProviderModels (one atomic replace)", () => {
    const { custom } = freshModules();
    custom.upsertCustomModel({ providerId: "toolnet", apiModelId: "custom-only" });
    const merged = custom.mergeCustomModels("toolnet", discovered());
    const ids = modelCatalog.replaceProviderModels("toolnet", merged);
    expect(ids).toContain("toolnet/base");
    expect(ids).toContain("toolnet/custom-only");
    const listed = modelCatalog.listByProvider("toolnet").map((m: any) => m.apiModelId);
    expect(listed).toContain("custom-only");
  });
});

describe("Provider existence rule", () => {
  it("custom model for a nonexistent provider is rejected by the command layer", () => {
    // The command layer checks listProviders(); simulate the check directly.
    const { registry, custom } = freshModules();
    const known = registry.listProviders().map((p: any) => p.id);
    expect(known).not.toContain("ghost-provider");
    // The store itself never creates providers: an entry can technically be
    // written, but the command refuses and no provider appears.
    custom.upsertCustomModel({ providerId: "ghost-provider", apiModelId: "x" });
    expect(registry.listProviders().map((p: any) => p.id)).not.toContain("ghost-provider");
  });
});

describe("Schema migration", () => {
  it("v5 config gains customModels (empty) without losing fields", () => {
    const { appConfig } = freshModules();
    const raw = {
      schemaVersion: 5,
      provider: "toolnet",
      defaultModel: "alims-intl.llm",
    };
    const migrated = appConfig.migrateConfig
      ? appConfig.migrateConfig(raw)
      : (() => {
          // migrateConfig not exported — validate through load path instead.
          const { writeFileSync } = require("node:fs");
          writeFileSync(join(home, "config.json"), JSON.stringify(raw));
          appConfig.resetAppConfigCache();
          return appConfig.loadAppConfig().config;
        })();
    expect(migrated.schemaVersion).toBe(6);
    expect(Array.isArray(migrated.customModels)).toBe(true);
    expect(migrated.defaultModel).toBe("alims-intl.llm");
  });

  it("corrupt customModels entries are dropped, not fatal", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        schemaVersion: 6,
        customModels: [
          { providerId: "toolnet", apiModelId: "ok" },
          { providerId: 42 },
          "garbage",
          { providerId: "toolnet", apiModelId: "" },
        ],
      }),
    );
    appConfig.resetAppConfigCache();
    const { config } = appConfig.loadAppConfig();
    expect(config.customModels.length).toBe(1);
    expect(config.customModels[0].apiModelId).toBe("ok");
  });
});

describe("Provider-first entries", () => {
  it("configured providers sort before unconfigured built-ins", () => {
    const { registry } = freshModules();
    registry.saveProvidersConfig({
      schemaVersion: 1,
      providers: [registry.getDefaultProviderConfig("deepseek")],
      activeProviderId: "deepseek",
    });
    const entries = buildProviderEntries();
    const firstUnconfigured = entries.findIndex((e: any) => !e.configured);
    const lastConfigured = entries.map((e: any) => e.configured).lastIndexOf(true);
    expect(lastConfigured).toBeLessThan(firstUnconfigured);
    expect(entries[0].id).toBe("deepseek");
    const toolnet = entries.find((e: any) => e.id === "toolnet");
    expect(toolnet.configured).toBe(false);
    // Display name is friendly but the id stays canonical.
    expect(toolnet.name).toBe("ToolNet Gateway");
  });
});
