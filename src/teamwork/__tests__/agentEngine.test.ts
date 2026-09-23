/**
 * Shared Agent Engine tests.
 *
 * Verifies the engine is a real single entry point: it drives the actual loop,
 * translates harness events into the AgentEvent contract, and returns verified
 * evidence (never a prose-based success claim).
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  AgentEngine,
  toAgentEvents,
  toToolResult,
} from "../../core/agent/agentEngine";
import type { AgentEvent } from "../../core/contracts";
import type { HarnessEvent } from "../../lib/harness/types";
import { setSandboxMode } from "../../lib/permissions";
import fs from "node:fs";
import path from "node:path";

// ── toToolResult ────────────────────────────────────────────────────────────

describe("toToolResult — canonical tool result", () => {
  test("parses a JSON string emitted by the executor", () => {
    const result = toToolResult(JSON.stringify({ stdout: "hi", exitCode: 0 }));
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("hi");
    expect(result.exitCode).toBe(0);
  });

  test("non-JSON string becomes stdout with ok=true", () => {
    const result = toToolResult("raw output");
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("raw output");
  });

  test("an explicit failure object stays ok=false", () => {
    const result = toToolResult({ ok: false, stderr: "denied", exitCode: 1 });
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe("denied");
  });

  test("exitCode != 0 implies ok=false when ok is absent", () => {
    const result = toToolResult({ exitCode: 2, stderr: "boom" });
    expect(result.ok).toBe(false);
  });

  test("null/undefined are treated as a trivial success", () => {
    expect(toToolResult(null).ok).toBe(true);
    expect(toToolResult(undefined).ok).toBe(true);
  });
});

// ── toAgentEvents ───────────────────────────────────────────────────────────

describe("toAgentEvents — harness → contract mapping", () => {
  function ev(type: HarnessEvent["type"], payload?: unknown): HarnessEvent {
    return { type, timestamp: Date.now(), sessionId: "s1", mode: "HEADLESS", payload };
  }

  test("agent:start → agent-start", () => {
    expect(toAgentEvents(ev("agent:start"))).toEqual([{ type: "agent-start", sessionId: "s1" }]);
  });

  test("tool:queued → tool-call with callId/name/input", () => {
    const out = toAgentEvents(ev("tool:queued", { id: "c9", toolName: "write_file", toolArgs: { path: "a.ts" } }));
    expect(out).toEqual([{ type: "tool-call", callId: "c9", name: "write_file", input: { path: "a.ts" } }]);
  });

  test("tool:complete carries a normalized ToolResult", () => {
    const out = toAgentEvents(ev("tool:complete", { id: "c1", toolName: "bash", result: JSON.stringify({ exitCode: 0, stdout: "ok" }) }));
    expect(out.length).toBe(1);
    expect(out[0].type).toBe("tool-result");
    if (out[0].type !== "tool-result") return;
    expect(out[0].result.exitCode).toBe(0);
    expect(out[0].result.stdout).toBe("ok");
  });

  test("tool:error → tool-error with a fallback message", () => {
    const out = toAgentEvents(ev("tool:error", { id: "c1" }));
    expect(out[0]).toEqual({ type: "tool-error", callId: "c1", error: "Tool execution failed" });
  });

  test("agent:error → error event", () => {
    const out = toAgentEvents(ev("agent:error", { error: "network down" }));
    expect(out).toEqual([{ type: "error", error: "network down" }]);
  });

  test("unknown harness events produce no contract events", () => {
    expect(toAgentEvents(ev("session:saved"))).toEqual([]);
  });
});

// ── End-to-end through the engine ───────────────────────────────────────────

describe.serial("AgentEngine.run — real execution path", () => {
  const originalFetch = globalThis.fetch;
  let tmpDir: string;

  beforeEach(() => {
    setSandboxMode("full-access");
    tmpDir = fs.mkdtempSync(path.join("/tmp", "toolnet-engine-"));
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  /** Returns a getter for how many model calls were made (1 = no retry). */
  function mockProvider(responses: Array<{ content?: string; tool_calls?: any[] }>): () => number {
    let turn = 0;
    globalThis.fetch = (async (_url: string) => {
      const resp = responses[turn] || { content: "Done" };
      turn++;
      const body = JSON.stringify({
        id: `chatcmpl-${turn}`,
        object: "chat.completion",
        created: Date.now(),
        model: "test-model",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: resp.content || "",
            ...(resp.tool_calls?.length ? { tool_calls: resp.tool_calls } : {}),
          },
          finish_reason: resp.tool_calls?.length ? "tool_calls" : "stop",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        type: "default",
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => JSON.parse(body),
        text: async () => body,
        clone: async () => ({ json: async () => JSON.parse(body), text: async () => body }),
      } as any;
    }) as any;
    return () => turn;
  }

  test("engine writes a real file and returns verified mutation evidence", async () => {
    const engine = new AgentEngine();
    const target = path.join(tmpDir, "hello.py");

    mockProvider([
      {
        tool_calls: [{
          id: "w1",
          type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: target, content: "print('Hello ToolNet')\n" }) },
        }],
      },
      { content: "Đã tạo và chạy thử hello.py." },
    ]);

    const events: AgentEvent[] = [];
    const result = await engine.run({
      prompt: "Tạo file hello.py in ra Hello ToolNet",
      cwd: tmpDir,
      workspaceRoot: tmpDir,
      model: "test-model",
      maxTurns: 4,
      onEvent: (e) => events.push(e),
    });

    expect(result.success).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toContain("Hello ToolNet");
    // Evidence proves the mutation — it did not come from the prose.
    expect(result.evidence.successfulMutations).toBeGreaterThanOrEqual(1);

    // The event contract was emitted, in order.
    expect(events.some((e) => e.type === "agent-start")).toBe(true);
    expect(events.some((e) => e.type === "tool-call")).toBe(true);
    expect(events.some((e) => e.type === "tool-result")).toBe(true);
    expect(events.some((e) => e.type === "agent-complete")).toBe(true);
  });

  test("continues after planning-only text when the task is not complete", async () => {
    const engine = new AgentEngine();
    mockProvider([
      { content: "Tôi sẽ tạo cấu trúc project hoàn chỉnh:" },
      {
        tool_calls: [{
          id: "w2",
          type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: path.join(tmpDir, "plan.txt"), content: "implemented" }) },
        }],
      },
      { content: "Project structure created." },
    ]);

    const result = await engine.run({
      prompt: "Create a project structure, write files, install dependencies, and test it end-to-end",
      cwd: tmpDir,
      workspaceRoot: tmpDir,
      model: "test-model",
      maxTurns: 4,
    });

    expect(result.success).toBe(true);
    expect(result.turnsUsed).toBe(3);
    expect(result.toolCalls).toBe(1);
    expect(result.evidence.successfulMutations).toBe(1);
  });

  test("does not ask an authorized user to continue mid-task", async () => {
    const engine = new AgentEngine();
    mockProvider([
      { content: "Bạn muốn tôi tiếp tục không?" },
      { content: "I will continue with the authorized work." },
      {
        tool_calls: [{
          id: "w3",
          type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: path.join(tmpDir, "authorized.txt"), content: "done" }) },
        }],
      },
      { content: "Completed the authorized task." },
    ]);

    const result = await engine.run({
      prompt: "Tự làm hết. Create and verify authorized.txt without asking for permission between steps",
      cwd: tmpDir,
      workspaceRoot: tmpDir,
      model: "test-model",
      maxTurns: 5,
    });

    expect(result.success).toBe(true);
    expect(result.output).not.toContain("Bạn muốn tôi tiếp tục không?");
    expect(result.evidence.successfulMutations).toBe(1);
  });

  test("reports max-turn exhaustion as an explicit failure", async () => {
    const engine = new AgentEngine();
    mockProvider([
      { content: "Still planning" },
      { content: "Still planning" },
    ]);

    const result = await engine.run({
      prompt: "Create and verify a file",
      cwd: tmpDir,
      workspaceRoot: tmpDir,
      model: "test-model",
      maxTurns: 2,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Exceeded maximum turn count");
    expect(result.verdict).toBe("FAILED");
  });

  test("requires a final assistant synthesis after tool-only completion", async () => {
    const engine = new AgentEngine();
    const artifact = path.join(tmpDir, ".artifacts", "report.txt");

    mockProvider([
      {
        tool_calls: [{
          id: "a1",
          type: "function",
          function: { name: "create_artifact", arguments: JSON.stringify({ name: "report.txt", content: "audit result" }) },
        }],
      },
      {
        tool_calls: [{
          id: "a2",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: artifact, offset: 0, limit: 500 }) },
        }],
      },
      { content: "" },
      { content: "Final synthesis: report.txt contains the audit result." },
    ]);

    const events: AgentEvent[] = [];
    const result = await engine.run({
      prompt: "Create report.txt and summarize it",
      cwd: tmpDir,
      workspaceRoot: tmpDir,
      model: "test-model",
      maxTurns: 4,
      onEvent: (e) => events.push(e),
    });
    expect(fs.readFileSync(artifact, "utf8")).toContain("audit result");
    expect(result.output).toContain("Final synthesis");
    const toolResults = events.filter((e) => e.type === "tool-result");
    expect(toolResults).toHaveLength(2);
    expect(new Set(toolResults.map((e) => e.callId)).size).toBe(2);
    expect(events.filter((e) => e.type === "agent-complete")).toHaveLength(1);

    const transcript = result.messages ?? [];
    const toolCallMessages = transcript.filter(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    expect(toolCallMessages).toHaveLength(2);
    expect(transcript.filter((m) => m.role === "tool")).toHaveLength(2);

    const synthesisMessages = transcript.filter(
      (m) => m.role === "assistant" && String(m.content).includes("Final synthesis") && !m.tool_calls,
    );
    expect(synthesisMessages).toHaveLength(1);
  });
  test("a tool needing approval never executes and surfaces approvalRequired", async () => {
    const engine = new AgentEngine();
    const outside = path.join(tmpDir, "..", `toolnet-outside-${process.pid}-${Date.now()}.txt`);
    mockProvider([
      {
        tool_calls: [{
          id: "p1",
          type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: outside, content: "gated" }) },
        }],
      },
      { content: "I need approval to write outside the workspace." },
    ]);

    const events: AgentEvent[] = [];
    const result = await engine.run({
      prompt: "Create a file outside the workspace",
      cwd: tmpDir,
      workspaceRoot: tmpDir,
      model: "test-model",
      sandboxMode: "ask",
      maxTurns: 4,
      onEvent: (e) => events.push(e),
    });

    // The gate is surfaced to the caller and the tool NEVER runs.
    expect(result.approvalRequired).toBe(true);
    expect(fs.existsSync(outside)).toBe(false);
    expect(result.evidence.successfulMutations).toBe(0);
    expect(events.some((e) => e.type === "error")).toBe(true);

    // The model is told approval is required instead of silently retrying.
    const toolMsg = (result.messages ?? []).find((m) => m.role === "tool");
    expect(String(toolMsg?.content)).toContain("Approval Required");
  });

  test("a permission-denied tool lets the model report the failure honestly", async () => {
    const engine = new AgentEngine();
    const readOnlyScope = { defaultDecision: "allow" as const, tools: { write_file: "deny" as const } };
    mockProvider([
      {
        tool_calls: [{
          id: "d1",
          type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: path.join(tmpDir, "denied.txt"), content: "x" }) },
        }],
      },
      { content: "I could not write denied.txt: write access is denied." },
    ]);

    const result = await engine.run({
      prompt: "Create denied.txt",
      cwd: tmpDir,
      workspaceRoot: tmpDir,
      model: "test-model",
      maxTurns: 4,
      toolPermissionSet: readOnlyScope,
    });

    // A hard denial is a real failure — the model finishes with an honest
    // report instead of being forced to loop until the turn budget runs out.
    expect(result.success).toBe(true);
    expect(result.output).toContain("denied");
    expect(fs.existsSync(path.join(tmpDir, "denied.txt"))).toBe(false);
    expect(result.evidence.successfulMutations).toBe(0);
  });

  test("a denied approval fails the run explicitly without re-asking the model", async () => {
    const engine = new AgentEngine();
    const outside = path.join(tmpDir, "..", `toolnet-denied-${process.pid}-${Date.now()}.txt`);
    const calls = mockProvider([
      {
        tool_calls: [{
          id: "p2",
          type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: outside, content: "gated" }) },
        }],
      },
      { content: "should never be reached" },
    ]);

    const asked: string[] = [];
    const result = await engine.run({
      prompt: "Create a file outside the workspace",
      cwd: tmpDir,
      workspaceRoot: tmpDir,
      model: "test-model",
      sandboxMode: "ask",
      maxTurns: 4,
      requestApproval: async (input) => {
        asked.push(input.name);
        return false;
      },
    });

    expect(asked).toEqual(["write_file"]);
    expect(result.success).toBe(false);
    expect(result.approvalRequired).toBe(true);
    expect(result.error).toContain("denied");
    expect(result.verdict).toBe("FAILED");
    // A denial is terminal for this turn: the model is never asked to continue.
    expect(calls()).toBe(1);
    expect(fs.existsSync(outside)).toBe(false);
  });

  test("an approved tool runs once and the turn continues", async () => {
    const engine = new AgentEngine();
    const outside = path.join(tmpDir, "..", `toolnet-approved-${process.pid}-${Date.now()}.txt`);
    mockProvider([
      {
        tool_calls: [{
          id: "p3",
          type: "function",
          function: { name: "write_file", arguments: JSON.stringify({ path: outside, content: "approved" }) },
        }],
      },
      { content: "Wrote the approved file." },
    ]);

    try {
      const result = await engine.run({
        prompt: "Create a file outside the workspace",
        cwd: tmpDir,
        workspaceRoot: tmpDir,
        model: "test-model",
        sandboxMode: "ask",
        maxTurns: 4,
        requestApproval: async () => true,
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      try { fs.rmSync(outside, { force: true }); } catch {}
    }
  });

  test("a pre-aborted signal short-circuits with a cancelled result", async () => {
    const engine = new AgentEngine();
    const controller = new AbortController();
    controller.abort();

    const events: AgentEvent[] = [];
    const result = await engine.run({
      prompt: "Create anything",
      cwd: tmpDir,
      workspaceRoot: tmpDir,
      model: "test-model",
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    });

    expect(result.success).toBe(false);
    expect(events.some((e) => e.type === "cancelled")).toBe(true);
  });
});
