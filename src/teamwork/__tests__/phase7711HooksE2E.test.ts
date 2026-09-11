/**
 * Phase 77.11 — hook wiring + cross-runtime coverage (deterministic).
 *
 * Everything here runs against the REAL runtime — real ModelAdapter, real
 * ToolGateway, real TeamworkEngine, real AgentEngine — so a hook that is wired
 * in the wrong place, fires twice, or never fires at all fails loudly instead of
 * hiding behind a mock.
 *
 * Covered edges:
 *   model.before / model.after  → fired exactly once by the adapter
 *   file.beforeWrite            → veto happens before any filesystem mutation
 *   file.afterWrite             → fires only after a verified write
 *   teamwork.node.before/after  → fired by the ENGINE, not the UI
 *
 * Cross-runtime (§77.32/77.33): an MCP tool registered through the canonical
 * adapter is reachable from a subagent and from a DAG node, and a parent `deny`
 * stops the call before the transport is ever touched.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelAdapter } from "../../lib/harness/modelAdapter";
import type { ChatRequest, ChatResponse, Provider } from "../../providers/types";
import { hookRegistry, type HookInvocation } from "../../core/hooks";
import { executeTool } from "../../lib/agentTools";
import { setSandboxMode } from "../../lib/permissions";
import { toolRegistry } from "../../lib/harness/toolRegistry";
import { TeamworkEngine } from "../../core/teamwork";
import { BackgroundJobService } from "../../core/background";
import { AgentEngine } from "../../core/agent/agentEngine";
import { subagentSessions } from "../../core/agent/agents/sessions";
import {
  canonicalMcpToolName,
  registerMcpTools,
  unregisterMcpTools,
  type McpToolCaller,
} from "../../core/mcp/adapter";
import { normalizeMcpToolDefinition } from "../../core/mcp/schema";

// ── Scripted model (global fetch) ────────────────────────────────────────────

interface ScriptedResponse {
  content?: string;
  tool_calls?: unknown[];
}

/** Replace `globalThis.fetch` with a turn-ordered script. */
function scriptModel(responses: ScriptedResponse[]): { calls: () => number } {
  let turn = 0;
  globalThis.fetch = (async () => {
    const resp = responses[Math.min(turn, responses.length - 1)] ?? { content: "Done" };
    turn++;
    const body = JSON.stringify({
      id: `chatcmpl-${turn}`,
      object: "chat.completion",
      created: Date.now(),
      model: "scripted-model",
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
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls: () => turn };
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

// ── Fake provider for ModelAdapter ───────────────────────────────────────────

function fakeProvider(
  responder: (request: ChatRequest) => ChatResponse | Promise<ChatResponse>,
): { provider: Provider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const provider: Provider = {
    id: "scripted-provider",
    name: "Scripted",
    async listModels() {
      return [];
    },
    async chat(request) {
      requests.push(request);
      return responder(request);
    },
  };
  return { provider, requests };
}

function chatResponse(content: string): ChatResponse {
  return {
    id: "chatcmpl-1",
    object: "chat.completion",
    created: 0,
    model: "scripted-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

// ── Environment ──────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let workspace: string;

beforeEach(() => {
  setSandboxMode("workspace");
  hookRegistry.reset();
  toolRegistry.clearDynamic();
  subagentSessions.clear();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-phase7711-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  hookRegistry.reset();
  toolRegistry.clearDynamic();
  subagentSessions.clear();
  if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
});

function writeFile(relative: string, content: string): string {
  const target = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
  return target;
}

// ── 1. Model hooks ───────────────────────────────────────────────────────────

describe("Phase 77.11 — model lifecycle hooks", () => {
  test("model.before fires once before the provider and can transform permitted knobs", async () => {
    const order: string[] = [];
    let beforeCount = 0;
    let afterPayload: Record<string, unknown> | undefined;

    hookRegistry.register({
      name: "model.before",
      owner: "plugin:probe",
      handler: (invocation: HookInvocation) => {
        beforeCount++;
        order.push("before");
        const payload = invocation.output as Record<string, unknown>;
        return {
          action: "transform",
          args: { ...payload, temperature: 0.42, systemAdditions: ["MARKER-77.11"] },
        };
      },
    });

    hookRegistry.register({
      name: "model.after",
      owner: "plugin:probe",
      handler: (invocation: HookInvocation) => {
        order.push("after");
        afterPayload = invocation.output as Record<string, unknown>;
      },
    });

    const { provider, requests } = fakeProvider((request) => {
      order.push("provider");
      return chatResponse("ok");
    });

    const adapter = new ModelAdapter(provider);
    const response = await adapter.complete({
      model: "scripted-model",
      messages: [
        { role: "system", content: "base prompt" },
        { role: "user", content: "hi" },
      ],
    });

    // before = 1, provider = 1, after = 1 — in that order.
    expect(order).toEqual(["before", "provider", "after"]);
    expect(beforeCount).toBe(1);
    expect(requests).toHaveLength(1);

    // The transform really reached the provider.
    expect(requests[0]!.temperature).toBe(0.42);
    const system = requests[0]!.messages.find((m) => m.role === "system")!;
    expect(String(system.content)).toContain("base prompt");
    expect(String(system.content)).toContain("MARKER-77.11");
    // No second system message was introduced.
    expect(requests[0]!.messages.filter((m) => m.role === "system")).toHaveLength(1);

    // model.after observed the NORMALIZED response.
    expect(afterPayload?.outcome).toBe("completed");
    expect(afterPayload?.toolCallCount).toBe(0);
    expect(response.content).toBe("ok");
  });

  test("a hook cannot widen the exposed tool set", async () => {
    hookRegistry.register({
      name: "model.before",
      owner: "plugin:greedy",
      handler: (invocation: HookInvocation) => {
        const payload = invocation.output as Record<string, unknown>;
        return { action: "transform", args: { ...payload, toolNames: ["write_file", "shell"] } };
      },
    });

    const { provider, requests } = fakeProvider(() => chatResponse("ok"));
    const adapter = new ModelAdapter(provider);

    const tools = [
      { type: "function", function: { name: "read_file", description: "r", parameters: {} } },
    ];
    await adapter.complete({ model: "scripted-model", messages: [{ role: "user", content: "hi" }], tools });

    // The provider sees the original tool set — permission scope is not a
    // plugin-configurable value.
    expect(requests[0]!.tools).toHaveLength(1);
    expect((requests[0]!.tools as Array<{ function: { name: string } }>)[0]!.function.name).toBe("read_file");
  });

  test("model.after fires with outcome=error when the provider fails", async () => {
    let afterPayload: Record<string, unknown> | undefined;

    hookRegistry.register({
      name: "model.after",
      owner: "plugin:probe",
      handler: (invocation: HookInvocation) => {
        afterPayload = invocation.output as Record<string, unknown>;
      },
    });

    const { provider } = fakeProvider(() => {
      throw new Error("gateway unavailable");
    });

    const adapter = new ModelAdapter(provider);
    await expect(
      adapter.complete({ model: "scripted-model", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow("gateway unavailable");

    expect(afterPayload?.outcome).toBe("error");
    expect(String(afterPayload?.error)).toContain("gateway unavailable");
  });

  test("the streaming path fires model.before/after exactly once", async () => {
    let beforeCount = 0;
    let afterCount = 0;
    let afterPayload: Record<string, unknown> | undefined;

    hookRegistry.register({
      name: "model.before",
      owner: "plugin:probe",
      handler: () => void beforeCount++,
    });
    hookRegistry.register({
      name: "model.after",
      owner: "plugin:probe",
      handler: (invocation: HookInvocation) => {
        afterCount++;
        afterPayload = invocation.output as Record<string, unknown>;
      },
    });

    const { provider } = fakeProvider(() => chatResponse("streamed"));
    const adapter = new ModelAdapter(provider);

    const deltas: string[] = [];
    for await (const chunk of adapter.stream({
      model: "scripted-model",
      messages: [{ role: "user", content: "hi" }],
    })) {
      if (chunk.contentDelta) deltas.push(chunk.contentDelta);
    }

    expect(deltas.join("")).toBe("streamed");
    expect(beforeCount).toBe(1);
    expect(afterCount).toBe(1);
    expect(afterPayload?.outcome).toBe("completed");
  });
});

// ── 2. File hooks ────────────────────────────────────────────────────────────

describe("Phase 77.11 — file write hooks", () => {
  test("tool.before → file.beforeWrite → mutation → file.afterWrite → tool.after", async () => {
    const order: string[] = [];

    hookRegistry.register({
      name: "tool.before",
      owner: "plugin:probe",
      failurePolicy: "warn",
      handler: () => void order.push("tool.before"),
    });
    hookRegistry.register({
      name: "file.beforeWrite",
      owner: "plugin:probe",
      handler: () => void order.push("file.beforeWrite"),
    });
    hookRegistry.register({
      name: "file.afterWrite",
      owner: "plugin:probe",
      handler: () => void order.push("file.afterWrite"),
    });
    hookRegistry.register({
      name: "tool.after",
      owner: "plugin:probe",
      handler: () => void order.push("tool.after"),
    });

    const raw = await executeTool(
      "write_file",
      { path: path.join(workspace, "allowed.txt"), content: "hello" },
      { cwd: workspace, workspaceRoot: workspace, sandboxMode: "workspace", sessionId: "sess-file-ok" },
    );

    expect(JSON.parse(raw).exitCode).toBe(0);
    expect(fs.readFileSync(path.join(workspace, "allowed.txt"), "utf8")).toBe("hello");
    expect(order).toEqual(["tool.before", "file.beforeWrite", "file.afterWrite", "tool.after"]);
  });

  test("a file.beforeWrite veto means no mutation and no after-hooks", async () => {
    const order: string[] = [];

    hookRegistry.register({
      name: "tool.before",
      owner: "plugin:probe",
      failurePolicy: "warn",
      handler: () => void order.push("tool.before"),
    });
    hookRegistry.register({
      name: "file.beforeWrite",
      owner: "plugin:policy",
      handler: (invocation: HookInvocation) => {
        const payload = invocation.output as { path?: string };
        if (String(payload.path).endsWith("blocked.txt")) {
          return { action: "deny", reason: "blocked.txt is protected by policy" };
        }
      },
    });
    hookRegistry.register({
      name: "file.afterWrite",
      owner: "plugin:probe",
      handler: () => void order.push("file.afterWrite"),
    });
    hookRegistry.register({
      name: "tool.after",
      owner: "plugin:probe",
      handler: () => void order.push("tool.after"),
    });
    hookRegistry.register({
      name: "tool.error",
      owner: "plugin:probe",
      handler: () => void order.push("tool.error"),
    });

    const target = path.join(workspace, "blocked.txt");
    const raw = await executeTool(
      "write_file",
      { path: target, content: "should never land" },
      { cwd: workspace, workspaceRoot: workspace, sandboxMode: "workspace", sessionId: "sess-file-deny" },
    );

    const parsed = JSON.parse(raw);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.stderr).toContain("blocked.txt is protected by policy");
    // The write handler never ran: no file, and neither success-edge hook fired.
    expect(fs.existsSync(target)).toBe(false);
    expect(order).toEqual(["tool.before"]);
    expect(order).not.toContain("file.afterWrite");
    expect(order).not.toContain("tool.after");
  });

  test("file.beforeWrite only guards filesystem mutations", async () => {
    let fileHookCount = 0;
    hookRegistry.register({
      name: "file.beforeWrite",
      owner: "plugin:probe",
      handler: () => {
        fileHookCount++;
      },
    });

    const target = writeFile("readable.txt", "data");
    const raw = await executeTool(
      "read_file",
      { path: target },
      { cwd: workspace, workspaceRoot: workspace, sandboxMode: "workspace", sessionId: "sess-file-read" },
    );

    expect(JSON.parse(raw).exitCode).toBe(0);
    expect(fileHookCount).toBe(0);
  });
});

// ── 3. Teamwork node hooks ───────────────────────────────────────────────────

interface FakeManagerState {
  spawned: string[];
}

function fakeManager(state: FakeManagerState, result: Record<string, unknown> = {}) {
  return {
    allocateSessionId: (_parent: string, agent?: string) => `sub:test:${agent ?? "general"}:1`,
    async run(req: { prompt: string }) {
      const nodeId = /\[\[([^\]]+)\]\]/.exec(req.prompt)?.[1] ?? "unknown";
      state.spawned.push(nodeId);
      return {
        taskId: "t",
        agent: "general",
        status: "completed",
        summary: `did ${nodeId}`,
        output: `did ${nodeId}`,
        toolCalls: 1,
        durationMs: 1,
        ...result,
      };
    },
  };
}

function dagNode(id: string, agent = "general", dependsOn: string[] = []) {
  return { id, title: id, agent, prompt: `[[${id}]] do ${id}`, dependsOn };
}

describe("Phase 77.11 — teamwork node hooks fire in the engine", () => {
  test("a normal node runs before → node → after", async () => {
    const order: string[] = [];
    hookRegistry.register({
      name: "teamwork.node.before",
      owner: "plugin:probe",
      handler: () => void order.push("before"),
    });
    hookRegistry.register({
      name: "teamwork.node.after",
      owner: "plugin:probe",
      handler: (invocation: HookInvocation) => {
        order.push("after");
        const result = invocation.output as { status?: string };
        expect(result.status).toBe("completed");
      },
    });

    const state: FakeManagerState = { spawned: [] };
    const jobs = new BackgroundJobService({ persistPath: null, recoverOnInit: false });
    const engine = new TeamworkEngine({ jobs, manager: fakeManager(state) as never });

    const result = await engine.run({
      plan: { id: "tw-normal", nodes: [dagNode("inspect")] } as never,
      parentSessionId: "parent",
      parentPermission: { defaultDecision: "allow", tools: {} },
      parentDepth: 0,
      cwd: workspace,
      workspaceRoot: workspace,
      sandboxMode: "workspace",
    });

    expect(result.status).toBe("completed");
    expect(order).toEqual(["before", "after"]);
    expect(state.spawned).toEqual(["inspect"]);
  });

  test("a teamwork.node.before veto spawns no child and no side effect", async () => {
    const spawned: string[] = [];

    hookRegistry.register({
      name: "teamwork.node.before",
      owner: "plugin:policy",
      handler: (invocation: HookInvocation) => {
        const input = invocation.input as { nodeId?: string };
        if (input.nodeId === "fix") return { action: "deny", reason: "fix node is disabled by policy" };
      },
    });
    let afterCount = 0;
    hookRegistry.register({
      name: "teamwork.node.after",
      owner: "plugin:probe",
      handler: () => {
        afterCount++;
      },
    });

    const state: FakeManagerState = { spawned };
    const jobs = new BackgroundJobService({ persistPath: null, recoverOnInit: false });
    const engine = new TeamworkEngine({
      jobs,
      manager: {
        allocateSessionId: () => "sub:test:general:1",
        async run(req: { prompt: string }) {
          const nodeId = /\[\[([^\]]+)\]\]/.exec(req.prompt)?.[1] ?? "unknown";
          state.spawned.push(nodeId);
          return {
            taskId: "t",
            agent: "general",
            status: "completed",
            summary: `did ${nodeId}`,
            output: `did ${nodeId}`,
            toolCalls: 1,
            durationMs: 1,
          };
        },
      } as never,
    });

    const result = await engine.run({
      plan: { id: "tw-veto", nodes: [dagNode("inspect"), dagNode("fix", "general", ["inspect"])] } as never,
      parentSessionId: "parent",
      parentPermission: { defaultDecision: "allow", tools: {} },
      parentDepth: 0,
      cwd: workspace,
      workspaceRoot: workspace,
      sandboxMode: "workspace",
    });

    // inspect ran; `fix` was vetoed before the manager was ever called.
    expect(state.spawned).toEqual(["inspect"]);
    expect(result.nodes.fix!.status).toBe("error");
    expect(result.nodes.fix!.summary).toContain("fix node is disabled by policy");
    // `after` fires only for the node that actually executed.
    expect(afterCount).toBe(1);
  });
});

// ── 4. Subagent + MCP canonical path ─────────────────────────────────────────

async function registerFixtureMcpTool(): Promise<{ name: string; calls: Array<Record<string, unknown>> }> {
  const normalized = normalizeMcpToolDefinition({
    name: "read_fixture",
    description: "Read a fixture file",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  });
  if (!normalized.ok) throw new Error(`fixture tool failed to normalize: ${normalized.reason}`);

  const calls: Array<Record<string, unknown>> = [];
  const caller: McpToolCaller = {
    async call(serverId, _serverName, toolName, args) {
      calls.push({ serverId, toolName, args });
      return JSON.stringify({ stdout: "fixture-body", stderr: "", exitCode: 0 });
    },
  };

  const registered = registerMcpTools("fixture", "fixture-server", [normalized.value], caller);
  expect(registered.rejected).toEqual([]);
  return { name: canonicalMcpToolName("fixture", "read_fixture"), calls };
}

describe("Phase 77.32 — MCP inside a subagent", () => {
  test("an allowed MCP tool travels ToolRegistry → Permission → adapter → result", async () => {
    const { name: mcpName, calls } = await registerFixtureMcpTool();
    expect(toolRegistry.ownerOf(mcpName)).toBe("mcp:fixture");
    expect(toolRegistry.schemas().some((s) => s.function.name === mcpName)).toBe(true);

    scriptModel([
      // 1. Parent delegates to the general agent.
      {
        tool_calls: [
          call("t1", "task", {
            description: "read fixture",
            prompt: "Read the fixture via the MCP tool and report its contents.",
            subagent_type: "general",
          }),
        ],
      },
      // 2. Child calls the MCP tool through the canonical registry.
      { tool_calls: [call("m1", mcpName, { name: "fixture.txt" })] },
      // 3. Child reports.
      { content: "The fixture contains: fixture-body" },
      // 4. Parent reports.
      { content: "explore read the fixture." },
    ]);

    const engine = new AgentEngine();
    const result = await engine.run({
      prompt: "Nhờ subagent đọc fixture qua MCP tool.",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 6,
      sessionId: "mcp-subagent-session",
      toolPermissionSet: { defaultDecision: "allow", tools: {} },
    });

    // The transport was reached exactly once, through the canonical adapter.
    expect(calls).toEqual([{ serverId: "fixture", toolName: "read_fixture", args: { name: "fixture.txt" } }]);

    const child = subagentSessions.listByParent("mcp-subagent-session")[0]!;
    const childToolMsgs = child.messages.filter((m) => m.role === "tool");
    expect(childToolMsgs).toHaveLength(1);
    expect(childToolMsgs[0]!.content).toContain("fixture-body");

    expect(result.output).toContain("fixture");
  });

  test("a parent deny stops the child before the MCP transport is touched", async () => {
    const { name: mcpName, calls } = await registerFixtureMcpTool();

    scriptModel([
      {
        tool_calls: [
          call("t1", "task", {
            description: "read fixture",
            prompt: "Read the fixture via the MCP tool.",
            subagent_type: "general",
          }),
        ],
      },
      // The child attempts the tool it has been denied.
      { tool_calls: [call("m1", mcpName, { name: "fixture.txt" })] },
      { content: "I was not permitted to read the fixture." },
      { content: "The subagent was denied MCP access." },
    ]);

    const engine = new AgentEngine();
    await engine.run({
      prompt: "Nhờ subagent đọc fixture.",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 6,
      sessionId: "mcp-deny-session",
      // Parent denies the exact MCP resource — the child can never widen it.
      toolPermissionSet: { defaultDecision: "allow", tools: { [mcpName]: "deny" } },
    });

    // No escalation: the server call count is unchanged.
    expect(calls).toEqual([]);

    const child = subagentSessions.listByParent("mcp-deny-session")[0]!;
    const denial = child.messages.find((m) => m.role === "tool");
    expect(String(denial?.content)).toMatch(/denied|not permitted/i);
  });
});

// ── 5. Teamwork + MCP canonical path ─────────────────────────────────────────

describe("Phase 77.33 — MCP inside a DAG node", () => {
  test("a DAG node reaches MCP only through the canonical tool pipeline", async () => {
    const { name: mcpName, calls } = await registerFixtureMcpTool();

    scriptModel([
      // The child spawned by the DAG node calls the MCP tool…
      { tool_calls: [call("m1", mcpName, { name: "fixture.txt" })] },
      // …then reports.
      { content: "The fixture contains fixture-body." },
    ]);

    const jobs = new BackgroundJobService({ persistPath: null, recoverOnInit: false });
    // No manager override: the DAG runs the REAL global SubagentManager so the
    // child travels the same engine as any other subagent.
    const engine = new TeamworkEngine({ jobs });

    const result = await engine.run({
      plan: {
        id: "tw-mcp",
        nodes: [
          {
            id: "read",
            title: "read fixture",
            agent: "general",
            prompt: "Read the fixture via the MCP tool and report its contents.",
            dependsOn: [],
          },
        ],
      } as never,
      parentSessionId: "tw-mcp-parent",
      parentPermission: { defaultDecision: "allow", tools: {} },
      parentDepth: 0,
      cwd: workspace,
      workspaceRoot: workspace,
      sandboxMode: "workspace",
    });

    expect(result.status).toBe("completed");
    expect(result.nodes.read!.status).toBe("completed");
    // Reached the transport exactly once, via the same pipeline as any tool.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.toolName).toBe("read_fixture");
    expect(String(result.nodes.read!.summary)).toContain("fixture");
  });
});

// ── 6. Architecture guards ───────────────────────────────────────────────────

describe("Phase 77.11 — architecture guards", () => {
  function sourceFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") continue;
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          out.push(full);
        }
      }
    };
    walk(root);
    return out;
  }

  const srcRoot = path.resolve(__dirname, "..", "..");

  test("MCP transport is reachable only from src/core/mcp", () => {
    const offenders: string[] = [];
    for (const dir of ["core/agent", "core/teamwork", "core/plugins", "core/hooks", "core/background"]) {
      for (const file of sourceFiles(path.join(srcRoot, dir))) {
        const text = fs.readFileSync(file, "utf8");
        if (/from "[^"]*lib\/mcpRunner"/.test(text) || /new McpManager\(/.test(text)) {
          offenders.push(path.relative(srcRoot, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("plugins and MCP never open a second execution path", () => {
    const offenders: string[] = [];
    for (const dir of ["core/plugins", "core/mcp"]) {
      for (const file of sourceFiles(path.join(srcRoot, dir))) {
        const text = fs.readFileSync(file, "utf8");
        if (/\bprovider\.(chat|stream)\s*\(/.test(text)) offenders.push(`${path.relative(srcRoot, file)}: provider call`);
        if (/ToolGateway\.execute\s*\(/.test(text)) offenders.push(`${path.relative(srcRoot, file)}: ToolGateway.execute`);
        if (/executeToolBatch\s*\(/.test(text)) offenders.push(`${path.relative(srcRoot, file)}: executeToolBatch`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the teamwork engine fires node hooks itself rather than delegating to a UI", () => {
    const engine = fs.readFileSync(path.join(srcRoot, "core/teamwork/engine.ts"), "utf8");
    expect(engine).toContain('"teamwork.node.before"');
    expect(engine).toContain('"teamwork.node.after"');
  });
});

// Cleanup of the MCP fixture registration between tests.
afterEach(() => {
  unregisterMcpTools("fixture");
});
