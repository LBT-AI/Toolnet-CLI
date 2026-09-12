/**
 * Phase 80 §6 — Persistent ModelCatalog cache.
 *
 * Discovery is a network operation and `toolnet models` is a hot CLI path, so
 * the catalog is cached at `~/.toolnetcli/cache/models.json`. Rules:
 *
 *  - ATOMIC: written to a temp file and renamed, mode 0600.
 *  - CORRUPTION-SAFE: an unparseable or schema-invalid file is quarantined
 *    (renamed to `.corrupt-<ts>`) and treated as empty — startup never crashes.
 *  - STALE IS USABLE: an expired cache still hydrates; it is only *refreshed*
 *    by an explicit `toolnet models refresh`.
 *  - PROVIDER ISOLATION: each provider owns one entry. Writing one provider
 *    preserves every other entry; one provider's refresh failure never deletes
 *    another provider's models.
 */

import fs from "node:fs";
import path from "node:path";
import { ensureToolnetDir, getToolnetCacheDir } from "../../lib/toolnetHome";
import { ModelCatalog, modelCatalog } from "./catalog";
import { ProviderRegistry, providerRegistry } from "./registry";
import { redactSecret } from "./errors";
import type { ModelDefinition } from "./types";

export const MODEL_CACHE_SCHEMA_VERSION = 1;
/** Default freshness window: 24 hours. */
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface CachedProviderModels {
  providerId: string;
  fetchedAt: number;
  models: ModelDefinition[];
}

export interface CatalogCacheFile {
  version: number;
  generatedAt: number;
  expiresAt: number;
  providers: Record<string, CachedProviderModels>;
}

export interface ReadCacheResult {
  ok: boolean;
  file?: CatalogCacheFile;
  /** True when a corrupt file was quarantined. */
  quarantined?: boolean;
  error?: string;
}

export function getModelCachePath(): string {
  return path.join(getToolnetCacheDir(), "models.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidModel(value: unknown): value is ModelDefinition {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.providerId === "string" && typeof value.apiModelId === "string";
}

/** Parse + validate an on-disk cache body. Returns null for anything unusable. */
function parseCache(raw: unknown): CatalogCacheFile | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== MODEL_CACHE_SCHEMA_VERSION) return null;
  if (!isRecord(raw.providers)) return null;

  const providers: Record<string, CachedProviderModels> = {};
  for (const [providerId, entry] of Object.entries(raw.providers)) {
    if (!isRecord(entry) || !Array.isArray(entry.models)) continue;
    const models = entry.models.filter(isValidModel);
    if (models.length === 0) continue;
    providers[providerId] = {
      providerId,
      fetchedAt: typeof entry.fetchedAt === "number" && Number.isFinite(entry.fetchedAt) ? entry.fetchedAt : 0,
      models,
    };
  }

  const generatedAt = typeof raw.generatedAt === "number" && Number.isFinite(raw.generatedAt) ? raw.generatedAt : 0;
  const expiresAt =
    typeof raw.expiresAt === "number" && Number.isFinite(raw.expiresAt) ? raw.expiresAt : generatedAt + MODEL_CACHE_TTL_MS;

  return { version: MODEL_CACHE_SCHEMA_VERSION, generatedAt, expiresAt, providers };
}

/**
 * Read the cache. A corrupt file is quarantined and reported — never thrown.
 * Never logs file contents (they are model metadata, but the discipline holds).
 */
export function readCatalogCache(filePath: string = getModelCachePath()): ReadCacheResult {
  let text: string;
  try {
    if (!fs.existsSync(filePath)) return { ok: false };
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return { ok: false, error: redactSecret(error instanceof Error ? error.message : String(error)) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, quarantined: quarantine(filePath), error: "cache file is not valid JSON" };
  }

  const file = parseCache(parsed);
  if (!file) {
    return { ok: false, quarantined: quarantine(filePath), error: "cache file failed schema validation" };
  }
  return { ok: true, file };
}

/** Rename a bad cache aside so it cannot break the next startup. */
function quarantine(filePath: string): boolean {
  try {
    fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    return true;
  } catch {
    try {
      fs.rmSync(filePath, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

/** Atomic write with 0600, creating the cache dir with 0700. */
export function writeCatalogCache(file: CatalogCacheFile, filePath: string = getModelCachePath()): boolean {
  try {
    const dir = path.dirname(filePath);
    ensureToolnetDir(dir);
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}

export interface UpsertOptions {
  filePath?: string;
  now?: number;
  ttlMs?: number;
}

/**
 * Read-modify-write ONE provider's entry. Every other provider is preserved
 * byte-for-byte (plus its models), which is what makes provider refresh
 * failures non-destructive.
 */
export function setCachedProviderModels(
  providerId: string,
  models: ModelDefinition[],
  options: UpsertOptions = {},
): boolean {
  const filePath = options.filePath ?? getModelCachePath();
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? MODEL_CACHE_TTL_MS;

  const existing = readCatalogCache(filePath);
  const providers = existing.ok && existing.file ? { ...existing.file.providers } : {};
  const key = providerId.toLowerCase();

  if (models.length === 0) delete providers[key];
  else providers[key] = { providerId: key, fetchedAt: now, models };

  return writeCatalogCache(
    {
      version: MODEL_CACHE_SCHEMA_VERSION,
      generatedAt: now,
      expiresAt: now + ttlMs,
      providers,
    },
    filePath,
  );
}

/** Drop exactly one provider from the cache. */
export function removeCachedProvider(providerId: string, options: UpsertOptions = {}): boolean {
  return setCachedProviderModels(providerId, [], options);
}

export function isCacheStale(file: CatalogCacheFile, now = Date.now()): boolean {
  return file.expiresAt <= now;
}

/**
 * Hydrate the canonical catalog from a cached file.
 *
 * Only providers that are actually REGISTERED are applied — a cache entry for a
 * provider the user removed from config must not resurrect its models.
 */
export function hydrateCatalogFromCache(options: {
  catalog?: ModelCatalog;
  registry?: ProviderRegistry;
  filePath?: string;
  now?: number;
  /** Apply even stale entries (default true — stale is usable). */
  allowStale?: boolean;
} = {}): { hydrated: string[]; skipped: string[]; stale: boolean; quarantined: boolean } {
  const catalog = options.catalog ?? modelCatalog;
  const registry = options.registry ?? providerRegistry;
  const read = readCatalogCache(options.filePath);

  if (!read.ok || !read.file) {
    return { hydrated: [], skipped: [], stale: false, quarantined: Boolean(read.quarantined) };
  }

  const stale = isCacheStale(read.file, options.now ?? Date.now());
  if (stale && options.allowStale === false) {
    return { hydrated: [], skipped: Object.keys(read.file.providers), stale: true, quarantined: false };
  }

  const hydrated: string[] = [];
  const skipped: string[] = [];
  for (const [providerId, entry] of Object.entries(read.file.providers)) {
    if (!registry.has(providerId)) {
      skipped.push(providerId);
      continue;
    }
    // Per-provider atomic replace — a corrupt entry cannot half-apply.
    catalog.replaceProviderModels(providerId, entry.models);
    hydrated.push(providerId);
  }
  return { hydrated, skipped, stale, quarantined: false };
}
