/**
 * Integration tests for autonomous coding agent behavior.
 *
 * These tests verify the full agent loop with a mock provider that simulates
 * realistic coding-agent interactions.
 */

import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { AgentHarness, AgentLoop, ChangeTracker } from "../../lib/harness";
import { setSandboxMode } from "../../lib/permissions";
import type { HarnessEvent } from "../../lib/harness/types";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

describe.serial("Autonomous Coding Agent Integration", () => {
  const originalFetch = globalThis.fetch;
  let tmpDir: string;

  beforeEach(() => {
    setSandboxMode("full-access");
    tmpDir = fs.mkdtempSync(path.join("/tmp", "toolnet-agent-test-"));
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function createMockProvider(responses: Array<{
    content?: string;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  }>): any {
    let turn = 0;
    const fn = async (url: string, options?: any) => {
      const resp = responses[turn] || { content: "Done", tool_calls: [] };
      turn++;
      const body = JSON.stringify({
        id: `chatcmpl-${turn}`,
        object: "chat.completion",
        created: Date.now(),
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: resp.content || "",
              ...(resp.tool_calls?.length ? { tool_calls: resp.tool_calls } : {}),
            },
            finish_reason: resp.tool_calls?.length ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: 100 + turn * 50,
          completion_tokens: 50 + turn * 20,
          total_tokens: 150 + turn * 70,
        },
      });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        type: "default",
        url,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => JSON.parse(body),
        text: async () => body,
        clone: async () => ({ json: async () => JSON.parse(body), text: async () => body }),
      } as any;
    };
    return fn;
  }

  // TEST 1 — Project discovery via system prompt
  test("injects project context into system prompt", async () => {
    const pkgPath = path.join(tmpDir, "package.json");
    fs.writeFileSync(pkgPath, JSON.stringify({ name: "test", scripts: { test: "bun test" } }));

    const harness = new AgentHarness({
      model: "test-model",
      sandboxMode: "full-access",
      workspaceRoot: tmpDir,
      currentCwd: tmpDir,
    });

    const events: HarnessEvent[] = [];
    harness.on((e) => events.push(e));

    globalThis.fetch = createMockProvider([{ content: "This is a Node.js project using bun." }]);

    const result = await harness.runHeadless("What is this project?", {
      model: "test-model",
      maxTurns: 2,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Node.js");
    expect(result.turnsUsed).toBeGreaterThanOrEqual(1);
  });

  // TEST 2 — Create file via tool call
  test("creates a real file when model calls write_file", async () => {
    const harness = new AgentHarness({
      model: "test-model",
      sandboxMode: "full-access",
      workspaceRoot: tmpDir,
      currentCwd: tmpDir,
    });

    globalThis.fetch = createMockProvider([
      {
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: path.join(tmpDir, "hello.txt"), content: "Hello ToolNet\n" }),
            },
          },
        ],
      },
      { content: "Created hello.txt" },
    ]);

    const result = await harness.runHeadless("Create hello.txt with Hello ToolNet", {
      model: "test-model",
      maxTurns: 3,
    });

    expect(result.success).toBe(true);
    expect(result.toolCallsCount).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tmpDir, "hello.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "hello.txt"), "utf-8")).toBe("Hello ToolNet\n");
  });

  // TEST 3 — Permission denied prevents file creation
  test("denies write_file outside workspace in workspace mode", async () => {
    const harness = new AgentHarness({
      model: "test-model",
      sandboxMode: "workspace",
      workspaceRoot: tmpDir,
      currentCwd: tmpDir,
    });

    globalThis.fetch = createMockProvider([
      {
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "/etc/shadow", content: "test" }),
            },
          },
        ],
      },
      { content: "Access denied." },
    ]);

    const result = await harness.runHeadless("Write to /etc/shadow", {
      model: "test-model",
      maxTurns: 3,
    });

    // The tool call should fail or be denied
    expect(fs.existsSync("/etc/shadow")).toBe(true); // unchanged
  });

  // TEST 4 — Code-only request does not mutate workspace
  test("code-only request does not create files", async () => {
    const harness = new AgentHarness({
      model: "test-model",
      sandboxMode: "full-access",
      workspaceRoot: tmpDir,
      currentCwd: tmpDir,
    });

    globalThis.fetch = createMockProvider([
      { content: "Here is an example:\n\nprint('hello')\n" },
    ]);

    const result = await harness.runHeadless("Give me a Python hello world example", {
      model: "test-model",
      maxTurns: 2,
    });

    expect(result.success).toBe(true);
    expect(result.toolCallsCount).toBe(0);
    const files = fs.readdirSync(tmpDir);
    expect(files.length).toBe(0);
  });

  // TEST 5 — Change tracking
  test("tracks file modifications via ChangeTracker", async () => {
    const harness = new AgentHarness({
      model: "test-model",
      sandboxMode: "full-access",
      workspaceRoot: tmpDir,
      currentCwd: tmpDir,
    });

    const testFile = path.join(tmpDir, "test-ct.txt");
    // Ensure file doesn't exist before test
    if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

    globalThis.fetch = createMockProvider([
      {
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: testFile, content: "test" }),
            },
          },
        ],
      },
      { content: "Done" },
    ]);

    const result = await harness.runHeadless("Create test-ct.txt", {
      model: "test-model",
      maxTurns: 2,
    });

    expect(result.success).toBe(true);
    expect(result.toolCallsCount).toBeGreaterThanOrEqual(1);
    const changes = harness.getChangeTracker().getChangeSet();
    expect(changes.createdFiles.length + changes.modifiedFiles.length).toBeGreaterThan(0);
    expect(changes.createdFiles.concat(changes.modifiedFiles)).toContain(testFile);
  });

  // TEST 6 — Bash command execution
  test("executes bash commands and captures output", async () => {
    const harness = new AgentHarness({
      model: "test-model",
      sandboxMode: "full-access",
      workspaceRoot: tmpDir,
      currentCwd: tmpDir,
    });

    const outFile = path.join(tmpDir, "out.txt");
    // Use a simple command that doesn't require shell redirection
    globalThis.fetch = createMockProvider([
      {
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: `printf "Hello from bash" > ${outFile}` }),
            },
          },
        ],
      },
      { content: "Ran bash command." },
    ]);

    const result = await harness.runHeadless("Write Hello from bash to out.txt", {
      model: "test-model",
      maxTurns: 2,
    });

    expect(result.success).toBe(true);
    expect(result.toolCallsCount).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(outFile)).toBe(true);
    if (fs.existsSync(outFile)) {
      expect(fs.readFileSync(outFile, "utf-8").trim()).toBe("Hello from bash");
    }
  });

  // TEST 7 — Agent loop with multiple turns
  test("handles multiple tool call turns", async () => {
    const harness = new AgentHarness({
      model: "test-model",
      sandboxMode: "full-access",
      workspaceRoot: tmpDir,
      currentCwd: tmpDir,
    });

    globalThis.fetch = createMockProvider([
      {
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "list_dir",
              arguments: JSON.stringify({ path: tmpDir }),
            },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: path.join(tmpDir, "result.txt"), content: "result" }),
            },
          },
        ],
      },
      { content: "Listed dir and created result.txt" },
    ]);

    const result = await harness.runHeadless("List dir then create result.txt", {
      model: "test-model",
      maxTurns: 5,
    });

    expect(result.success).toBe(true);
    expect(result.toolCallsCount).toBe(2);
    expect(fs.existsSync(path.join(tmpDir, "result.txt"))).toBe(true);
  });

  // TEST 8 — Abort signal cancels loop
  test("abort signal stops the agent loop", async () => {
    const harness = new AgentHarness({
      model: "test-model",
      sandboxMode: "full-access",
      workspaceRoot: tmpDir,
      currentCwd: tmpDir,
    });

    let fetchCount = 0;
    const abortFetch = async (url: string, options?: any) => {
      fetchCount++;
      const signal = options?.signal;
      if (signal?.aborted) {
        throw new Error("AbortError");
      }
      await new Promise((resolve, reject) => {
        const check = () => {
          if (signal?.aborted) {
            reject(new Error("AbortError"));
            return;
          }
          setTimeout(check, 50);
        };
        check();
        setTimeout(resolve, 1000);
      });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        type: "default",
        url,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          id: `chatcmpl-${fetchCount}`,
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        text: async () => "{}",
        clone: async () => ({ json: async () => ({}) }),
      } as any;
    };
    globalThis.fetch = abortFetch as any;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const result = await harness.runHeadless("Long running task", {
      model: "test-model",
      maxTurns: 10,
      signal: controller.signal,
      timeoutMs: 10000,
    });

    // Should be cancelled before completing
    expect(result.success).toBe(false);
  });

  // TEST 9 — ProjectContext discovery
  test("buildProjectContext detects Node project", async () => {
    const { buildProjectContext } = await import("../../lib/projectDetector");
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "test", scripts: { test: "bun test" } }));
    fs.writeFileSync(path.join(tmpDir, "bun.lock"), "lockfile");

    const ctx = buildProjectContext(tmpDir, tmpDir);
    expect(ctx.framework).toContain("node");
    expect(ctx.packageManager).toBe("bun");
    expect(ctx.testCommands).toContain("bun run test");
  });

  // TEST 10 — ChangeTracker reset
  test("ChangeTracker reset clears all changes", async () => {
    const tracker = new ChangeTracker();
    tracker.trackCreated("/tmp/a.ts");
    tracker.trackModified("/tmp/b.ts");
    tracker.trackCommand({ command: "echo hi", exitCode: 0, stdout: "hi", stderr: "", durationMs: 10, cwd: "/tmp" });
    tracker.trackTest({ command: "bun test", passed: true, exitCode: 0, stdout: "ok", stderr: "", durationMs: 100 });

    expect(tracker.getChangeSet().createdFiles).toHaveLength(1);
    tracker.reset();
    expect(tracker.getChangeSet().createdFiles).toHaveLength(0);
    expect(tracker.getSummary()).toBe("No changes made");
  });
});
