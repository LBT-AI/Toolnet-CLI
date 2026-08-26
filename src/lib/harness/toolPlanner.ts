/**
 * ToolPlanner — Tool Dedup, Cache, Read-Range Merge, Parallel Dispatch
 *
 * Responsibilities:
 *  1. Signature-based cache for read-only tools
 *  2. Deduplication of identical tool calls
 *  3. Merging adjacent/overlapping read_file ranges
 *  4. Parallel dispatch for independent read-only calls
 *  5. Cache invalidation on write/edit/patch
 *  6. Metrics tracking
 */

// ─── Read-only tool set ──────────────────────────────────────────────────────

const READ_ONLY_TOOLS = new Set([
  "read_file",
  "grep",
  "grep_search",
  "glob",
  "glob_search",
  "find_path",
  "list_dir",
  "tree",
  "file_exists",
  "git_status",
  "git_diff",
]);

const WRITE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "replace_all",
  "apply_patch",
]);

// ─── Cache ───────────────────────────────────────────────────────────────────

export interface CacheEntry {
  result: string;
  timestamp: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  invalidations: number;
  deduplicates: number;
  readsMerged: number;
}

export class ToolCache {
  private cache = new Map<string, CacheEntry>();
  private signatureCount = new Map<string, number>();
  private stats: CacheStats = { hits: 0, misses: 0, invalidations: 0, deduplicates: 0, readsMerged: 0 };

  /**
   * Generate a stable signature for a tool call.
   * For read_file with offset/limit, uses only path (range merge handles offsets).
   */
  getSignature(name: string, args: any): string {
    if (name === "read_file" || name === "file_exists") {
      const path = args?.path ?? "";
      return `${name}:${path}`;
    }
    // For grep/glob: normalize args deterministically
    if (name === "grep" || name === "grep_search") {
      return `${name}:${args?.pattern ?? ""}:${args?.path ?? "."}:${args?.include ?? ""}`;
    }
    if (name === "glob" || name === "glob_search") {
      return `${name}:${args?.pattern ?? ""}:${args?.path ?? "."}`;
    }
    if (name === "find_path") {
      return `${name}:${args?.query ?? ""}:${args?.root ?? ""}:${args?.type ?? ""}`;
    }
    if (name === "git_status") {
      return `${name}:${args?.path ?? ""}`;
    }
    if (name === "git_diff") {
      return `${name}:${args?.path ?? ""}:${args?.staged ?? false}`;
    }
    if (name === "list_dir" || name === "tree") {
      return `${name}:${args?.path ?? "."}:${args?.depth ?? ""}`;
    }
    // Non-cacheable tools get a unique signature per invocation
    return `${name}:${JSON.stringify(args)}`;
  }

  /** Check cache for a read-only tool call. Returns null on miss. */
  get(name: string, args: any): string | null {
    if (!READ_ONLY_TOOLS.has(name)) return null;
    const sig = this.getSignature(name, args);
    const entry = this.cache.get(sig);
    if (entry) {
      this.stats.hits++;
      return entry.result;
    }
    this.stats.misses++;
    return null;
  }

  /** Store a result in cache. */
  set(name: string, args: any, result: string): void {
    if (!READ_ONLY_TOOLS.has(name)) return;
    const sig = this.getSignature(name, args);
    this.cache.set(sig, { result, timestamp: Date.now() });
  }

  /** Invalidate cache entries for a given file path. Called on write/edit/patch. */
  invalidateByPath(filePath: string): void {
    const normalized = filePath.replace(/\\/g, "/");
    const keysToInvalidate: string[] = [];
    for (const [key] of this.cache) {
      if (key.includes(normalized)) {
        keysToInvalidate.push(key);
      }
    }
    for (const key of keysToInvalidate) {
      this.cache.delete(key);
      this.stats.invalidations++;
    }
  }

  /** Invalidate all cache (e.g. on shell command execution). */
  invalidateAll(): void {
    this.cache.clear();
  }

  /** Track a deduplication event. */
  trackDedup(): void {
    this.stats.deduplicates++;
  }

  /** Track a merged range read. */
  trackMerge(): void {
    this.stats.readsMerged++;
  }

  getStats(): CacheStats {
    return { ...this.stats };
  }

  clear(): void {
    this.cache.clear();
    this.signatureCount.clear();
    this.stats = { hits: 0, misses: 0, invalidations: 0, deduplicates: 0, readsMerged: 0 };
  }
}

// ─── Read Range Merge ────────────────────────────────────────────────────────

export interface ReadRange {
  offset: number;
  limit: number;
  callIndex: number; // original position in tool_calls array
}

export interface MergedRange {
  offset: number;
  limit: number;
  callIndices: number[];
}

/**
 * Merge adjacent/overlapping read_file ranges for the same file.
 *
 * Given ranges sorted by offset, merges those that overlap or are within
 * MAX_GAP lines of each other.
 */
export function mergeReadRanges(ranges: ReadRange[], maxGap = 50): MergedRange[] {
  if (ranges.length === 0) return [];

  const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
  const merged: MergedRange[] = [];
  let current: MergedRange = {
    offset: sorted[0].offset,
    limit: sorted[0].limit,
    callIndices: [sorted[0].callIndex],
  };

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const currentEnd = current.offset + current.limit;
    // Merge if next starts within current range + gap
    if (next.offset <= currentEnd + maxGap) {
      const nextEnd = next.offset + next.limit;
      current.limit = Math.max(current.limit, nextEnd - current.offset);
      current.callIndices.push(next.callIndex);
    } else {
      merged.push(current);
      current = {
        offset: next.offset,
        limit: next.limit,
        callIndices: [next.callIndex],
      };
    }
  }
  merged.push(current);
  return merged;
}

// ─── Parallel Dispatch ───────────────────────────────────────────────────────

const PARALLEL_READ_TOOLS = new Set([
  "read_file",
  "grep",
  "grep_search",
  "glob",
  "glob_search",
  "find_path",
  "list_dir",
  "tree",
  "file_exists",
  "git_status",
  "git_diff",
]);

/** Maximum concurrent parallel tool calls */
const PARALLEL_CONCURRENCY = 4;

export interface ToolCall {
  id: string;
  name: string;
  args: any;
}

export interface DispatchResult {
  id: string;
  name: string;
  result: string;
}

/**
 * Classify tool calls into parallel-safe and sequential batches.
 */
export function classifyToolCalls(
  calls: ToolCall[],
  needsApproval: (name: string, args: any) => boolean
): { parallel: ToolCall[][]; sequential: ToolCall[] } {
  const parallel: ToolCall[][] = [];
  const sequential: ToolCall[] = [];

  // Group consecutive parallel-safe calls into batches
  let currentBatch: ToolCall[] = [];

  for (const call of calls) {
    const isParallelSafe =
      PARALLEL_READ_TOOLS.has(call.name) &&
      !needsApproval(call.name, call.args) &&
      !WRITE_TOOLS.has(call.name);

    if (isParallelSafe) {
      currentBatch.push(call);
      if (currentBatch.length >= PARALLEL_CONCURRENCY) {
        parallel.push(currentBatch);
        currentBatch = [];
      }
    } else {
      if (currentBatch.length > 0) {
        parallel.push(currentBatch);
        currentBatch = [];
      }
      sequential.push(call);
    }
  }

  if (currentBatch.length > 0) {
    parallel.push(currentBatch);
  }

  return { parallel, sequential };
}

// ─── Duplication Detection ───────────────────────────────────────────────────

/**
 * Detect and skip duplicate tool calls within a single assistant response.
 * Returns the indices of calls to keep (first occurrence wins).
 */
export function deduplicateToolCalls(calls: ToolCall[]): { kept: ToolCall[]; skipped: number } {
  const seen = new Map<string, number>();
  const kept: ToolCall[] = [];
  let skipped = 0;

  for (const call of calls) {
    const sig = `${call.name}:${JSON.stringify(call.args)}`;
    const count = seen.get(sig) ?? 0;
    if (count >= 1) {
      skipped++;
      continue;
    }
    seen.set(sig, count + 1);
    kept.push(call);
  }

  return { kept, skipped };
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

export interface ToolPlannerMetrics {
  toolCallsRequested: number;
  toolCallsExecuted: number;
  toolCallsDeduplicated: number;
  toolCacheHits: number;
  toolCallsBatched: number;
  rawToolOutputChars: number;
  retainedToolOutputChars: number;
}

export function createMetrics(): ToolPlannerMetrics {
  return {
    toolCallsRequested: 0,
    toolCallsExecuted: 0,
    toolCallsDeduplicated: 0,
    toolCacheHits: 0,
    toolCallsBatched: 0,
    rawToolOutputChars: 0,
    retainedToolOutputChars: 0,
  };
}
