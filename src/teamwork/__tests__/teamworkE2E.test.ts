/**
 * Phase 76B — Teamwork DAG E2E (deterministic).
 *
 * Drives the REAL Agent Engine + REAL SubagentManager + REAL ToolRegistry +
 * REAL BackgroundJobService against a NODE-ROUTED scripted model. Routing by a
 * `NODE:<id>` marker inside the node prompt (instead of by agent) is what makes
 * a plan with repeated agents deterministic.
 *
 * Scenarios (§76B.12–76B.14):
 *   A. a multi-stage plan runs through the `teamwork` tool: explore → coder →
 *      tester, with dependency outputs delivered and a real file mutation.
 *   B. plan-mode security: a parent that denies writes cannot create the file by
 *      delegating to a coder node.
 *   C. cancelling a plan kills the node's running shell.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { AgentEngine } from "../../core/agent/agentEngine";
import { BackgroundJobService } from "../../core/background";
import { subagentSessions } from "../../core/agent/agents/sessions";
import { subagentManager } from "../../core/agent/agents/manager";
import { TeamworkEngine } from "../../core/teamwork";
import { setSandboxMode } from "../../lib/permissions";

// ── Node-routed scripted model ───────────────────────────────────────────────

interface ScriptedResponse {
  content?: string;
  tool_calls?: any[];
}

interface CapturedRequest {
  lane: "parent" | string;
  messages: Array<{ role: string; content: string }>;
}

const NODE_MARKER = /NODE:([a-zA-Z0-9_-]+)/;

function scriptRouted(script: { parent?: ScriptedResponse[]; nodes: Record<string, ScriptedResponse[]> }) {
  const parentQueue = [...(script.parent ?? [])];
  const nodeQueues: Record<string, ScriptedResponse[]> = Object.fromEntries(
    Object.entries(script.nodes).map(([id, responses]) => [id, [...responses]])
  );
  const requests: CapturedRequest[] = [];

  globalThis.fetch = (async (_url: string, init: any) => {
    let body: any = {};
    try {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    } catch {}

    const messages: Array<{ role: string; content: string }> = body.messages ?? [];
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const isChild = /You are ToolNet subagent/i.test(system);

    let lane: string;
    let queue: ScriptedResponse[];

    if (!isChild) {
      lane = "parent";
      queue = parentQueue;
    } else {
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const nodeId = NODE_MARKER.exec(lastUser)?.[1] ?? "unknown";
      lane = `node:${nodeId}`;
      queue = nodeQueues[nodeId] ?? [];
    }

    requests.push({ lane, messages });

    const resp = queue.length > 1 ? queue.shift()! : (queue[0] ?? { content: "Done" });
    const payload = JSON.stringify({
      id: `chatcmpl-${requests.length}`,
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
      json: async () => JSON.parse(payload),
      text: async () => payload,
      clone: async () => ({ json: async () => JSON.parse(payload), text: async () => payload }),
    } as any;
  }) as any;

  return {
    requests,
    /**
     * First request the child for `nodeId` made. That is the call carrying the
     * node prompt (plus any dependency outputs) — later calls only carry tool
     * results.
     */
    firstFor(nodeId: string): CapturedRequest | undefined {
      return requests.find((r) => r.lane === `node:${nodeId}`);
    },
  };
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function toolMessages(messages: Array<{ role: string; content: string }> | undefined) {
  return (messages ?? []).filter((m) => m.role === "tool");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Suite ────────────────────────────────────────────────────────────────────

describe.serial("Phase 76B — teamwork E2E", () => {
  const originalFetch = globalThis.fetch;
  const SESSION = "team-e2e-session";
  let workspace: string;

  beforeEach(() => {
    setSandboxMode("full-access");
    subagentSessions.clear();
    workspace = fs.mkdtempSync(path.join("/tmp", "toolnet-team-e2e-"));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    // The bug the plan is meant to find and fix.
    fs.writeFileSync(path.join(workspace, "src/math.ts"), "export const add = (a: number, b: number) => a * b;\n");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch {}
  });

  // ── A. Multi-stage plan through the canonical tool ────────────────────────

  test("A. explore → coder → tester plan runs through the `teamwork` tool and really fixes the file", async () => {
    const router = scriptRouted({
      parent: [
        {
          tool_calls: [
            call("tw1", "teamwork", {
              id: "plan-a",
              nodes: [
                {
                  id: "inspect",
                  agent: "explore",
                  prompt: "NODE:inspect Read src/math.ts and report what the add function does wrong.",
                  dependsOn: [],
                },
                {
                  id: "fix",
                  agent: "coder",
                  prompt: "NODE:fix Fix the add function in src/math.ts so it adds.",
                  dependsOn: ["inspect"],
                },
                {
                  id: "test",
                  agent: "tester",
                  prompt: "NODE:test Verify src/math.ts by reading it back.",
                  dependsOn: ["fix"],
                },
              ],
            }),
          ],
        },
        { content: "The plan fixed the add function and verified it." },
      ],
      nodes: {
        inspect: [
          { tool_calls: [call("i1", "read_file", { path: "src/math.ts" })] },
          { content: "add multiplies instead of adding — it returns a * b." },
        ],
        fix: [
          {
            tool_calls: [
              call("f1", "write_file", {
                path: "src/math.ts",
                content: "export const add = (a: number, b: number) => a + b;\n",
              }),
            ],
          },
          { content: "add now returns a + b." },
        ],
        test: [
          { tool_calls: [call("t1", "shell", { command: "cat src/math.ts" })] },
          { content: "Verified: add returns a + b." },
        ],
      },
    });

    const engine = new AgentEngine();
    const run = await engine.run({
      prompt: "Sửa hàm add đang nhân thành cộng, rồi kiểm tra lại.",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 6,
      sessionId: SESSION,
    });

    expect(run.success).toBe(true);

    // The tool result is the aggregate plan envelope, and the plan completed.
    const toolMsg = toolMessages(run.messages as any)[0];
    const stdout = String(JSON.parse(toolMsg.content).stdout);
    expect(stdout).toContain('<teamwork id="plan-a" state="completed"');
    expect(JSON.parse(toolMsg.content).exitCode).toBe(0);

    // A real mutation happened on disk.
    const onDisk = fs.readFileSync(path.join(workspace, "src/math.ts"), "utf8");
    expect(onDisk).toContain("a + b");
    expect(onDisk).not.toContain("a * b");

    // Dependency outputs flowed downstream: the fixer saw the inspector's finding,
    // and the tester saw the fixer's result. No node re-ran earlier work.
    const fixPrompt = router.firstFor("fix")!.messages.at(-1)!.content;
    const testPrompt = router.firstFor("test")!.messages.at(-1)!.content;
    expect(fixPrompt).toContain("<dependency_outputs>");
    expect(fixPrompt).toContain("multiplies");
    expect(testPrompt).toContain("<dependency_outputs>");
    expect(testPrompt).toContain("a + b");

    // Every node ran exactly once and has a traceable child session.
    const children = subagentSessions.listByParent(SESSION);
    expect(children.length).toBe(3);
    expect(new Set(children.map((c) => c.agentId))).toEqual(new Set(["explore", "coder", "tester"]));
    expect(children.every((c) => c.status === "completed")).toBe(true);
  });

  // ── B. Plan-mode security: delegation cannot widen permission ─────────────

  test("B. a parent that denies writes cannot write through a coder node", async () => {
    scriptRouted({
      nodes: {
        write: [
          {
            tool_calls: [
              call("w1", "write_file", { path: "secret.txt", content: "should never exist" }),
            ],
          },
          { content: "I could not write the file." },
        ],
      },
    });

    const jobs = new BackgroundJobService({ persistPath: null, recoverOnInit: false });
    const engine = new TeamworkEngine({ jobs, manager: subagentManager });

    const result = await engine.run({
      plan: {
        id: "plan-sec",
        nodes: [
          {
            id: "write",
            title: "write",
            agent: "coder",
            prompt: "NODE:write Create secret.txt containing hello.",
            dependsOn: [],
          },
        ],
      },
      parentSessionId: SESSION,
      // Plan-mode style scope: the parent may not write at all.
      parentPermission: {
        defaultDecision: "allow",
        tools: { write_file: "deny", edit_file: "deny", apply_patch: "deny" },
      },
      parentDepth: 0,
      cwd: workspace,
      workspaceRoot: workspace,
      sandboxMode: "full-access",
    });

    // Security acceptance: no side effect, regardless of what the child said.
    expect(fs.existsSync(path.join(workspace, "secret.txt"))).toBe(false);

    // The denial is visible in the child's own transcript (not silently dropped).
    const childId = result.nodes.write.childSessionId!;
    const denied = subagentSessions
      .get(childId)!
      .messages.filter((m) => m.role === "tool")
      .some((m) => /denied|not permitted|not allowed/i.test(m.content));
    expect(denied).toBe(true);
  });

  // ── C. Cancellation kills the node's process tree ─────────────────────────

  test("C. cancelling a plan cancels its live node and kills the running shell", async () => {
    scriptRouted({
      nodes: {
        slow: [
          { tool_calls: [call("s1", "shell", { command: "touch plan.marker && sleep 30" })] },
          { content: "finished" },
        ],
      },
    });

    const jobs = new BackgroundJobService({ persistPath: null, recoverOnInit: false });
    const engine = new TeamworkEngine({ jobs, manager: subagentManager });
    const controller = new AbortController();

    const promise = engine.run({
      plan: {
        id: "plan-cancel",
        nodes: [{ id: "slow", title: "slow", agent: "general", prompt: "NODE:slow Run a long probe.", dependsOn: [] }],
      },
      parentSessionId: SESSION,
      parentPermission: { defaultDecision: "allow", tools: {} },
      parentDepth: 0,
      cwd: workspace,
      workspaceRoot: workspace,
      sandboxMode: "full-access",
      signal: controller.signal,
    });

    // Wait until the shell is genuinely running (its own marker file exists).
    const marker = path.join(workspace, "plan.marker");
    let started = false;
    for (let i = 0; i < 100 && !started; i++) {
      started = fs.existsSync(marker);
      if (!started) await sleep(20);
    }
    expect(started).toBe(true);

    const cancelStartedAt = Date.now();
    controller.abort();
    const result = await promise;

    expect(result.status).toBe("cancelled");
    expect(result.nodes.slow.status).toBe("cancelled");
    // `sleep 30` would keep the node alive for ~30s if the process survived.
    expect(Date.now() - cancelStartedAt).toBeLessThan(5000);
  });
});
