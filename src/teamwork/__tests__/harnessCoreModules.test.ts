/**
 * Unit tests for the Agent Runtime core modules added in the production
 * refactor: normalized model adapter (§2/§3), agent state machine (§16),
 * and the single tool registry (§4).
 */

import { test, expect, describe } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  parseStructuredToolCalls,
  normalizeChatResponse,
  type AgentModelResponse,
} from "../../lib/harness/modelAdapter";
import { AgentStateMachine, isValidTransition } from "../../lib/harness/agentState";
import { toolRegistry } from "../../lib/harness/toolRegistry";
import { agentTools } from "../../lib/agentTools";
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

  // §30 — full P0 lifecycle: understanding → gathering-context → thinking →
  // executing-tool → verifying → testing → responding
  test("full P0 lifecycle transitions are valid", () => {
    const sm = new AgentStateMachine();
    expect(sm.state).toBe("idle");

    sm.transition("understanding");
    sm.transition("gathering-context");
    sm.transition("thinking");
    sm.transition("executing-tool");
    sm.transition("verifying");
    sm.transition("testing");
    sm.transition("responding");
    sm.transition("idle");

    expect(sm.state).toBe("idle");
    expect(sm.getHistory().map((h) => h.to)).toEqual([
      "understanding",
      "gathering-context",
      "thinking",
      "executing-tool",
      "verifying",
      "testing",
      "responding",
      "idle",
    ]);
  });

  test("understanding can short-circuit to responding (pure question)", () => {
    const sm = new AgentStateMachine();
    sm.transition("understanding");
    sm.transition("responding");
    expect(sm.state).toBe("responding");
  });

  test("gathering-context can go straight to executing-tool", () => {
    const sm = new AgentStateMachine();
    sm.transition("understanding");
    sm.transition("gathering-context");
    sm.transition("executing-tool");
    expect(sm.state).toBe("executing-tool");
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

// ── Phase 73.10 — canonical names + one primary execution path ───────────────

describe("toolRegistry — canonical names (no aliases exposed to the model)", () => {
  test("schemas() exposes exactly one name per capability", () => {
    const names = toolRegistry.schemas().map((s) => (s as any).function.name);
    expect(names).toContain("shell");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("run_command");
    expect(names).toContain("grep");
    expect(names).not.toContain("grep_search");
    expect(names).toContain("glob");
    expect(names).not.toContain("glob_search");
  });

  test("aliases still resolve for dispatch and back-compat", () => {
    expect(toolRegistry.get("bash")?.aliasOf).toBe("shell");
    expect(toolRegistry.get("run_command")?.aliasOf).toBe("shell");
    expect(toolRegistry.get("grep_search")?.aliasOf).toBe("grep");
    expect(toolRegistry.get("glob_search")?.aliasOf).toBe("glob");
    expect(toolRegistry.riskOf("run_command")).toBe("execute");
  });

  test("canonicalNames() lists the model-visible set", () => {
    const names = toolRegistry.canonicalNames();
    expect(names).toContain("write_file");
    expect(names).not.toContain("bash");
  });
});

describe("ARCHITECTURE — one primary execution path", () => {
  const libDir = path.join(__dirname, "../../lib");

  function collectTs(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectTs(full, out);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      out.push(full);
    }
    return out;
  }

  test("only modelAdapter.ts calls provider.chat/stream in src/lib", () => {
    const offenders = collectTs(libDir).filter((file) => {
      if (file.endsWith(path.join("harness", "modelAdapter.ts"))) return false;
      const src = fs.readFileSync(file, "utf8");
      return /provider\.(chat|stream)\(/.test(src);
    });
    expect(offenders.map((f) => path.relative(libDir, f))).toEqual([]);
  });

  test("agentHarness routes LLM calls through ModelAdapter, not provider.chat", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../lib/harness/agentHarness.ts"),
      "utf8"
    );
    expect(src).toMatch(/new ModelAdapter\(/);
    expect(src).not.toMatch(/provider\.chat\(/);
  });

  test("agentWiring delegates tool routing to the shared engine", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../tui/events/agentWiring.ts"),
      "utf8"
    );
    expect(src).toMatch(/agentEngine\.run\(/);
    expect(src).not.toMatch(/provider\.(chat|stream)\(/);
    expect(src).not.toMatch(/delta\.tool_calls/);
    expect(src).not.toMatch(/executeToolBatch\(/);
  });
});

// ── Phase 73.11 — single definition source & interface parity ────────────────

describe("ARCHITECTURE — single definition source and interface parity", () => {
  const srcDir = path.join(__dirname, "../..");
  const read = (rel: string): string => fs.readFileSync(path.join(srcDir, rel), "utf8");

  test("the model-facing schema array is derived from the canonical registry", () => {
    const src = read("lib/agentTools.ts");
    expect(src).toMatch(/export const agentTools = toolRegistry\.schemas\(\)/);
    // A hand-maintained array literal is the duplicate source we removed.
    expect(src).not.toMatch(/export const agentTools = \[\s*\n\s*\{/);
  });

  test("agentTools exposes canonical names only (aliases stay dispatch-only)", () => {
    const names = agentTools.map((t: any) => t.function.name);
    expect(names).toContain("shell");
    expect(names).toContain("grep");
    expect(names).toContain("glob");
    expect(names).not.toContain("bash");
    expect(names).not.toContain("run_command");
    expect(names).not.toContain("grep_search");
    expect(names).not.toContain("glob_search");
  });

  test("UI tool/harness catalogs read from the canonical registry, not a second source", () => {
    const toolsCatalog = read("lib/toolsCatalog.ts");
    expect(toolsCatalog).toMatch(/toolRegistry\.list\(\)/);
    expect(toolsCatalog).not.toMatch(/getMergedAgentTools/);

    const harnessCatalog = read("lib/harnessCatalog.ts");
    expect(harnessCatalog).toMatch(/toolRegistry\.canonicalNames\(\)/);
    expect(harnessCatalog).not.toMatch(/getMergedAgentTools/);
  });

  test("src/tui.ts is a pure UI surface — no tool execution re-export", () => {
    const src = read("tui.ts");
    expect(src).not.toMatch(/from\s+"\.\/lib\/harness\/toolExecutor"/);
    expect(src).not.toMatch(/export\s*\{[^}]*executeToolBatch/);
    expect(src).toMatch(/requestApprovalModal/);
  });

  test("simple-repl owns no agent loop — it delegates to the shared kernel", () => {
    const src = read("simple-repl.ts");
    expect(src).not.toMatch(/provider\.(chat|stream)\(/);
    expect(src).not.toMatch(/delta\.tool_calls/);
    expect(src).not.toMatch(/executeToolBatch\(/);
    expect(src).toMatch(/new AgentRuntime\(/);
  });

  test("AgentRuntime is a thin facade — no provider call and no tool loop of its own", () => {
    const src = read("lib/agentRuntime.ts");
    expect(src).not.toMatch(/provider\.(chat|stream)\(/);
    expect(src).not.toMatch(/executeToolBatch\(/);
    expect(src).not.toMatch(/for await/);
    expect(src).toMatch(/this\.harness\.(run|resume)\(/);
  });

  test("interface parity: TUI, headless and REPL all reach the shared AgentHarness kernel", () => {
    expect(read("tui/events/agentWiring.ts")).toMatch(/agentEngine\.run\(/);
    expect(read("lib/nonInteractive.ts")).toMatch(/agentEngine\.run\(/);
    expect(read("simple-repl.ts")).toMatch(/runLoop\(/);
    // The engine is a facade: the loop lives in AgentHarness alone.
    const engine = read("core/agent/agentEngine.ts");
    expect(engine).toMatch(/harness\.(execute|resume|runSubagent)\(/);
    expect(engine).not.toMatch(/provider\.(chat|stream)\(/);
  });
});