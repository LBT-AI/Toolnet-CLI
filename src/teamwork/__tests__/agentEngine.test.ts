/**
 * Phase 73.5 — Shared Agent Engine tests.
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

  function mockProvider(responses: Array<{ content?: string; tool_calls?: any[] }>): void {
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

  test("engine refuses a text-only success for a mutation request", async () => {
    const engine = new AgentEngine();

    mockProvider([
      { content: "I created note.txt for you." },
      { content: "Done" },
    ]);

    const result = await engine.run({
      prompt: "Create note.txt",
      cwd: tmpDir,
      workspaceRoot: tmpDir,
      model: "test-model",
      maxTurns: 2,
    });

    expect(fs.existsSync(path.join(tmpDir, "note.txt"))).toBe(false);
    expect(result.success).toBe(false);
    expect(result.evidence.successfulMutations).toBe(0);
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
