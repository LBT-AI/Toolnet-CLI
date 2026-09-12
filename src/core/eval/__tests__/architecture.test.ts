import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { EvalRunner } from "../runner";
import { EvalStore } from "../store";
import { modelRouter } from "../../models/router";
import { modelCatalog } from "../../models/catalog";
import { providerRegistry } from "../../models/registry";

const ROOT = process.cwd();

function readSource(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "fixtures") continue;
      sourceFiles(relative, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) out.push(relative);
  }
  return out;
}

function productionFiles(dir: string): string[] {
  return sourceFiles(dir).filter((file) => !file.includes("__tests__") && !file.endsWith(".test.ts"));
}

function countMatches(haystack: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return (haystack.match(global) ?? []).length;
}

describe("Phase 80 — architecture guards", () => {
  it("exposes exactly one canonical router, catalog and registry", () => {
    const wholeSrc = productionFiles("src").map(readSource).join("\n");
    expect(countMatches(wholeSrc, /class ModelRouter\b/)).toBe(1);
    expect(countMatches(wholeSrc, /class ModelCatalog\b/)).toBe(1);
    expect(countMatches(wholeSrc, /class ProviderRegistry\b/)).toBe(1);
    expect(countMatches(wholeSrc, /class EvalRunner\b/)).toBe(1);
    expect(countMatches(wholeSrc, /class EvalStore\b/)).toBe(1);

    expect(modelRouter).toBeDefined();
    expect(modelCatalog).toBeDefined();
    expect(providerRegistry).toBeDefined();
    expect(new EvalRunner()).toBeInstanceOf(EvalRunner);
  });

  it("keeps the eval layer off the provider transport", () => {
    const offenders: string[] = [];
    for (const file of productionFiles("src/core/eval")) {
      const source = readSource(file);
      if (/\bprovider\.(chat|stream)\s*\(/.test(source)) offenders.push(`${file}: calls provider directly`);
      if (/new OpenAICompatibleProvider\b|new AnthropicProvider\b|new GeminiProvider\b/.test(source)) {
        offenders.push(`${file}: constructs a provider client`);
      }
      if (/createProviderInstance\s*\(/.test(source)) offenders.push(`${file}: constructs a provider instance`);
    }
    expect(offenders).toEqual([]);
  });

  it("runs the eval through the AgentHarness, not a second agent loop", () => {
    const evalSources = productionFiles("src/core/eval");
    const harnessUsers = evalSources.filter((file) => /new AgentHarness\b/.test(readSource(file)));
    // Exactly one sanctioned launch point.
    expect(harnessUsers).toEqual([path.join("src", "core", "eval", "runner.ts")]);

    const wholeSrc = productionFiles("src").map(readSource).join("\n");
    expect(countMatches(wholeSrc, /class AgentHarness\b/)).toBe(1);
    // One canonical tool registry singleton, not a second execution surface.
    expect(countMatches(wholeSrc, /const toolRegistry\s*=/)).toBe(1);
    expect(countMatches(wholeSrc, /class ToolRegistry\b/)).toBe(0);
  });

  it("does not let the eval layer execute tools itself", () => {
    const offenders: string[] = [];
    for (const file of productionFiles("src/core/eval")) {
      const source = readSource(file);
      if (/from\s+["'][^"']*harness\/toolExecutor["']/.test(source)) offenders.push(file);
      if (/\btoolRegistry\.(execute|call)\b/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the model layer free of eval imports (one-way layering)", () => {
    const offenders: string[] = [];
    for (const file of productionFiles("src/core/models")) {
      const source = readSource(file);
      if (/from\s+["'][^"']*core\/eval/.test(source) || /from\s+["']\.\.\/eval/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the TUI and simple-repl off direct provider inference", () => {
    const offenders: string[] = [];
    for (const file of [...productionFiles("src/tui"), "src/simple-repl.ts"]) {
      const source = readFileSafe(file);
      if (source === null) continue;
      if (/\bprovider\.(chat|stream)\s*\(/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the CLI commands off provider construction", () => {
    const offenders: string[] = [];
    for (const file of productionFiles("src/commands")) {
      const source = readSource(file);
      if (/new OpenAICompatibleProvider\b|new AnthropicProvider\b/.test(source)) offenders.push(file);
      if (/\bprovider\.(chat|stream)\s*\(/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("hard-codes no model-family routing anywhere in the model or eval layers", () => {
    // A model *name* must never drive a routing or grading decision. Matching on
    // provider KINDS ("gemini" as a transport) is legitimate, so only actual
    // model-id comparisons and lookups are flagged.
    const familyComparison = /=\s*["'](claude|gpt-\d|gemini-\d|llama-\d)/i;
    const familyLookup = /(includes|startsWith|endsWith|indexOf)\(\s*["'](claude|gpt-\d|gemini-\d|llama-\d)/i;
    const offenders: string[] = [];
    for (const file of [...productionFiles("src/core/models"), ...productionFiles("src/core/eval")]) {
      const source = readSource(file);
      if (familyComparison.test(source)) offenders.push(`${file}: model-name comparison`);
      if (familyLookup.test(source)) offenders.push(`${file}: model-name lookup`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the TUI a read-only catalog consumer", () => {
    const catalog = readFileSafe("src/commands/catalog.ts");
    expect(catalog).not.toBeNull();
    // It may read the canonical layer, but must not perform network I/O.
    expect(catalog).not.toContain("fetch(");
    expect(catalog).not.toContain("listModels(");
    expect(catalog).toContain("buildCatalogRows");
  });
});

function readFileSafe(relative: string): string | null {
  try {
    return readSource(relative);
  } catch {
    return null;
  }
}
