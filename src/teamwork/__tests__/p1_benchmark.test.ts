/**
 * P1.11 — Performance Benchmark (P1 Core Agent Quality)
 *
 * Measures the effect of caching, deduplication, compression,
 * and workspace indexing on tool-call efficiency.
 */

import { describe, it, expect } from "bun:test";
import { ToolCache, mergeReadRanges, deduplicateToolCalls, classifyToolCalls, createMetrics } from "../../lib/harness/toolPlanner";
import { compressToolResult } from "../../lib/harness/toolOutputCompressor";

// ---------------------------------------------------------------------------
// Benchmark: Tool Cache Dedup
// ---------------------------------------------------------------------------

describe("P1 — Benchmark: Tool Cache Dedup", () => {
  it("cache eliminates repeated read_file executions", () => {
    const cache = new ToolCache();
    const args = { path: "/tmp/src/index.ts" };
    const result = JSON.stringify({ stdout: "x".repeat(5000), stderr: "", exitCode: 0 });

    // Simulate 10 identical reads
    let cacheHits = 0;
    let executions = 0;

    for (let i = 0; i < 10; i++) {
      const cached = cache.get("read_file", args);
      if (cached) {
        cacheHits++;
      } else {
        executions++;
        cache.set("read_file", args, result);
      }
    }

    expect(cacheHits).toBe(9); // 10 reads, 1 miss, 9 hits
    expect(executions).toBe(1);

    // Before cache: 10 executions. After: 1 execution.
    const dedupRatio = (executions / 10) * 100;
    expect(dedupRatio).toBeLessThanOrEqual(10); // <10% execution rate
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Read Range Merge
// ---------------------------------------------------------------------------

describe("P1 — Benchmark: Read Range Merge", () => {
  it("merging 5 adjacent reads reduces to 1", () => {
    const ranges = Array.from({ length: 5 }, (_, i) => ({
      offset: i * 100,
      limit: 100,
      callIndex: i,
    }));
    const merged = mergeReadRanges(ranges, 50);
    // 5 adjacent reads → 1 merged read
    expect(merged.length).toBe(1);
    expect(merged[0].callIndices.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Deduplication
// ---------------------------------------------------------------------------

describe("P1 — Benchmark: Deduplication", () => {
  it("removes duplicate tool calls from a batch", () => {
    const calls = [
      { id: "1", name: "read_file", args: { path: "a" } },
      { id: "2", name: "read_file", args: { path: "a" } }, // duplicate
      { id: "3", name: "grep", args: { pattern: "foo" } },
      { id: "4", name: "read_file", args: { path: "a" } }, // duplicate
      { id: "5", name: "read_file", args: { path: "b" } },
    ];
    const { kept, skipped } = deduplicateToolCalls(calls);
    expect(kept.length).toBe(3); // a, grep, b
    expect(skipped).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Parallel Classification
// ---------------------------------------------------------------------------

describe("P1 — Benchmark: Parallel Classification", () => {
  it("batching 4 reads into parallel reduces sequential overhead", () => {
    const calls = Array.from({ length: 8 }, (_, i) => ({
      id: `${i}`,
      name: "read_file",
      args: { path: `/tmp/file${i}` },
    }));
    const { parallel, sequential } = classifyToolCalls(calls, () => false);
    // 8 reads → 2 parallel batches of 4, 0 sequential
    expect(sequential.length).toBe(0);
    expect(parallel.length).toBe(2);
    expect(parallel[0].length).toBe(4);
    expect(parallel[1].length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Output Compression
// ---------------------------------------------------------------------------

describe("P1 — Benchmark: Output Compression", () => {
  it("reduces context chars significantly for large outputs", () => {
    const largeStdout = "x".repeat(50_000);
    const raw = JSON.stringify({ stdout: largeStdout, stderr: "", exitCode: 0 });
    const compressed = compressToolResult(raw, "read_file");
    const parsed = JSON.parse(compressed);

    const reduction = 1 - parsed.meta.retainedChars / raw.length;
    expect(reduction).toBeGreaterThan(0.5); // >50% reduction
    expect(parsed.meta.truncated).toBe(true);
  });

  it("preserves error details while truncating success output", () => {
    const stderr = "Error: EACCES: permission denied";
    const stdout = "y".repeat(30_000);
    const raw = JSON.stringify({ stdout, stderr, exitCode: 1 });
    const compressed = compressToolResult(raw, "shell");
    const parsed = JSON.parse(compressed);
    expect(parsed.stderr).toContain("EACCES");
    // Stdout should be truncated
    expect(parsed.stdout.length).toBeLessThan(stdout.length);
  });
});

// ---------------------------------------------------------------------------
// Benchmark: Metrics Summary
// ---------------------------------------------------------------------------

describe("P1 — Benchmark: Metrics Summary", () => {
  it("metrics object tracks all required fields", () => {
    const m = createMetrics();
    expect(m.toolCallsRequested).toBe(0);
    expect(m.toolCallsExecuted).toBe(0);
    expect(m.toolCallsDeduplicated).toBe(0);
    expect(m.toolCacheHits).toBe(0);
    expect(m.toolCallsBatched).toBe(0);
    expect(m.rawToolOutputChars).toBe(0);
    expect(m.retainedToolOutputChars).toBe(0);
  });
});
