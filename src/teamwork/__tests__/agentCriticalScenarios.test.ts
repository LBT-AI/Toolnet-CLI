/**
 * Integration tests for critical Agent Runtime scenarios (spec §15 A–G).
 *
 * A. create file → file exists → assistant success      (covered in codingAgentIntegration)
 * B. deny permission → no file                           (covered in codingAgentIntegration)
 * D. code-only request → no file written                 (covered in codingAgentIntegration)
 * F. Ctrl+C abort                                        (covered in codingAgentIntegration)
 *
 * This file covers the remaining critical scenarios against the real loop:
 *   C. write_file failure → never claim success
 *   E. read → edit → test → verify (coding-agent behavior)
 *   G. model without native tool calling → structured adapter drives real
 *      execution (no fake prose-driven tool calls)
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { AgentHarness } from "../../lib/harness";
import { setSandboxMode } from "../../lib/permissions";
import { setModelCapabilities } from "../../lib/reasoning";
import fs from "node:fs";
import path from "node:path";

describe.serial("Agent Runtime Critical Scenarios (C/E/G)", () => {
  const originalFetch = globalThis.fetch;
  let tmpDir: string;

  beforeEach(() => {
    setSandboxMode("full-access");
    tmpDir = fs.mkdtempSync(path.join("/tmp", "toolnet-critical-"));
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
    return async (url: string, options?: any) => {
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
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
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
  }

  function makeHarness(extra: Record<string, unknown> = {}) {
    return new AgentHarness({
      model: "test-model",
      sandboxMode: "full-access",
      workspaceRoot: tmpDir,
      currentCwd: tmpDir,
      ...extra,
    });
  }

  // ── C. write_file failure → never claim success ──────────────────────────

  test("C: write failure returns error to model, file never created", async () => {
    const harness = makeHarness();

    // write_file to a path inside a non-existent directory that cannot be
    // created (path is a file, not a dir) — forces a real tool failure.
    const blocker = path.join(tmpDir, "blocker.txt");
    fs.writeFileSync(blocker, "x");

    globalThis.fetch = createMockProvider([
      {
        tool_calls: [
          {
            id: "call_w",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: path.join(blocker, "nested.txt"), content: "x" }),
            },
          },
        ],
      },
      { content: "The write failed." },
    ]);

    const result = await harness.runHeadless("Write nested.txt under blocker.txt", {
      model: "test-model",
      maxTurns: 3,
    });

    // The tool result (an error) was fed back to the model — the loop did not
    // fabricate success, and no file exists anywhere.
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(blocker, "nested.txt"))).toBe(false);
    // Model saw the failure and responded honestly.
    expect(result.output).toContain("failed");
  });

  // ── E. read → edit → test → verify ───────────────────────────────────────

  test("E: coding-agent flow — read, edit, verify content changed", async () => {
    const harness = makeHarness();
    const target = path.join(tmpDir, "auth.ts");
    fs.writeFileSync(target, "export const token = 'old-secret';\n", "utf8");

    globalThis.fetch = createMockProvider([
      {
        tool_calls: [
          {
            id: "call_r",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: target }),
            },
          },
        ],
      },
      {
        tool_calls: [
          {
            id: "call_e",
            type: "function",
            function: {
              name: "edit_file",
              arguments: JSON.stringify({ path: target, old_string: "old-secret", new_string: "new-secret" }),
            },
          },
        ],
      },
      { content: "Fixed the token." },
    ]);

    const result = await harness.runHeadless("Fix the token in auth.ts", {
      model: "test-model",
      maxTurns: 5,
    });

    expect(result.success).toBe(true);
    expect(result.toolCallsCount).toBe(2);
    // Verify postcondition on the real filesystem:
    const content = fs.readFileSync(target, "utf8");
    expect(content).toContain("new-secret");
    expect(content).not.toContain("old-secret");
  });

  // ── G. non-native tool calling model via structured adapter ──────────────

  test("G: structured tool block drives real write_file execution", async () => {
    // Model declares NO native tool calling. It must still drive execution
    // through the structured protocol — never prose pretending.
    setModelCapabilities([{
      id: "test-model",
      capabilities: { tools: true, nativeToolCalls: false, reasoning: false, vision: false, streaming: true },
    }]);

    const harness = makeHarness();
    const structuredCall = JSON.stringify({
      type: "tool_call",
      tool: "write_file",
      arguments: { path: path.join(tmpDir, "g.py"), content: "print('structured')\n" },
    });

    globalThis.fetch = createMockProvider([
      {
        content: `Creating the file now:\n\`\`\`json\n${structuredCall}\n\`\`\``,
      },
      { content: "Created g.py via structured protocol." },
    ]);

    const result = await harness.runHeadless("Create g.py printing structured", {
      model: "test-model",
      maxTurns: 4,
    });

    // The adapter parsed the structured block → real tool execution → file exists.
    expect(result.success).toBe(true);
    expect(result.toolCallsCount).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tmpDir, "g.py"))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "g.py"), "utf8")).toBe("print('structured')\n");
  });

  test("G: prose without structured block never executes", async () => {
    setModelCapabilities([{
      id: "test-model",
      capabilities: { tools: true, nativeToolCalls: false, reasoning: false, vision: false, streaming: true },
    }]);

    const harness = makeHarness();

    // Model claims it created a file, but there is no structured tool call.
    globalThis.fetch = createMockProvider([
      {
        content: "I created fake.py for you!\n```py\nprint('hello')\n```",
      },
    ]);

    const result = await harness.runHeadless("Create fake.py", {
      model: "test-model",
      maxTurns: 2,
    });

    expect(result.success).toBe(true);
    expect(result.toolCallsCount).toBe(0);
    // No filesystem mutation happened — the claim was pure prose.
    expect(fs.existsSync(path.join(tmpDir, "fake.py"))).toBe(false);
  });

  // ── G2. model with tools:false never receives tool schemas ──────────────

  test("G2: tools:false model gets no tool definitions and cannot execute", async () => {
    setModelCapabilities([{
      id: "test-model",
      capabilities: { tools: false, nativeToolCalls: false, reasoning: false, vision: false, streaming: true },
    }]);

    const harness = makeHarness();

    let sawTools = true;
    globalThis.fetch = (async (url: string, options?: any) => {
      const reqBody = JSON.parse(options?.body || "{}");
      sawTools = reqBody.tools !== undefined;
      const body = JSON.stringify({
        id: "chatcmpl-x",
        choices: [{ message: { role: "assistant", content: "I cannot execute tools." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
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
    }) as unknown as typeof fetch;

    const result = await harness.runHeadless("Create a file", {
      model: "test-model",
      maxTurns: 2,
    });

    expect(sawTools).toBe(false);
    expect(result.success).toBe(true);
    expect(result.toolCallsCount).toBe(0);
  });
});