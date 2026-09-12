import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { ModelCatalog } from "../catalog";
import { ProviderRegistry } from "../registry";
import {
  MODEL_CACHE_SCHEMA_VERSION,
  hydrateCatalogFromCache,
  isCacheStale,
  readCatalogCache,
  removeCachedProvider,
  setCachedProviderModels,
  writeCatalogCache,
} from "../cache";
import { formatModelRef } from "../ref";
import type { ModelDefinition } from "../types";

const tmpDirs: string[] = [];

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase80-cache-"));
  tmpDirs.push(dir);
  return path.join(dir, "cache", "models.json");
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function model(providerId: string, apiModelId: string): ModelDefinition {
  return {
    id: formatModelRef(providerId, apiModelId),
    providerId,
    apiModelId,
    capabilities: { tools: true },
    status: "active",
  };
}

describe("Phase 80 — persistent model cache", () => {
  it("round-trips providers atomically and writes mode 0600", () => {
    const file = tempFile();
    expect(setCachedProviderModels("alpha", [model("alpha", "a1")], { filePath: file })).toBe(true);

    const read = readCatalogCache(file);
    expect(read.ok).toBe(true);
    expect(read.file?.providers.alpha.models).toHaveLength(1);

    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("isolates providers so refreshing one never drops another", () => {
    const file = tempFile();
    setCachedProviderModels("alpha", [model("alpha", "a1")], { filePath: file });
    setCachedProviderModels("beta", [model("beta", "b1"), model("beta", "b2")], { filePath: file });

    const read = readCatalogCache(file);
    expect(read.file?.providers.alpha.models).toHaveLength(1);
    expect(read.file?.providers.beta.models).toHaveLength(2);

    // Refreshing alpha must leave beta untouched.
    setCachedProviderModels("alpha", [model("alpha", "a2")], { filePath: file });
    const after = readCatalogCache(file);
    expect(after.file?.providers.alpha.models[0].apiModelId).toBe("a2");
    expect(after.file?.providers.beta.models).toHaveLength(2);
  });

  it("removes exactly one provider", () => {
    const file = tempFile();
    setCachedProviderModels("alpha", [model("alpha", "a1")], { filePath: file });
    setCachedProviderModels("beta", [model("beta", "b1")], { filePath: file });
    removeCachedProvider("alpha", { filePath: file });

    const read = readCatalogCache(file);
    expect(read.file?.providers.alpha).toBeUndefined();
    expect(read.file?.providers.beta).toBeDefined();
  });

  it("quarantines a corrupt cache instead of crashing", () => {
    const file = tempFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ this is not json", "utf8");

    const read = readCatalogCache(file);
    expect(read.ok).toBe(false);
    expect(read.quarantined).toBe(true);
    // The corrupt file is moved aside, so the next startup starts clean.
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(path.dirname(file)).some((name) => name.includes(".corrupt-"))).toBe(true);
  });

  it("rejects a cache written by an unknown schema version", () => {
    const file = tempFile();
    writeCatalogCache(
      {
        version: MODEL_CACHE_SCHEMA_VERSION + 99,
        generatedAt: Date.now(),
        expiresAt: Date.now() + 1000,
        providers: {},
      },
      file,
    );
    const read = readCatalogCache(file);
    expect(read.ok).toBe(false);
    expect(read.quarantined).toBe(true);
  });

  it("reports staleness without refusing to use a stale cache", () => {
    const file = tempFile();
    setCachedProviderModels("alpha", [model("alpha", "a1")], { filePath: file, now: 0, ttlMs: 1 });
    const read = readCatalogCache(file);
    expect(read.ok).toBe(true);
    expect(isCacheStale(read.file!, 10_000)).toBe(true);

    // Stale is still usable by default.
    const registry = new ProviderRegistry(new ModelCatalog());
    registry.register({ id: "alpha", kind: "openai-compatible", baseURL: "https://a.invalid" }, { skipModels: true });
    const catalog = new ModelCatalog();
    const hydrated = hydrateCatalogFromCache({ catalog, registry, filePath: file, now: 10_000 });
    expect(hydrated.stale).toBe(true);
    expect(hydrated.hydrated).toEqual(["alpha"]);
    expect(catalog.list()).toHaveLength(1);
  });

  it("refuses a stale cache when stale use is disabled", () => {
    const file = tempFile();
    setCachedProviderModels("alpha", [model("alpha", "a1")], { filePath: file, now: 0, ttlMs: 1 });
    const catalog = new ModelCatalog();
    const registry = new ProviderRegistry(catalog);
    registry.register({ id: "alpha", kind: "openai-compatible", baseURL: "https://a.invalid" }, { skipModels: true });

    const hydrated = hydrateCatalogFromCache({ catalog, registry, filePath: file, now: 10_000, allowStale: false });
    expect(hydrated.hydrated).toEqual([]);
    expect(catalog.list()).toHaveLength(0);
  });

  it("skips cache entries for providers that are no longer registered", () => {
    const file = tempFile();
    setCachedProviderModels("ghost", [model("ghost", "g1")], { filePath: file });

    const catalog = new ModelCatalog();
    const registry = new ProviderRegistry(catalog);
    const hydrated = hydrateCatalogFromCache({ catalog, registry, filePath: file });
    expect(hydrated.hydrated).toEqual([]);
    expect(hydrated.skipped).toEqual(["ghost"]);
    expect(catalog.list()).toHaveLength(0);
  });

  it("is a no-op when the cache file does not exist", () => {
    const read = readCatalogCache(tempFile());
    expect(read.ok).toBe(false);
    expect(read.quarantined).toBeFalsy();
  });
});
