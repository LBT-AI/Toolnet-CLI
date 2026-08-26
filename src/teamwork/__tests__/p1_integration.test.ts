/**
 * P1 Integration Tests — Verify all execution paths use the P1 pipeline.
 *
 * Tests:
 * 1. Interactive-equivalent turn: 2 identical read_file → only 1 execution
 * 2. 3 independent read_file → parallel classification
 * 3. Large read result → compressed before next turn
 * 4. write_file → invalidates read cache
 * 5. permission approval still works and not bypassed by batching
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p1-integ-"));
}

function cleanDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

// ---------------------------------------------------------------------------
// 1. Identical read_file → only 1 execution via executeTool
// ---------------------------------------------------------------------------

describe("P1 Integration — Cache dedup via executeTool", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    fs.writeFileSync(path.join(dir, "test.txt"), "hello world content");
  });

  afterEach(() => cleanDir(dir));

  it("calling executeTool('read_file', same args) twice → second is cache hit", async () => {
    const { executeTool, getToolCache } = require("../../lib/agentTools");
    const cache = getToolCache();

    const args = { path: path.join(dir, "test.txt") };
    const r1 = await executeTool("read_file", args);
    const stats1 = cache.getStats();

    const r2 = await executeTool("read_file", args);
    const stats2 = cache.getStats();

    // Results should be identical
    expect(r1).toBe(r2);
    // Cache hits increased by 1
    expect(stats2.hits).toBe(stats1.hits + 1);
    // Misses did NOT increase (cache hit, not miss)
    expect(stats2.misses).toBe(stats1.misses);
  });
});

// ---------------------------------------------------------------------------
// 2. Independent read_file → parallel classification
// ---------------------------------------------------------------------------

describe("P1 Integration — Parallel classification", () => {
  it("classifyToolCalls puts independent reads into parallel batches", () => {
    const { classifyToolCalls } = require("../../lib/harness/toolPlanner");
    const calls = [
      { id: "1", name: "read_file", args: { path: "/a" } },
      { id: "2", name: "read_file", args: { path: "/b" } },
      { id: "3", name: "read_file", args: { path: "/c" } },
    ];
    const { parallel, sequential } = classifyToolCalls(calls, () => false);
    // All 3 reads should be parallel (single batch of 3)
    expect(parallel.length).toBe(1);
    expect(parallel[0].length).toBe(3);
    expect(sequential.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Large read result → compressed
// ---------------------------------------------------------------------------

describe("P1 Integration — Output compression via executeTool", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    // Create a large file (>8K chars to trigger compression)
    const content = "x".repeat(20_000);
    fs.writeFileSync(path.join(dir, "large.txt"), content);
  });

  afterEach(() => cleanDir(dir));

  it("executeTool('read_file', large file) returns compressed result", async () => {
    const { executeTool } = require("../../lib/agentTools");
    const args = { path: path.join(dir, "large.txt") };
    const result = await executeTool("read_file", args);
    const parsed = JSON.parse(result);

    // Should be truncated
    expect(parsed.meta).toBeDefined();
    expect(parsed.meta.truncated).toBe(true);
    expect(parsed.meta.originalChars).toBeGreaterThan(10_000);
    expect(parsed.stdout.length).toBeLessThan(parsed.meta.originalChars);
  });
});

// ---------------------------------------------------------------------------
// 4. write_file → invalidates read cache
// ---------------------------------------------------------------------------

describe("P1 Integration — Cache invalidation on write", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    fs.writeFileSync(path.join(dir, "data.txt"), "original content");
  });

  afterEach(() => cleanDir(dir));

  it("write_file to same path invalidates cached read", async () => {
    const { executeTool, getToolCache } = require("../../lib/agentTools");

    const filePath = path.join(dir, "data.txt");

    // Read → cache
    await executeTool("read_file", { path: filePath });
    const cache = getToolCache();
    expect(cache.get("read_file", { path: filePath })).not.toBeNull();

    // Write → invalidate
    await executeTool("write_file", { path: filePath, content: "new content" });
    expect(cache.get("read_file", { path: filePath })).toBeNull();

    // Read again → fresh from disk
    const r2 = JSON.parse(await executeTool("read_file", { path: filePath }));
    expect(r2.stdout).toBe("new content");
  });
});

// ---------------------------------------------------------------------------
// 5. Permission approval still works, not bypassed by batching
// ---------------------------------------------------------------------------

describe("P1 Integration — Permission approval not bypassed", () => {
  it("classifyToolCalls marks approval-required tools as sequential", () => {
    const { classifyToolCalls } = require("../../lib/harness/toolPlanner");
    const calls = [
      { id: "1", name: "shell", args: { command: "rm -rf /" } },
      { id: "2", name: "read_file", args: { path: "/safe" } },
    ];
    // Shell requires approval
    const { parallel, sequential } = classifyToolCalls(calls, (name: string) => name === "shell");
    expect(sequential.length).toBe(1);
    expect(sequential[0].name).toBe("shell");
    // read_file is still parallel
    expect(parallel.length).toBe(1);
    expect(parallel[0][0].name).toBe("read_file");
  });

  it("executeTool blocks permission-denied tools in workspace mode", async () => {
    const { executeTool } = require("../../lib/agentTools");
    const { setSandboxMode } = require("../../lib/permissions");
    const origMode = require("../../lib/permissions").getSandboxMode();

    setSandboxMode("workspace");
    try {
      const result = await executeTool("write_file", { path: "/etc/passwd", content: "hack" }, { skipPermission: false });
      const parsed = JSON.parse(result);
      // Should be blocked by sandbox
      expect(parsed.exitCode).toBe(1);
      expect(parsed.stderr.length).toBeGreaterThan(0); // blocked with reason
    } finally {
      setSandboxMode(origMode);
    }
  });
});
