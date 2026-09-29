import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHarness } from "../../../lib/harness";
import { setSandboxMode } from "../../../lib/permissions";
import { setModelCapabilities } from "../../../lib/reasoning";

const originalFetch = globalThis.fetch;

interface MockResponse {
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

let tmpDir: string;

beforeEach(() => {
  setSandboxMode("full-access");
  setModelCapabilities([
    {
      id: "test-model",
      capabilities: {
        tools: true,
        nativeToolCalls: true,
        reasoning: false,
        vision: false,
        streaming: false,
      },
    },
  ]);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-phase81-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function stubModel(responses: MockResponse[]) {
  let turn = 0;
  globalThis.fetch = (async (url: string, options?: { body?: string; signal?: AbortSignal }) => {
    if (options?.signal?.aborted) {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    }
    
    // Default to a stop if we run out of responses
    const response = responses[turn] ?? { content: "Done.", tool_calls: [] };
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
            content: response.content ?? "",
            ...(response.tool_calls?.length ? { tool_calls: response.tool_calls } : {}),
          },
          finish_reason: response.tool_calls?.length ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
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
    } as never;
  }) as never;
}

function callTool(id: string, name: string, args: any): MockResponse {
  return {
    content: `Thinking about ${name}...`,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }]
  };
}

describe("maxTurns reproduction", () => {
  test("agent with legitimate meaningful progress fails at maxTurns=10", async () => {
    // We want 10 unique tool calls to ensure no-progress or repeat guards DO NOT trigger.
    const responses: MockResponse[] = [
      callTool("c1", "shell", { command: "echo 1" }),
      callTool("c2", "shell", { command: "echo 2" }),
      callTool("c3", "shell", { command: "echo 3" }),
      callTool("c4", "shell", { command: "echo 4" }),
      callTool("c5", "read_file", { path: "package.json" }),
      callTool("c6", "shell", { command: "echo 6" }),
      callTool("c7", "shell", { command: "echo 7" }),
      callTool("c8", "shell", { command: "echo 8" }),
      callTool("c9", "shell", { command: "echo 9" }),
      callTool("c10", "shell", { command: "echo 10" }),
      // Turn 11 would be this, but it shouldn't reach it.
      { content: "I am finally done!" }
    ];
    
    stubModel(responses);
    
    const harness = new AgentHarness({
      workspaceRoot: tmpDir,
      currentCwd: tmpDir,
      model: "test-model",
      harness: "default"
    });
    
    // Phase 3: legacy hard-stop semantics are preserved ONLY when the caller
    // opts out of adaptive continuation (adaptiveContinuation: false).
    const result = await harness.run("Do 11 things", { maxTurns: 10, adaptiveContinuation: false });
    
    expect(result.success).toBe(false);
    expect(result.turnsUsed).toBe(10);
    expect(result.toolCallsCount).toBe(10);
    
    // Prove it failed exactly because of maxTurns, not a loop detector
    expect(result.error).toContain("Exceeded maximum turn count (10)");
  });

  test("control case: task completes early without hitting maxTurns", async () => {
    const responses: MockResponse[] = [
      callTool("c1", "shell", { command: "echo 1" }),
      callTool("c2", "shell", { command: "echo 2" }),
      { content: "I am done in 3 turns!" }
    ];
    
    stubModel(responses);
    
    const harness = new AgentHarness({
      workspaceRoot: tmpDir,
      currentCwd: tmpDir,
      model: "test-model",
      harness: "default"
    });
    
    const result = await harness.run("Do 3 things", { maxTurns: 10 });
    
    expect(result.success).toBe(true);
    expect(result.turnsUsed).toBe(3);
    expect(result.toolCallsCount).toBe(2);
    expect(result.error).toBeUndefined();
  });

  test("control case: no progress guard stops infinite loop before maxTurns", async () => {
    const responses: MockResponse[] = [
      callTool("c1", "shell", { command: "echo loop" }),
      callTool("c2", "shell", { command: "echo loop" }),
      callTool("c3", "shell", { command: "echo loop" }),
      callTool("c4", "shell", { command: "echo loop" }),
      callTool("c5", "shell", { command: "echo loop" }),
      callTool("c6", "shell", { command: "echo loop" }),
    ];
    
    stubModel(responses);
    
    const harness = new AgentHarness({
      workspaceRoot: tmpDir,
      currentCwd: tmpDir,
      model: "test-model",
      // We use tool-heavy because default disables no-progress bounds 
      // (as discovered in profiles.ts: NO_PROGRESS_BOUND_DISABLED)
      harness: "tool-heavy"
    });
    
    const result = await harness.run("Do a loop", { maxTurns: 10 });
    
    expect(result.success).toBe(false);
    // It should stop at 4 turns because CANONICAL_MAX_REPEATED_TOOL_CALLS is 3 (wait, for tool-heavy it's 2).
    // Let's check exactly what the error is.
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Infinite loop detected");
    expect(result.turnsUsed).toBeLessThan(10);
  });
});
