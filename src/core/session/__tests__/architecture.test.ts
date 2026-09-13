/**
 * Architecture guards for the durable session layer.
 *
 * Static proof that sessions have ONE owner, that resume reconstructs state
 * instead of re-executing history, and that the layer never reaches into the
 * provider/tool runtime or stores anything secret.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { sessionStore, SessionStore } from "../index";

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

function sessionSources(): string[] {
  return [...productionFiles("src/core/session"), "src/commands/sessionCli.ts"];
}

describe("session architecture guards", () => {
  it("exposes one SessionStore class and one process-wide instance", () => {
    const src = productionFiles("src/core/session").map(readSource).join("\n");
    expect(countMatches(src, /class SessionStore\b/)).toBe(1);
    expect(countMatches(src, /new SessionStore\(\)/)).toBe(1);
    expect(sessionStore).toBeInstanceOf(SessionStore);
  });

  it("keeps every runtime owner singular", () => {
    const all = productionFiles("src").map(readSource).join("\n");
    expect(countMatches(all, /class AgentHarness\b/)).toBe(1);
    expect(countMatches(all, /class AgentEngine\b/)).toBe(1);
    expect(countMatches(all, /class ModelRouter\b/)).toBe(1);
    // The tool registry is a single module-owned singleton rather than a class.
    expect(countMatches(all, /export const toolRegistry\b/)).toBe(1);
    expect(countMatches(all, /class ToolGateway\b/)).toBe(1);
    expect(countMatches(all, /class CredentialResolver\b/)).toBe(1);
    expect(countMatches(all, /class SessionStore\b/)).toBe(1);
  });

  it("never imports the provider, tool-execution or permission runtime", () => {
    const forbidden = [
      /provider\.chat\(/,
      /provider\.stream\(/,
      /executeToolBatch/,
      /ToolGateway/,
      /from\s+"[^"]*core\/tools/,
      /from\s+"[^"]*providers\//,
      /from\s+"[^"]*security\/permissions/,
      /from\s+"[^"]*lib\/harness\/agentHarness/,
    ];
    for (const file of sessionSources()) {
      const src = readSource(file);
      for (const pattern of forbidden) {
        if (pattern.test(src)) throw new Error(`${file} matches forbidden pattern ${pattern}`);
      }
    }
  });

  it("resume is state-only: no process spawning and no tool replay", () => {
    const src = sessionSources().map(readSource).join("\n");
    expect(/child_process/.test(src)).toBe(false);
    expect(/shell:\s*true/.test(src)).toBe(false);
    expect(/execSync|spawnSync|Bun\.spawn/.test(src)).toBe(false);
    // "replay" must be reconstruction, never re-execution.
    expect(/replayTool|reExecute|runToolCall/.test(src)).toBe(false);
  });

  it("the durable record declares no credential-shaped fields", () => {
    const types = readSource("src/core/session/types.ts");
    for (const forbidden of [/apiKey/i, /accessToken/i, /refreshToken/i, /clientSecret/i, /Authorization/i, /password/i]) {
      // `authProfileId` is an identity reference, not a secret; nothing else may appear.
      const matches = types.match(forbidden) ?? [];
      expect(matches.length).toBe(0);
    }
    expect(/authProfileId/.test(types)).toBe(true);
  });

  it("writes only through the atomic helpers inside the sessions directory", () => {
    const src = productionFiles("src/core/session").map(readSource).join("\n");
    // Every path the store touches is derived from the sessions dir helper.
    expect(/getToolnetSessionsDir|resolveSessionsDir/.test(src)).toBe(true);
    expect(/writeFileAtomic|appendLineDurable/.test(src)).toBe(true);
    // Raw path writes live only in the atomic helpers; the lock writes to an fd
    // it already created with O_EXCL. Everything else composes those.
    const rawWriters = productionFiles("src/core/session").filter((file) => {
      const name = path.basename(file);
      if (name === "atomic.ts" || name === "lock.ts") return false;
      return /fs\.writeFileSync\(/.test(readSource(file));
    });
    expect(rawWriters).toEqual([]);
  });

  it("carries no development-history labels in its own sources", () => {
    for (const file of sessionSources()) {
      const src = readSource(file);
      const matches = src.match(/Phase\s+\d+|PHASE\s+\d+|§\d+/);
      if (matches) throw new Error(`${file} contains a development-history label: ${matches[0]}`);
    }
  });
});
