/**
 * — architecture guards.
 *
 * Static proof that provider auth has exactly ONE store, ONE profile registry
 * and ONE resolver, that no second secret store hides in a provider/CLI/TUI/
 * external-harness-local map, and that the MCP OAuth store () keeps its
 * own typed namespace.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { credentialStore, credentialResolver, authProfileRegistry, authOperations } from "../index";

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

describe(" — auth architecture guards", () => {
  it("exposes one canonical singleton per owner (stable identity across imports)", () => {
    const again = require("../index") as typeof import("../index");
    expect(again.credentialStore).toBe(credentialStore);
    expect(again.credentialResolver).toBe(credentialResolver);
    expect(again.authProfileRegistry).toBe(authProfileRegistry);
    expect(again.authOperations).toBe(authOperations);
  });

  it("defines each canonical class exactly once in production sources", () => {
    const src = productionFiles("src/core/auth").map((file) => readSource(file)).join("\n");
    expect(countMatches(src, /class CredentialStore\b/)).toBe(1);
    expect(countMatches(src, /class AuthProfileRegistry\b/)).toBe(1);
    expect(countMatches(src, /class CredentialResolver\b/)).toBe(1);
    expect(countMatches(src, /class AuthOperations\b/)).toBe(1);
  });

  it("constructs the canonical owners only inside src/core/auth", () => {
    const violations: string[] = [];
    for (const file of productionFiles("src")) {
      if (file.startsWith(path.join("src", "core", "auth"))) continue;
      const src = readSource(file);
      if (/new\s+CredentialStore\b/.test(src) || /new\s+CredentialResolver\b/.test(src)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  it("no second secret file: only the auth store names an on-disk credential path", () => {
    // toolnetHome owns the home layout (and hardens the file mode); appConfig
    // documents the config/secret split. Neither stores a secret.
    const allowed = new Set([
      path.join("src", "lib", "toolnetHome.ts"),
      path.join("src", "lib", "appConfig.ts"),
    ]);
    const violations: string[] = [];
    for (const file of productionFiles("src")) {
      if (file.startsWith(path.join("src", "core", "auth")) || allowed.has(file)) continue;
      const src = readSource(file);
      // A provider/TUI/CLI-local credentials file would look like this.
      if (/auth-credentials\.json|provider-credentials/i.test(src)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
 // 's MCP store is a different, typed namespace: it must not adopt
    // the provider credential store's name either.
    const mcpFiles = productionFiles(path.join("src", "core", "mcp"));
    for (const file of mcpFiles) {
      expect(readSource(file)).not.toContain("auth-credentials.json");
    }
  });

  it("MCP OAuth storage stays a separate typed namespace from provider auth", () => {
    const mcpAuth = readSource(path.join("src", "core", "mcp", "authStore.ts"));
    expect(mcpAuth).not.toContain("core/auth/credentialStore");
    expect(mcpAuth).not.toContain("CredentialStore");
    const mcpManager = readSource(path.join("src", "core", "mcp", "manager.ts"));
    expect(mcpManager).not.toContain("credentialResolver");
  });

  it("the external harness layer owns no credential store", () => {
    for (const file of productionFiles("src/core/externalHarness")) {
      const src = readSource(file);
      expect(src).not.toContain("core/auth/credentialStore");
      expect(src).not.toContain("CredentialStore");
      // Adapters declare env names; they must never read a secret themselves.
      expect(src).not.toContain("credentialResolver");
    }
  });

  it("the TUI reads auth through the canonical facade only", () => {
    for (const file of productionFiles("src/tui")) {
      const src = readSource(file);
      expect(src).not.toContain("credentialStore");
      expect(src).not.toContain("credentialResolver.resolve");
    }
    const catalog = readSource(path.join("src", "lib", "harnessCatalog.ts"));
    expect(catalog).toContain("authOperations");
    expect(catalog).not.toContain("credentialStore");
  });

  it("provider registry delegates key resolution to the auth layer (no local secret reads)", () => {
    const registry = readSource(path.join("src", "providers", "registry.ts"));
    expect(registry).toContain("credentialResolver");
    // The only remaining environment read is the compat fallback inside the
    // resolver; the provider layer must not read key material on its own.
    expect(countMatches(registry, /process\.env\[/)).toBe(0);
  });

  it("OPENROUTER_API_KEY is declared in canonical config/auth locations, not scattered", () => {
    const allowed = new Set([
      path.join("src", "core", "auth", "types.ts"),
      path.join("src", "core", "auth", "resolver.ts"),
      path.join("src", "core", "auth", "operations.ts"),
      path.join("src", "core", "externalHarness", "adapters.ts"),
      path.join("src", "core", "eval", "liveAcceptance.ts"),
      path.join("src", "core", "models", "liveAcceptance.ts"),
      path.join("src", "core", "models", "providers.ts"),
      path.join("src", "lib", "keys.ts"),
      path.join("src", "providers", "registry.ts"),
      path.join("src", "commands", "authCli.ts"),
    ]);
    const violations: string[] = [];
    for (const file of productionFiles("src")) {
      if (!readSource(file).includes("OPENROUTER_API_KEY")) continue;
      if (!allowed.has(file)) violations.push(file);
    }
    expect(violations).toEqual([]);
  });

  it("agent/model runtime does not hold a credential map", () => {
    for (const file of productionFiles("src/core/models")) {
      if (file.endsWith("liveAcceptance.ts") || file.endsWith("providers.ts")) continue;
      expect(readSource(file)).not.toContain("credentialStore");
    }
  });
});
