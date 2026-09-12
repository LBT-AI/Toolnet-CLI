/**
 * Phase 81 §22 — architecture guards.
 *
 * The harness compatibility layer is POLICY. These static checks prove it:
 *
 *   · exactly one AgentHarness / AgentEngine / ModelRouter / ToolRegistry /
 *     ToolGateway in the codebase
 *   · `src/core/harness/**` performs no I/O and owns no transport — no provider
 *     call, no gateway execution, no process spawn, no file write, no network
 *   · the TUI and the CLI never construct a provider for inference
 *   · no model-specific branching decides routing
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { harnessRegistry } from "..";

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
  return sourceFiles(dir).filter(
    (file) => !file.includes("__tests__") && !file.endsWith(".test.ts"),
  );
}

/**
 * Remove comments before scanning. Prose legitimately mentions `while (true)`
 * and "writes files" when explaining that the code does NOT do those things, so
 * a guard over raw source would flag its own documentation.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function countMatches(haystack: string, pattern: RegExp): number {
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  return (haystack.match(global) ?? []).length;
}

describe("Phase 81 §22 — architecture guards", () => {
  it("keeps exactly one harness, engine, router, tool registry and gateway", () => {
    const wholeSrc = productionFiles("src").map(readSource).join("\n");
    expect(countMatches(wholeSrc, /class AgentHarness\b/)).toBe(1);
    expect(countMatches(wholeSrc, /class AgentEngine\b/)).toBe(1);
    expect(countMatches(wholeSrc, /class ModelRouter\b/)).toBe(1);
    // One canonical tool registry: `toolRegistry` is a singleton object, so the
    // guard counts the exported singleton rather than a class name.
    expect(countMatches(wholeSrc, /export const toolRegistry\b/)).toBe(1);
    expect(countMatches(wholeSrc, /class ToolGateway\b/)).toBe(1);
  });

  it("keeps the harness layer off the provider transport", () => {
    const offenders: string[] = [];
    for (const file of productionFiles("src/core/harness")) {
      const source = stripComments(readSource(file));
      if (/\bprovider\.(chat|stream)\s*\(/.test(source)) {
        offenders.push(`${file}: calls a provider directly`);
      }
      if (
        /new OpenAICompatibleProvider\b|new AnthropicProvider\b|new GeminiProvider\b|new OpenRouterProvider\b/.test(
          source,
        )
      ) {
        offenders.push(`${file}: constructs a provider client`);
      }
      if (/createProviderInstance\s*\(/.test(source)) {
        offenders.push(`${file}: constructs a provider instance`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the harness layer off the tool execution path", () => {
    const offenders: string[] = [];
    for (const file of productionFiles("src/core/harness")) {
      const source = stripComments(readSource(file));
      if (/ToolGateway\s*\.\s*execute|toolGateway\s*\.\s*execute/.test(source)) {
        offenders.push(`${file}: executes through the gateway`);
      }
      if (/from\s+"[^"]*security\/toolGateway"/.test(source)) {
        offenders.push(`${file}: imports the ToolGateway`);
      }
      if (/from\s+"[^"]*harness\/toolRegistry"/.test(source)) {
        offenders.push(`${file}: imports the tool registry`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the harness layer free of I/O and side effects", () => {
    const offenders: string[] = [];
    for (const file of productionFiles("src/core/harness")) {
      const source = stripComments(readSource(file));
      const checks: Array<[RegExp, string]> = [
        [/child_process|spawnSync|execSync|\bspawn\s*\(/, "spawns a process"],
        [/writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync/, "writes to disk"],
        [/\bfetch\s*\(|axios|node:http|node:https|node:net/, "performs network I/O"],
        [/new AgentHarness\b|executeLoop\s*\(/, "builds or drives a harness"],
      ];
      for (const [pattern, reason] of checks) {
        if (pattern.test(source)) offenders.push(`${file}: ${reason}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares no second agent loop or provider map", () => {
    const wholeSrc = productionFiles("src").map(readSource).join("\n");
    // `src/core/harness/**` must not define a loop entry point.
    for (const file of productionFiles("src/core/harness")) {
      const code = stripComments(readSource(file));
      expect(code).not.toMatch(/while\s*\(\s*true\s*\)/);
      expect(code).not.toMatch(/for\s*await\s*\(/);
    }
    // The engine remains a facade over the one harness.
    expect(readSource("src/core/agent/agentEngine.ts")).toMatch(/new AgentHarness\(/);
    expect(countMatches(wholeSrc, /new AgentHarness\(/)).toBeLessThanOrEqual(6);
  });

  it("the TUI never constructs a provider for inference", () => {
    const offenders: string[] = [];
    for (const file of productionFiles("src/tui")) {
      const source = stripComments(readSource(file));
      if (/provider\.(chat|stream)\s*\(/.test(source)) offenders.push(file);
      if (/createProviderInstance\s*\(/.test(source)) offenders.push(file);
    }
    for (const file of productionFiles("src/commands")) {
      const source = stripComments(readSource(file));
      if (/provider\.(chat|stream)\s*\(/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("no vendor name decides harness auto-resolution", () => {
    const profiles = readSource("src/core/harness/profiles.ts");
    for (const vendor of ["claude", "gpt", "gemini", "anthropic", "openai", "openrouter"]) {
      expect(profiles.toLowerCase()).not.toContain(vendor);
    }
    expect(profiles).toMatch(/AUTO_HARNESS_BY_TASK/);
  });

  it("the router is unaware of harness profiles (independent axes)", () => {
    for (const file of productionFiles("src/core/models")) {
      const source = stripComments(readSource(file));
      expect(source).not.toMatch(/core\/harness|from\s+"\.\.\/harness"/);
    }
  });

  it("the harness is unaware of the router internals", () => {
    for (const file of productionFiles("src/core/harness")) {
      const source = stripComments(readSource(file));
      expect(source).not.toMatch(/from\s+"[^"]*core\/models\//);
      expect(source).not.toMatch(/modelRouter\b/);
      expect(source).not.toMatch(/modelCatalog\b/);
      expect(source).not.toMatch(/providerRegistry\b/);
    }
  });

  it("exactly one harness registry singleton exists", () => {
    const wholeSrc = productionFiles("src").map(readSource).join("\n");
    expect(countMatches(wholeSrc, /export const harnessRegistry\b/)).toBe(1);
    expect(countMatches(wholeSrc, /class HarnessRegistry\b/)).toBe(1);
    expect(harnessRegistry.ids().length).toBeGreaterThan(0);
  });

  it("only the harness layer and config own profile selection writes", () => {
    const store = readSource("src/core/harness/store.ts");
    expect(store).toMatch(/updateAppConfig\(/);
    // No second config file: the store writes through the canonical owner.
    expect(store).not.toMatch(/writeFileSync|fs\.write/);
  });
});
