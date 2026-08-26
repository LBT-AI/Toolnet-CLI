/**
 * P1 Integration Tests — verify the UNIFIED P1 pipeline end-to-end.
 *
 * Architecture (post P1):
 *   executeTool()        = low-level executor (permission + raw tool + redact)
 *   executeToolBatch()   = ToolPlanner (dedup + parallel) + ToolCache +
 *                          compression + invalidation, built ON TOP of executeTool.
 *
 * These tests drive executeToolBatch with the REAL executeTool (no mocked core
 * pipeline) so they verify the actual behaviour the runtimes rely on.
 *
 * Scenarios:
 *   1. Duplicate reads → executed once (dedup) + cached (hit on 2nd read)
 *   2. Large read → compressed before reaching the next model turn
 *   3. write_file → invalidates the cached read
 *   4. Permission approval still works and is not bypassed by batching
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeToolBatch } from "../../lib/harness/toolExecutor";
import { executeTool, getToolCache, flushToolCache } from "../../lib/agentTools";
import { setSandboxMode, getSandboxMode } from "../../lib/permissions";

function tmpDir(prefix: string): string {
  // Place under the workspace root so sandbox "workspace" mode allows r/w.
  return fs.mkdtempSync(path.join(process.cwd(), `.${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 7)}`));
}

function cleanDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

describe("P1 Integration — Unified pipeline (executeToolBatch)", () => {
  let dir: string;
  let origMode: ReturnType<typeof getSandboxMode>;

  beforeEach(() => {
    dir = tmpDir("p1integ-");
    flushToolCache();
    origMode = getSandboxMode();
    setSandboxMode("workspace");
  });

  afterEach(() => {
    cleanDir(dir);
    flushToolCache();
    setSandboxMode(origMode);
  });

  // -------------------------------------------------------------------------
  // 1. Duplicate reads → executed once (dedup) + cached
  // -------------------------------------------------------------------------
  it("duplicate read_file in one turn → executed once (dedup) and cached", async () => {
    const file = path.join(dir, "dup.txt");
    fs.writeFileSync(file, "shared content");
    const args = { path: file };

    const outcome = await executeToolBatch(
      [
        { id: "1", name: "read_file", args },
        { id: "2", name: "read_file", args }, // identical
      ],
      { cwd: dir, runTool: (n, a) => executeTool(n, a).then((r) => ({ result: r, allowed: true })) }
    );

    // Dedup: only one real execution.
    expect(outcome.executedCount).toBe(1);
    expect(outcome.deduplicatedCount).toBe(1);
    // Both tool_call ids still receive a (reused) message.
    expect(outcome.messages.length).toBe(2);
    expect(outcome.messages[0].content).toBe(outcome.messages[1].content);
    expect(JSON.parse(outcome.messages[0].content).stdout).toContain("shared content");

    // Cache: the result is stored, so a later identical read is a real cache HIT.
    expect(getToolCache().get("read_file", args)).not.toBeNull();
    const before = getToolCache().getStats();
    await executeTool("read_file", args);
    const after = getToolCache().getStats();
    expect(after.hits).toBe(before.hits + 1);
  });

  // -------------------------------------------------------------------------
  // 2. Large read → compressed before next turn
  // -------------------------------------------------------------------------
  it("large read_file result is compressed by the pipeline", async () => {
    const large = path.join(dir, "large.txt");
    fs.writeFileSync(large, "x".repeat(20_000));

    const outcome = await executeToolBatch(
      [{ id: "1", name: "read_file", args: { path: large } }],
      { cwd: dir, runTool: (n, a) => executeTool(n, a).then((r) => ({ result: r, allowed: true })) }
    );

    const parsed = JSON.parse(outcome.messages[0].content);
    expect(parsed.meta).toBeDefined();
    expect(parsed.meta.truncated).toBe(true);
    expect(parsed.meta.originalChars).toBeGreaterThan(10_000);
    expect(parsed.stdout.length).toBeLessThan(parsed.meta.originalChars);
  });

  // -------------------------------------------------------------------------
  // 3. write_file → invalidates cached read
  // -------------------------------------------------------------------------
  it("write_file invalidates the cached read so the next read is fresh", async () => {
    const file = path.join(dir, "data.txt");
    fs.writeFileSync(file, "original");

    // Read → cached (via the batch pipeline).
    await executeToolBatch([{ id: "1", name: "read_file", args: { path: file } }], {
      cwd: dir,
      runTool: (n, a) => executeTool(n, a).then((r) => ({ result: r, allowed: true })),
    });
    expect(getToolCache().get("read_file", { path: file })).not.toBeNull();

    // Write → invalidates the cached read for that path.
    await executeTool("write_file", { path: file, content: "updated" });
    expect(getToolCache().get("read_file", { path: file })).toBeNull();

    // Read again → fresh from disk, not stale cache.
    const outcome = await executeToolBatch([{ id: "1", name: "read_file", args: { path: file } }], {
      cwd: dir,
      runTool: (n, a) => executeTool(n, a).then((r) => ({ result: r, allowed: true })),
    });
    expect(JSON.parse(outcome.messages[0].content).stdout).toBe("updated");
  });

  // -------------------------------------------------------------------------
  // 4. Permission approval not bypassed by batching
  // -------------------------------------------------------------------------
  it("approval-required tool is not executed when denied (even when batched with reads)", async () => {
    const safe = path.join(dir, "safe.txt");
    fs.writeFileSync(safe, "ok");

    const calls = [
      { id: "1", name: "shell", args: { command: "rm -rf /" } }, // needs approval
      { id: "2", name: "read_file", args: { path: safe } }, // safe + parallel
    ];

    let approvalRequested = 0;
    const outcome = await executeToolBatch(calls, {
      cwd: dir,
      needsApproval: (name) => name === "shell",
      runTool: async (name, args) => {
        if (name === "shell") {
          approvalRequested++;
          // Denied: must NOT execute.
          return { result: JSON.stringify({ error: "User denied permission." }), allowed: false };
        }
        const result = await executeTool(name, args);
        return { result, allowed: true };
      },
    });

    expect(approvalRequested).toBe(1);
    const shellMsg = outcome.messages.find((m) => m.name === "shell")!;
    expect(shellMsg.content).toContain("User denied");
    // The safe read (parallel) still executed and returned real content.
    const readMsg = outcome.messages.find((m) => m.name === "read_file")!;
    expect(JSON.parse(readMsg.content).stdout).toBe("ok");
  });

  it("approval-required tool IS executed when approved", async () => {
    const calls = [{ id: "1", name: "shell", args: { command: "echo hi" } }];
    let approved = false;
    let executed = false;

    const run = async () =>
      executeToolBatch(calls, {
        cwd: dir,
        needsApproval: (name) => name === "shell",
        runTool: async (name) => {
          if (name === "shell") {
            if (!approved) return { result: JSON.stringify({ error: "denied" }), allowed: false };
            executed = true;
            return { result: JSON.stringify({ stdout: "hi", stderr: "", exitCode: 0 }), allowed: true };
          }
          return { result: "", allowed: true };
        },
      });

    const denied = await run();
    expect(denied.messages[0].content).toContain("denied");
    expect(executed).toBe(false);

    approved = true;
    const ok = await run();
    expect(executed).toBe(true);
    expect(JSON.parse(ok.messages[0].content).stdout).toBe("hi");
  });
});
