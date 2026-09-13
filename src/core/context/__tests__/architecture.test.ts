/**
 * Architecture guards for the context layer.
 *
 * Static proof that context intelligence is a COORDINATOR and not a second
 * runtime: it cannot execute tools, cannot talk to a provider, cannot resolve a
 * credential and cannot write session files behind the store's back. It also
 * pins the number of canonical owners, because the failure mode this layer
 * invites is a second budget/estimator that quietly disagrees with the first.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { contextManager, ContextManager } from "../manager";
import { tokenEstimator } from "../estimator";
import { contextCache } from "../cache";

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

function allProductionSource(): string {
  return productionFiles("src")
    .map((file) => readSource(file))
    .join("\n");
}

describe("context layer architecture guards", () => {
  it("exposes one canonical manager, estimator and cache (singleton identity)", () => {
    const again = require("../manager") as typeof import("../manager");
    const againEstimator = require("../estimator") as typeof import("../estimator");
    const againCache = require("../cache") as typeof import("../cache");
    expect(again.contextManager).toBe(contextManager);
    expect(again.ContextManager).toBe(ContextManager);
    expect(againEstimator.tokenEstimator).toBe(tokenEstimator);
    expect(againCache.contextCache).toBe(contextCache);
  });

  it("declares each canonical owner exactly once in production sources", () => {
    const canonical = allProductionSource();
    expect(countMatches(canonical, /export class ContextManager\b/)).toBe(1);
    expect(countMatches(canonical, /export class TokenEstimator\b/)).toBe(1);
    expect(countMatches(canonical, /export class SessionStore\b/)).toBe(1);
    expect(countMatches(canonical, /export class ModelRouter\b/)).toBe(1);
    expect(countMatches(canonical, /export class ModelCatalog\b/)).toBe(1);
    expect(countMatches(canonical, /export class ProviderRegistry\b/)).toBe(1);
    expect(countMatches(canonical, /export class CredentialResolver\b/)).toBe(1);
    expect(countMatches(canonical, /export class AgentHarness\b/)).toBe(1);
    expect(countMatches(canonical, /export class AgentEngine\b/)).toBe(1);
    expect(countMatches(canonical, /export class ToolGateway\b/)).toBe(1);
    expect(countMatches(canonical, /export const toolRegistry\b/)).toBe(1);
    // One context cache inside the context layer (an unrelated repository-analysis
    // cache exists elsewhere and is a different concept).
    const contextSrc = productionFiles("src/core/context").map(readSource).join("\n");
    expect(countMatches(contextSrc, /export class ContextCache\b/)).toBe(1);
  });

  it("keeps token estimation in one place", () => {
    const files = productionFiles("src");
    const computing = files.filter((file) => /\bcharsPerToken\s*=/.test(readSource(file)));
    expect(computing).toEqual([path.join("src", "core", "context", "estimator.ts")]);
    // No scattered "length / 4" heuristics anywhere in production source.
    for (const file of files) {
      const src = readSource(file);
      expect(`${file}: ${/\.length\s*\/\s*4\b/.test(src)}`).not.toMatch(new RegExp(`${file}: true`));
    }
  });

  it("never executes tools, providers or credential resolution", () => {
    const forbidden = [
      /provider\.chat\(/,
      /provider\.stream\(/,
      /executeToolBatch/,
      /from\s+"[^"]*toolGateway/i,
      /from\s+"[^"]*security\/permissions/i,
      /from\s+"[^"]*credentialStore"/,
      /from\s+"[^"]*auth\/(resolver|credentialStore)"/,
      /resolveApiKey\(/,
      /new\s+AgentLoop\b/,
    ];
    for (const dir of [path.join("src", "core", "context"), path.join("src", "lib", "context")]) {
      for (const file of productionFiles(dir)) {
        const src = readSource(file);
        for (const pattern of forbidden) {
          if (pattern.test(src)) throw new Error(`${file} matches forbidden pattern ${pattern}`);
        }
      }
    }
  });

  it("persists compaction only through the session store's public API", () => {
    for (const file of productionFiles(path.join("src", "lib", "context"))) {
      const src = readSource(file);
      // Reaching for session files directly would bypass lane discipline; the
      // adapter must go through the canonical manager.
      expect(/from\s+"[^"]*session\/store"/.test(src)).toBe(false);
      expect(/from\s+"[^"]*session\/journal"/.test(src)).toBe(false);
      expect(/appendEvent\(|writeFileSync\(/.test(src)).toBe(false);
    }
  });

  it("the context layer holds no credentials and reads no secrets from the environment", () => {
    for (const dir of [path.join("src", "core", "context"), path.join("src", "lib", "context")]) {
      for (const file of productionFiles(dir)) {
        const src = readSource(file);
        expect(/OPENROUTER_API_KEY|API_KEY\b|Authorization\s*[:=]/i.test(src)).toBe(false);
        expect(/process\.env/.test(src)).toBe(false);
      }
    }
  });

  it("compaction records into the journal only for sessions the store already owns", () => {
    const src = readSource(path.join("src", "core", "context", "manager.ts"));
    expect(/sessionStore\.exists\(sessionId\)/.test(src)).toBe(true);
    expect(/sessionStore\.appendSessionEvent\(/.test(src)).toBe(true);
    expect(/sessionStore\.checkpoint\(/.test(src)).toBe(true);
  });
});
