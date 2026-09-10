/**
 * Unit tests for the Agent Runtime core modules added in the production
 * refactor: normalized model adapter (§2/§3), agent state machine (§16),
 * and the single tool registry (§4).
 */

import { test, expect, describe } from "bun:test";
import {
  parseStructuredToolCalls,
  normalizeChatResponse,
  type AgentModelResponse,
} from "../../lib/harness/modelAdapter";
import { AgentStateMachine, isValidTransition } from "../../lib/harness/agentState";
import { toolRegistry } from "../../lib/harness/toolRegistry";
import { setModelCapabilities } from "../../lib/reasoning";
import type { ChatResponse } from "../../providers/types";

// ── Model Adapter — structured tool protocol (§3) ───────────────────────────

describe("parseStructuredToolCalls", () => {
  test("parses a JSON tool_call block inside a code fence", () => {
    const content = [
      "I need to create the file:",
      "```json",
      JSON.stringify({
        type: "tool_call",
        tool: "write_file",
        arguments: { path: "test.py", content: "print('hello')" },
      }),
      "```",
    ].join("\n");

    const calls = parseStructuredToolCalls(content);
    expect(calls).not.toBeNull();
    expect(calls!.length).toBe(1);
    expect(calls![0].name).toBe("write_file");
    expect((calls![0].arguments as any).path).toBe("test.py");
  });

  test("parses a bare JSON object (no fence)", () => {
    const content = JSON.stringify({
      type: "tool_call",
      tool: "bash",
      arguments: { command: "bun test" },
    });
    const calls = parseStructuredToolCalls(content);
    expect(calls).not.toBeNull();
    expect(calls![0].name).toBe("bash");
  });

  test("parses an array of tool calls", () => {
    const content = JSON.stringify([
      { type: "tool_call", tool: "read_file", arguments: { path: "a.ts" } },
      { type: "tool_call", tool: "grep", arguments: { pattern: "foo" } },
    ]);
    const calls = parseStructuredToolCalls(content);
    expect(calls).not.toBeNull();
    expect(calls!.length).toBe(2);
    expect(calls![1].name).toBe("grep");
  });

  test("rejects unknown tools — prose cannot become a tool call", () => {
    // §3: "I created test.py" must NOT be parsed into an execution.
    const prose = "I created test.py for you! Here is the code:\nprint('hello')";
    expect(parseStructuredToolCalls(prose)).toBeNull();
  });

  test("rejects JSON that is not a tool_call type", () => {
    const content = JSON.stringify({ type: "paragraph", text: "hello" });
    expect(parseStructuredToolCalls(content)).toBeNull();
  });

  test("rejects malformed JSON silently", () => {
    expect(parseStructuredToolCalls("```json\n{ not json\n```")).toBeNull();
  });
});

describe("normalizeChatResponse", () => {
  function chatRes(overrides: Partial<ChatResponse>): ChatResponse {
    return {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: Date.now(),
      model: "test-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      ...overrides,
    } as ChatResponse;
  }

  test("normalizes native tool_calls with string arguments", () => {
    const res = chatRes({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({ path: "x.py", content: "x" }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    const norm: AgentModelResponse = normalizeChatResponse(res);
    expect(norm.toolCalls.length).toBe(1);
    expect(norm.toolCalls[0].name).toBe("write_file");
    expect((norm.toolCalls[0].arguments as any).path).toBe("x.py");
  });

  test("normalizes native tool_calls with already-object arguments", () => {
    const res = chatRes({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_2",
                type: "function",
                function: { name: "grep", arguments: { pattern: "foo" } as any },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });

    const norm = normalizeChatResponse(res);
    expect((norm.toolCalls[0].arguments as any).pattern).toBe("foo");
  });

  test("non-native model: structured block becomes toolCalls, content emptied", () => {
    setModelCapabilities([{ id: "alims-intl.llm", capabilities: { tools: true, nativeToolCalls: false, reasoning: false, vision: false, streaming: true } }]);

    const res = chatRes({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: [
              "```json",
              JSON.stringify({
                type: "tool_call",
                tool: "write_file",
                arguments: { path: "g.py", content: "print(1)" },
              }),
              "```",
            ].join("\n"),
          },
          finish_reason: "stop",
        },
      ],
    });

    const norm = normalizeChatResponse(res, "alims-intl.llm");
    expect(norm.toolCalls.length).toBe(1);
    expect(norm.toolCalls[0].name).toBe("write_file");
    expect(norm.content).toBe("");
  });

  test("non-native model: plain prose stays text, no tool calls", () => {
    setModelCapabilities([{ id: "alims-intl.llm", capabilities: { tools: true, nativeToolCalls: false, reasoning: false, vision: false, streaming: true } }]);

    const res = chatRes({
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "I created test.py for you — here is the code:\n```py\nprint('x')\n```",
          },
          finish_reason: "stop",
        },
      ],
    });

    const norm = normalizeChatResponse(res, "alims-intl.llm");
    expect(norm.toolCalls.length).toBe(0);
    expect(norm.content).toContain("I created test.py");
  });
});

// ── Agent State Machine (§16) ───────────────────────────────────────────────

describe("AgentStateMachine", () => {
  test("starts idle and transitions through valid path", () => {
    const sm = new AgentStateMachine();
    expect(sm.state).toBe("idle");

    sm.transition("thinking");
    sm.transition("executing-tool");
    sm.transition("verifying");
    sm.transition("thinking");
    sm.transition("responding");

    expect(sm.state).toBe("responding");
    expect(sm.isBusy()).toBe(true);
  });

  test("responding can return to idle", () => {
    const sm = new AgentStateMachine();
    sm.transition("thinking");
    sm.transition("responding");
    sm.transition("idle");
    expect(sm.state).toBe("idle");
  });

  test("cancelled and error are terminal-ish states", () => {
    const sm = new AgentStateMachine();
    sm.transition("thinking");
    sm.transition("cancelled");
    expect(sm.isTerminal()).toBe(true);
    expect(sm.isBusy()).toBe(false);

    const sm2 = new AgentStateMachine();
    sm2.transition("thinking");
    sm2.transition("error");
    expect(sm2.isTerminal()).toBe(true);
  });

  test("isValidTransition rejects illegal jumps", () => {
    expect(isValidTransition("idle", "executing-tool")).toBe(false);
    expect(isValidTransition("idle", "responding")).toBe(false);
    expect(isValidTransition("executing-tool", "responding")).toBe(false);
    expect(isValidTransition("responding", "executing-tool")).toBe(false);
    expect(isValidTransition("idle", "thinking")).toBe(true);
  });

  test("notifies listeners on transition", () => {
    const sm = new AgentStateMachine();
    const seen: Array<{ s: string; prev: string }> = [];
    sm.onTransition((s, prev) => seen.push({ s, prev }));
    sm.transition("thinking");
    sm.transition("responding");
    expect(seen).toEqual([
      { s: "thinking", prev: "idle" },
      { s: "responding", prev: "thinking" },
    ]);
  });

  test("history records transitions", () => {
    const sm = new AgentStateMachine();
    sm.transition("thinking");
    sm.transition("error");
    const h = sm.getHistory();
    expect(h.length).toBe(2);
    expect(h[0].from).toBe("idle");
    expect(h[0].to).toBe("thinking");
    expect(h[1].to).toBe("error");
  });
});

// ── Tool Registry (§4) ──────────────────────────────────────────────────────

describe("toolRegistry", () => {
  test("every tool has name, description, parameters, risk, execute", () => {
    const tools = toolRegistry.list();
    expect(tools.length).toBeGreaterThan(20);

    for (const t of tools) {
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.parameters).toBeTruthy();
      expect(["read", "write", "execute", "network"]).toContain(t.risk);
      expect(typeof t.execute).toBe("function");
    }
  });

  test("mutating tools carry verify hooks", () => {
    for (const name of ["write_file", "edit_file", "replace_all", "apply_patch", "create_artifact"]) {
      const t = toolRegistry.get(name);
      expect(t).toBeDefined();
      expect(typeof t!.verify).toBe("function");
      expect(t!.risk).toBe("write");
    }
  });

  test("schemas() returns provider-compatible function definitions", () => {
    const schemas = toolRegistry.schemas();
    const wf = schemas.find((s) => (s as any).function.name === "write_file");
    expect(wf).toBeDefined();
    expect((wf as any).type).toBe("function");
    expect((wf as any).function.parameters.required).toContain("path");
    expect((wf as any).function.parameters.required).toContain("content");
  });

  test("riskOf classifies read vs execute vs network", () => {
    expect(toolRegistry.riskOf("read_file")).toBe("read");
    expect(toolRegistry.riskOf("bash")).toBe("execute");
    expect(toolRegistry.riskOf("shell")).toBe("execute");
    expect(toolRegistry.riskOf("web_fetch")).toBe("network");
    expect(toolRegistry.riskOf("nonexistent_tool")).toBeUndefined();
  });

  test("schemasFiltered supports plan-mode read-only subsets", () => {
    const readOnly = toolRegistry.schemasFiltered((t) => t.risk === "read");
    const names = readOnly.map((s) => (s as any).function.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("bash");
  });
});