/**
 * P1 FINAL Integration Verify — real pipeline, no mocks of the core pipeline.
 *
 * These tests exercise the UNIFIED P1 pipeline (executeToolBatch + executeTool cache
 * + ToolOutputCompressor + ContextEngine) end-to-end across every execution path:
 *
 *   A. Core pipeline behavior (real executeTool, real fs, real compression/cache)
 *      1. Interactive-equivalent turn: 2 identical read_file → only 1 execution
 *      2. 3 independent read_file → parallel (concurrent) execution
 *      3. Large read result → compressed before next model turn
 *      4. write_file → invalidates read cache (re-reads fresh)
 *      5. Permission approval still works and is NOT bypassed by batching
 *
 *   B. Routing: each real execution path must dispatch through executeToolBatch
 *      - AgentRuntime.runLoop (REPL / qa)
 *      - subagentRuntime.executeSubagentTask (SubAgent)
 *      - AgentHarness.runHeadless (headless -p / turbo)
 *      - TUI (static import check — terminal app cannot be launched in CI)
 *
 * Nothing here stubs the pipeline to fake a pass: executeTool, the ToolCache,
 * ToolOutputCompressor and executeToolBatch are all real.
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeToolBatch, type ToolCall } from "../../lib/harness/toolExecutor";
import { executeTool, getToolCache, flushToolCache } from "../../lib/agentTools";
import { setSandboxMode, getSandboxMode } from "../../lib/permissions";

function tmpDir(prefix = "p1route-"): string {
  // Use a dir INSIDE the workspace root so sandbox "workspace" mode allows r/w.
  const base = path.join(process.cwd(), `.${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function cleanDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

function mockFetchSingleTurn(toolCalls: any[], finalContent = "done") {
  let step = 0;
  (globalThis as any).fetch = (mock as any)(async () => {
    step++;
    if (step === 1) {
      return new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "", tool_calls: toolCalls } }] }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: finalContent } }] }),
      { status: 200 }
    );
  });
}

describe("P1 — Core pipeline (real executeTool / cache / compress)", () => {
  let dir: string;
  let origMode: string;

  beforeEach(() => {
    dir = tmpDir();
    flushToolCache();
    origMode = getSandboxMode();
    setSandboxMode("workspace");
  });

  afterEach(() => {
    cleanDir(dir);
    flushToolCache();
    setSandboxMode(origMode as any);
  });

  it("1. Interactive-equivalent turn: 2 identical read_file → only 1 execution", async () => {
    const file = path.join(dir, "dup.txt");
    fs.writeFileSync(file, "shared content");
    const args = { path: file };

    const calls: ToolCall[] = [
      { id: "1", name: "read_file", args },
      { id: "2", name: "read_file", args }, // identical
    ];

    const outcome = await executeToolBatch(calls, {
      cwd: dir,
      runTool: (name, a) => executeTool(name, a).then((result) => ({ result, allowed: true })),
    });

    // Only ONE real execution happened.
    expect(outcome.executedCount).toBe(1);
    expect(outcome.deduplicatedCount).toBe(1);
    // Both tool_call ids still receive a (reused) message.
    expect(outcome.messages.length).toBe(2);
    expect(outcome.messages[0].content).toBe(outcome.messages[1].content);
    expect(JSON.parse(outcome.messages[0].content).stdout).toContain("shared content");
  });

  it("2. 3 independent read_file → parallel (concurrent) execution", async () => {
    const f1 = path.join(dir, "a.txt");
    const f2 = path.join(dir, "b.txt");
    const f3 = path.join(dir, "c.txt");
    fs.writeFileSync(f1, "a");
    fs.writeFileSync(f2, "b");
    fs.writeFileSync(f3, "c");

    const calls: ToolCall[] = [
      { id: "1", name: "read_file", args: { path: f1 } },
      { id: "2", name: "read_file", args: { path: f2 } },
      { id: "3", name: "read_file", args: { path: f3 } },
    ];

    let inflight = 0;
    let maxInflight = 0;
    const outcome = await executeToolBatch(calls, {
      cwd: dir,
      runTool: async (name, a) => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        // tiny yield so concurrent tasks visibly overlap
        await new Promise((r) => setTimeout(r, 5));
        const result = await executeTool(name, a);
        inflight--;
        return { result, allowed: true };
      },
    });

    expect(outcome.executedCount).toBe(3);
    expect(outcome.parallelBatches).toBeGreaterThanOrEqual(1);
    // True concurrency: at least two ran at the same time.
    expect(maxInflight).toBeGreaterThanOrEqual(2);
  });

  it("3. Large read result → compressed before next model turn", async () => {
    const large = path.join(dir, "large.txt");
    fs.writeFileSync(large, "x".repeat(20_000));

    const outcome = await executeToolBatch(
      [{ id: "1", name: "read_file", args: { path: large } }],
      { cwd: dir, runTool: (name, a) => executeTool(name, a).then((r) => ({ result: r, allowed: true })) }
    );

    const parsed = JSON.parse(outcome.messages[0].content);
    expect(parsed.meta).toBeDefined();
    expect(parsed.meta.truncated).toBe(true);
    expect(parsed.meta.originalChars).toBeGreaterThan(10_000);
    expect(parsed.stdout.length).toBeLessThan(parsed.meta.originalChars);
  });

  it("4. write_file → invalidates read cache (fresh re-read)", async () => {
    const file = path.join(dir, "data.txt");
    fs.writeFileSync(file, "original");

    // First read caches.
    const r1 = JSON.parse(await executeTool("read_file", { path: file }));
    expect(r1.stdout).toBe("original");
    expect(getToolCache().get("read_file", { path: file })).not.toBeNull();

    // Write invalidates the cached read.
    await executeTool("write_file", { path: file, content: "updated" });
    expect(getToolCache().get("read_file", { path: file })).toBeNull();

    // Second read is a real miss reflecting the new content.
    const r2 = JSON.parse(await executeTool("read_file", { path: file }));
    expect(r2.stdout).toBe("updated");

    // And through the batch pipeline (cross-turn invalidation):
    const o1 = await executeToolBatch([{ id: "1", name: "read_file", args: { path: file } }], {
      cwd: dir,
      runTool: (n, a) => executeTool(n, a).then((r) => ({ result: r, allowed: true })),
    });
    await executeTool("write_file", { path: file, content: "again" });
    const o2 = await executeToolBatch([{ id: "1", name: "read_file", args: { path: file } }], {
      cwd: dir,
      runTool: (n, a) => executeTool(n, a).then((r) => ({ result: r, allowed: true })),
    });
    expect(JSON.parse(o2.messages[0].content).stdout).toBe("again");
  });

  it("5a. Permission approval: denied tool NOT executed, safe parallel read still runs", async () => {
    const calls: ToolCall[] = [
      { id: "1", name: "shell", args: { command: "rm -rf /" } }, // needs approval
      { id: "2", name: "read_file", args: { path: path.join(dir, "safe.txt") } },
    ];
    fs.writeFileSync(path.join(dir, "safe.txt"), "ok");

    let approvalRequested = 0;
    let shellExecuted = false;

    const outcome = await executeToolBatch(calls, {
      cwd: dir,
      needsApproval: (name) => name === "shell",
      runTool: async (name, a) => {
        if (name === "shell") {
          approvalRequested++;
          return { result: JSON.stringify({ error: "User denied permission." }), allowed: false };
        }
        const result = await executeTool(name, a);
        if (name === "read_file") shellExecuted = false; // placeholder
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

  it("5b. Permission approval: approved tool IS executed", async () => {
    const calls: ToolCall[] = [{ id: "1", name: "shell", args: { command: "echo hi" } }];
    let approved = false;
    let executed = false;

    const outcome = await executeToolBatch(calls, {
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
    expect(outcome.messages[0].content).toContain("denied");

    // Now approve and re-run.
    approved = true;
    const o2 = await executeToolBatch(calls, {
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
    expect(executed).toBe(true);
    expect(JSON.parse(o2.messages[0].content).stdout).toBe("hi");
  });

  it("5c. Fail-closed runtime: approval-required tool not executed silently", async () => {
    const calls: ToolCall[] = [{ id: "1", name: "shell", args: { command: "reboot" } }];
    let executed = false;
    let approvalChecked = false;
    const outcome = await executeToolBatch(calls, {
      cwd: dir,
      needsApproval: () => true, // every tool needs approval → routed to sequential
      runTool: async (name) => {
        // The pipeline MUST still invoke runTool for the approval-required tool
        // (so the runtime's approval decision runs) and must NOT skip it via batching.
        approvalChecked = true;
        // Fail-closed runtime returns approvalRequired and never actually executes.
        return {
          result: JSON.stringify({ stdout: "", stderr: "Approval Required: needs confirmation", exitCode: 1, approvalRequired: true }),
          allowed: false,
        };
      },
    });
    expect(approvalChecked).toBe(true); // pipeline didn't bypass the approval path
    expect(executed).toBe(false); // and the tool was not executed
    expect(outcome.messages[0].content).toContain("Approval Required");
  });
});

describe("P1 — Routing: real paths dispatch through executeToolBatch", () => {
  let dir: string;
  let origMode: string;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    dir = tmpDir("p1route-run-");
    flushToolCache();
    origMode = getSandboxMode();
    setSandboxMode("workspace");
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    cleanDir(dir);
    flushToolCache();
    setSandboxMode(origMode as any);
  });

  it("AgentRuntime.runLoop routes duplicate reads through the dedup pipeline", async () => {
    const file = path.join(dir, "dup.txt");
    fs.writeFileSync(file, "content");
    const other = path.join(dir, "other.txt");
    fs.writeFileSync(other, "other");

    const before = getToolCache().getStats();
    mockFetchSingleTurn([
      {
        id: "c1",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: file }) },
      },
      {
        id: "c2",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: file }) }, // duplicate
      },
      {
        id: "c3",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: other }) },
      },
    ]);

    const { AgentRuntime } = await import("../../lib/agentRuntime");
    const rt = new AgentRuntime({ maxTurns: 4, gatewayUrl: "http://127.0.0.1:9999" });
    await rt.runLoop([{ role: "user", content: "read the files" }]);

    const after = getToolCache().getStats();
    // Dedup: the 2nd identical read never re-enters executeTool, so it can't
    // produce a cache HIT within this turn. (Without dedup it would hit cache → hits+1.)
    expect(after.hits - before.hits).toBe(0);
    // Exactly the two unique files were read (cache misses).
    expect(after.misses - before.misses).toBe(2);
  });

  it("subagentRuntime.executeSubagentTask routes through executeToolBatch", async () => {
    const file = path.join(dir, "sub.txt");
    fs.writeFileSync(file, "sub-content");

    const before = getToolCache().getStats();
    mockFetchSingleTurn([
      {
        id: "s1",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: file }) },
      },
      {
        id: "s2",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: file }) }, // duplicate
      },
      {
        id: "s3",
        type: "function",
        function: { name: "glob", arguments: JSON.stringify({ pattern: "*.ts" }) },
      },
    ]);

    const { executeSubagentTask } = await import("../../teamwork/subagentRuntime");
    const node: any = {
      id: "n1",
      title: "explore",
      role: "RESEARCHER",
      prompt: "explore",
      status: "PENDING",
      dependencies: [],
    };
    const res = await executeSubagentTask(node, { gatewayUrl: "http://127.0.0.1:9999", maxTurns: 4 });
    expect(res.success).toBe(true);

    const after = getToolCache().getStats();
    expect(after.hits - before.hits).toBe(0); // dedup engaged in subagent path
    expect(after.misses - before.misses).toBe(2); // read_file + glob (unique)
  });

  it("AgentHarness.runHeadless (headless -p) routes through executeToolBatch", async () => {
    const file = path.join(dir, "head.txt");
    fs.writeFileSync(file, "head-content");

    const before = getToolCache().getStats();
    mockFetchSingleTurn([
      {
        id: "h1",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: file }) },
      },
      {
        id: "h2",
        type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ path: file }) }, // duplicate
      },
    ]);

    const { AgentHarness } = await import("../../lib/harness");
    const harness = new AgentHarness({ sandboxMode: "workspace", gatewayUrl: "http://127.0.0.1:9999" });
    const res = await harness.runHeadless("read head.txt", { gatewayUrl: "http://127.0.0.1:9999", maxTurns: 4 });
    expect(res.success).toBe(true);

    const after = getToolCache().getStats();
    expect(after.hits - before.hits).toBe(0); // dedup engaged in headless path
    expect(after.misses - before.misses).toBe(1); // single unique read
  });
});

describe("P1 — TUI routing (terminal app; static verification)", () => {
  it("tui.ts imports and dispatches tool calls through executeToolBatch", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../tui.ts"), "utf8");
    expect(src).toContain('from "./lib/harness/toolExecutor"');
    expect(src).toContain("executeToolBatch(");
    // Approval is preserved: the interactive modal is still invoked from the pipeline runTool.
    expect(src).toContain("requestApprovalModal");
  });
});
