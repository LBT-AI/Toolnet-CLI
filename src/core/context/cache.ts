/**
 * Context cache.
 *
 * Purely an optimization: every accessor has a correct miss path, so a cleared,
 * full or cold cache changes speed and nothing else. Nothing here is durable, so
 * corruption cannot outlive the process.
 *
 * Keys are content-derived rather than name-derived. A file entry records the
 * size and mtime it was read at and is re-verified before it is trusted, so an
 * edit on disk is a miss instead of a stale hit. Callers that mutate a file
 * through a tool also call `invalidatePath`, which covers the one hole stat
 * metadata cannot: a same-size write within the same millisecond.
 */

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface CacheStats {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  hits: number;
  misses: number;
  evictions: number;
  invalidations: number;
}

interface FileEntry {
  content: string;
  size: number;
  mtimeMs: number;
  bytes: number;
  key: string;
}

interface TokenEntry {
  estimate: { tokens: number; confidence: "exact" | "high" | "low"; source: string };
  bytes: number;
  key: string;
}

export interface ContextCacheOptions {
  maxEntries?: number;
  maxBytes?: number;
}

export function hashContent(text: string): string {
  // FNV-1a: stable across processes, good enough to separate cache entries.
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(36)}:${text.length}`;
}

export function tokenCacheKey(content: string, modelFamily: string): string {
  return `${modelFamily}::${hashContent(content)}`;
}

export class ContextCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly files = new Map<string, FileEntry>();
  private readonly tokens = new Map<string, TokenEntry>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private invalidations = 0;

  constructor(options: ContextCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES);
  }

  private evictIfNeeded(): void {
    while (this.files.size + this.tokens.size > this.maxEntries || this.bytes > this.maxBytes) {
      // Oldest insertion first (Map preserves order) — the cheapest deterministic
      // policy available without tracking access recency on every read.
      const nextFile = this.files.keys().next();
      const nextToken = this.tokens.keys().next();
      if (nextFile.done && nextToken.done) return;
      if (!nextFile.done && (nextToken.done || this.files.size >= this.tokens.size)) {
        const entry = this.files.get(nextFile.value)!;
        this.files.delete(nextFile.value);
        this.bytes -= entry.bytes;
      } else if (!nextToken.done) {
        const entry = this.tokens.get(nextToken.value)!;
        this.tokens.delete(nextToken.value);
        this.bytes -= entry.bytes;
      }
      this.evictions += 1;
    }
  }

  /**
   * Cached file content, verified against the metadata captured at read time.
   * `stat` is injected so the cache does not need to know about the filesystem.
   */
  getFile(
    path: string,
    stat: () => { size: number; mtimeMs: number } | null,
    read: () => string | null,
  ): { content: string; hit: boolean } | null {
    const entry = this.files.get(path);
    const current = stat();
    if (!current) {
      if (entry) this.invalidatePath(path);
      return null;
    }
    if (entry && entry.size === current.size && entry.mtimeMs === current.mtimeMs) {
      this.hits += 1;
      return { content: entry.content, hit: true };
    }
    if (entry) this.invalidatePath(path);
    const content = read();
    if (content === null) return null;
    this.misses += 1;
    this.setFile(path, content, current);
    return { content, hit: false };
  }

  setFile(path: string, content: string, stat: { size: number; mtimeMs: number }): void {
    const existing = this.files.get(path);
    if (existing) this.bytes -= existing.bytes;
    const bytes = content.length * 2;
    this.files.set(path, { content, size: stat.size, mtimeMs: stat.mtimeMs, bytes, key: hashContent(content) });
    this.bytes += bytes;
    this.evictIfNeeded();
  }

  invalidatePath(path: string): void {
    const entry = this.files.get(path);
    if (!entry) return;
    this.files.delete(path);
    this.bytes -= entry.bytes;
    this.invalidations += 1;
  }

  getTokenEstimate(key: string): TokenEntry["estimate"] | null {
    const entry = this.tokens.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return entry.estimate;
  }

  setTokenEstimate(key: string, estimate: TokenEntry["estimate"]): void {
    const existing = this.tokens.get(key);
    if (existing) this.bytes -= existing.bytes;
    const bytes = 64;
    this.tokens.set(key, { estimate, bytes, key });
    this.bytes += bytes;
    this.evictIfNeeded();
  }

  clear(): void {
    this.files.clear();
    this.tokens.clear();
    this.bytes = 0;
  }

  stats(): CacheStats {
    return {
      entries: this.files.size + this.tokens.size,
      bytes: this.bytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      invalidations: this.invalidations,
    };
  }
}

export const contextCache = new ContextCache();
