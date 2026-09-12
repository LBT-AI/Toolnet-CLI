import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import {
  ModelCatalog,
  ModelRouter,
  ProviderRegistry,
  formatModelRef,
  modelCatalog,
  modelRouter,
  providerRegistry,
  resolveRuntimeModel,
} from "..";

const ROOT = process.cwd();

function readSource(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(relative, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(relative);
  }
  return out;
}

/** Source files excluding tests — production edges only. */
function productionFiles(dir: string): string[] {
  return sourceFiles(dir).filter((file) => !file.includes("__tests__") && !file.endsWith(".test.ts"));
}

describe("Phase 79 — architecture guards", () => {
  it("exposes exactly one canonical ProviderRegistry / ModelCatalog / ModelRouter", () => {
    expect(providerRegistry).toBeInstanceOf(ProviderRegistry);
    expect(modelCatalog).toBeInstanceOf(ModelCatalog);
    expect(modelRouter).toBeInstanceOf(ModelRouter);

    // The barrel must hand back the same singleton, not a fresh instance.
    const { providerRegistry: again, modelCatalog: againCatalog, modelRouter: againRouter } = require("..");
    expect(again).toBe(providerRegistry);
    expect(againCatalog).toBe(modelCatalog);
    expect(againRouter).toBe(modelRouter);
  });

  it("defines each canonical class exactly once across production sources", () => {
    const modelsDir = productionFiles("src/core/models").map((file) => readSource(file)).join("\n");
    expect(countMatches(modelsDir, /class ProviderRegistry\b/)).toBe(1);
    expect(countMatches(modelsDir, /class ModelCatalog\b/)).toBe(1);
    expect(countMatches(modelsDir, /class ModelRouter\b/)).toBe(1);

    const wholeSrc = productionFiles("src").map((file) => readSource(file)).join("\n");
    expect(countMatches(wholeSrc, /class ProviderRegistry\b/)).toBe(1);
    expect(countMatches(wholeSrc, /class ModelCatalog\b/)).toBe(1);
    expect(countMatches(wholeSrc, /class ModelRouter\b/)).toBe(1);
  });

  it("has exactly one provider instance factory", () => {
    const wholeSrc = productionFiles("src").map((file) => readSource(file)).join("\n");
    expect(countMatches(wholeSrc, /function createProviderInstance\b/)).toBe(1);
  });

  it("routes the AgentHarness through the canonical router, not a local provider map", () => {
    const harness = readSource("src/lib/harness/agentHarness.ts");
    expect(harness).toContain("resolveRuntimeModel(");
    expect(harness).toContain("core/models");
    // The harness must not reach into the legacy provider registry itself.
    expect(harness).not.toContain("getActiveProvider(");
  });

  it("keeps provider instances out of the TUI and simple-repl execution path", () => {
    const offenders: string[] = [];
    for (const file of [...productionFiles("src/tui"), "src/simple-repl.ts"]) {
      const source = readSource(file);
      if (/\bprovider\.(chat|stream)\s*\(/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("does not let the model layer construct an agent loop", () => {
    const offenders: string[] = [];
    for (const file of productionFiles("src/core/models")) {
      const source = readSource(file);
      if (/from\s+["'][^"']*harness\/agentHarness["']/.test(source)) offenders.push(file);
      if (/\bnew AgentHarness\b/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the model layer free of tool execution", () => {
    const offenders: string[] = [];
    for (const file of productionFiles("src/core/models")) {
      const source = readSource(file);
      if (/toolRegistry|executeToolBatch|toolGateway/i.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("Phase 79 — runtime integration", () => {
  const TEST_PROVIDER = "phase79selftest";
  const API_MODEL_ID = "phase79-selftest-model";

  afterAll(() => {
    providerRegistry.unregister(TEST_PROVIDER);
  });

  it("resolves provider + model through the router and names the source", () => {
    providerRegistry.register(
      {
        id: TEST_PROVIDER,
        name: "Phase 79 Self Test",
        kind: "openai-compatible",
        baseURL: "https://selftest.invalid/v1",
        models: [
          {
            id: formatModelRef(TEST_PROVIDER, API_MODEL_ID),
            providerId: TEST_PROVIDER,
            apiModelId: API_MODEL_ID,
            capabilities: { tools: true, nativeToolCalls: false },
            status: "active",
          },
        ],
      },
      { replace: true },
    );

    const runtime = resolveRuntimeModel(`${TEST_PROVIDER}/${API_MODEL_ID}`);
    expect(runtime.source).toBe("router");
    expect(runtime.model).toBe(API_MODEL_ID);
    expect(runtime.provider.id).toBe(TEST_PROVIDER);
    expect(runtime.canonicalId).toBe(formatModelRef(TEST_PROVIDER, API_MODEL_ID));
    expect(runtime.resolved?.capabilities.nativeToolCalls).toBe(false);
  });

  it("degrades to the legacy active-provider path when the catalog cannot resolve", () => {
    const runtime = resolveRuntimeModel("phase79/definitely-not-registered");
    expect(runtime.source).toBe("legacy");
    expect(runtime.provider).toBeDefined();
    expect(runtime.model).toBe("phase79/definitely-not-registered");
  });

  it("passes the 'default' sentinel through unchanged", () => {
    // `AgentRuntime` passes the literal string "default" to mean "whatever the
    // provider defaults to". Reinterpreting it as "no model" would silently
    // swap the model actually called (and change context budgeting).
    const runtime = resolveRuntimeModel("default");
    expect(runtime.model).toBe("default");
    expect(runtime.source).toBe("legacy");
  });
});

function countMatches(haystack: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return (haystack.match(global) ?? []).length;
}
