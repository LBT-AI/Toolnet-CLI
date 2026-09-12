/**
 * Phase 83 §24 — architecture guards.
 *
 * Static proof that the external-harness layer is an INTEROPERABILITY
 * boundary, not a second runtime, and that trust never leaks:
 *  - exactly one ExternalHarnessRegistry / ExternalHarnessRunner;
 *  - external adapters never import ToolGateway/Permission/provider runtime;
 *  - the native AgentHarness contains no harness-name branching;
 *  - prompts reach the child as argv, never as shell text.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { externalHarnessRegistry, externalHarnessRunner, HarnessExecutionService, harnessExecutionService } from "../index";

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

function productionFiles(dir: string): string[] {
  return sourceFiles(dir).filter((file) => !file.includes("__tests__") && !file.endsWith(".test.ts"));
}

function countMatches(haystack: string, pattern: RegExp): number {
  return (haystack.match(pattern) ?? []).length;
}

describe("Phase 83 §24 — architecture guards", () => {
  it("exposes exactly one canonical registry/runner/service (singleton identity)", () => {
    const { externalHarnessRegistry: againRegistry, externalHarnessRunner: againRunner, harnessExecutionService: againService } =
      require("../index") as typeof import("../index");
    expect(againRegistry).toBe(externalHarnessRegistry);
    expect(againRunner).toBe(externalHarnessRunner);
    expect(againService).toBe(harnessExecutionService);
  });

  it("defines each canonical external class exactly once in production sources", () => {
    const src = productionFiles("src/core/externalHarness").map((file) => readSource(file)).join("\n");
    expect(countMatches(src, /class ExternalHarnessRegistry\b/)).toBe(1);
    expect(countMatches(src, /class ExternalHarnessRunner\b/)).toBe(1);
    expect(countMatches(src, /class HarnessExecutionService\b/)).toBe(1);
  });

  it("external harness layer never imports ToolGateway, permission engine or providers", () => {
    const forbidden = [
      /from\s+"[^"]*toolGateway/i,
      /from\s+"[^"]*security\/permissions/i,
      /from\s+"[^"]*permissions"/i,
      /from\s+"[^"]*providers\/(openrouter|openai|anthropic|registry)"/i,
      /provider\.chat\(/,
      /provider\.stream\(/,
      /executeToolBatch/,
    ];
    for (const file of productionFiles("src/core/externalHarness")) {
      const src = readSource(file);
      for (const pattern of forbidden) {
        expect(`${file}: ${pattern}`).not.toMatch(pattern === pattern ? src : src);
        const match = pattern.test(src);
        if (match) throw new Error(`${file} matches forbidden pattern ${pattern}`);
      }
    }
  });

  it("native AgentHarness contains no harness-name branching", () => {
    const src = readSource("src/lib/harness/agentHarness.ts");
    expect(/if\s*\(?\s*harness\s*===?\s*["']codex["']/.test(src)).toBe(false);
    expect(/if\s*\(?\s*harness\s*===?\s*["']opencode["']/.test(src)).toBe(false);
    expect(/harness\s*===\s*["']claude["']/.test(src)).toBe(false);
  });

  it("spawn is argv-only: no shell:true, no sh -c, no bash -c in the external layer", () => {
    const src = productionFiles("src/core/externalHarness").map((file) => readSource(file)).join("\n");
    expect(/shell:\s*true/.test(src)).toBe(false);
    expect(/["']sh["']\s*,\s*["']-c["']/.test(src)).toBe(false);
    expect(/["']bash["']\s*,\s*["']-c["']/.test(src)).toBe(false);
    // The single spawn call site pins shell: false explicitly.
    expect(/shell:\s*false/.test(src)).toBe(true);
  });

  it("every built-in adapter is external_managed with a bounded offline detector", () => {
    for (const id of externalHarnessRegistry.ids()) {
      const definition = externalHarnessRegistry.resolve(id);
      expect(definition.executionTrust).toBe("external_managed");
      expect(definition.envAllowlist.every((name) => typeof name === "string" && /^[A-Z0-9_]+$/.test(name))).toBe(true);
      // No secret-looking names in any allowlist (defense in depth — the
      // runner filters them too, but the declaration itself must be clean).
      expect(definition.envAllowlist.some((name) => /KEY|TOKEN|SECRET|PASSWORD/i.test(name))).toBe(false);
    }
  });

  it("detection never runs a model request (probe args are version/help only)", () => {
    for (const id of externalHarnessRegistry.ids()) {
      const definition = externalHarnessRegistry.resolve(id);
      const source = definition.detect.toString();
      expect(/-p["']?\s*,\s*prompt|chat|completion|exec\("/i.test(source)).toBe(false);
    }
  });
});
