/**
 * Phase 75 — Subagent runtime E2E (deterministic).
 *
 * Drives the REAL Agent Engine + REAL ToolRegistry + REAL permission derivation
 * against a SCRIPTED model (globalThis.fetch), so the suite can never be flaky
 * because of model compliance. A failure here is always a CORE_RUNTIME defect.
 *
 * Scenarios (§75.20–75.24):
 *   A. plan-bypass blocked           — release blocker
 *   B. explore delegation + isolation
 *   C. coder self-repair inside a child (read → fail → edit → pass)
 *   D. resume the same child session
 *   E. depth limit blocks a grandchild
 *   F. cancellation propagates (child turns cancelled; shell is killed)
 *   G. scope gate: ASK surfaces approval; denial means no mutation
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { AgentEngine } from "../../core/agent/agentEngine";
import { agentRegistry } from "../../core/agent/agents/registry";
import { permissionScopeFromAgent } from "../../core/agent/agents/permissions";
import { subagentSessions } from "../../core/agent/agents/sessions";
import { subagentManager } from "../../core/agent/agents/manager";
import { setSandboxMode } from "../../lib/permissions";

// ── Scripted model ───────────────────────────────────────────────────────────

interface ScriptedResponse {
  content?: string;
  tool_calls?: any[];
}

/** Replace `globalThis.fetch` with a deterministic, turn-ordered script. */
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
    } as any;
  }) as any;
  return { calls: () => turn };
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** Pull the structured subagent envelope out of a `task` tool result. */
function extractTaskResult(toolContent: string): any {
  const outer = JSON.parse(toolContent);
  const match = /<task_result>([\s\S]*?)<\/task_result>/.exec(String(outer.stdout ?? ""));
  if (!match) throw new Error(`No <task_result> in tool output: ${outer.stdout}`);
  return JSON.parse(match[1]);
}

function toolMessages(messages: Array<{ role: string; content: string }> | undefined) {
  return (messages ?? []).filter((m) => m.role === "tool");
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe.serial("Phase 75 — subagent runtime E2E", () => {
  const originalFetch = globalThis.fetch;
  let workspace: string;
  const runtime = process.execPath; // the running JS runtime (bun)

  beforeEach(() => {
    setSandboxMode("full-access");
    subagentSessions.clear();
    workspace = fs.mkdtempSync(path.join("/tmp", "toolnet-subagent-e2e-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch {}
  });

  // ── A. Plan bypass (release blocker) ───────────────────────────────────────

  test("A. a read-only parent cannot launder a write through a coder subagent", async () => {
    const planScope = permissionScopeFromAgent(agentRegistry.get("plan")!);

    scriptModel([
      // 1. Parent (plan): delegate the write to a coder.
      {
        tool_calls: [
          call("t1", "task", {
            description: "create the file",
            prompt: "Create x.ts containing console.log('hi')",
            subagent_type: "coder",
          }),
        ],
      },
      // 2. Child (coder): attempt the write it was denied.
      { tool_calls: [call("w1", "write_file", { path: "x.ts", content: "console.log('hi')" })] },
      // 3. Child: honest report.
      { content: "I was not permitted to write the file." },
      // 4. Parent: honest final answer.
      { content: "The subagent could not create x.ts: write access is denied in plan mode." },
    ]);

    const engine = new AgentEngine();
    const result = await engine.run({
      prompt: "Plan the change, then have a coder create x.ts",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 6,
      sessionId: "plan-session",
      toolPermissionSet: planScope,
    });

    // ── The side effect never happened ──────────────────────────────────────
    expect(fs.existsSync(path.join(workspace, "x.ts"))).toBe(false);
    expect(result.evidence.successfulMutations).toBe(0);

    // ── The parent saw a structured child result, not a fake success ─────────
    const parentToolMsgs = toolMessages(result.messages as any);
    expect(parentToolMsgs.length).toBe(1); // only the `task` call itself
    const envelope = extractTaskResult(parentToolMsgs[0].content);
    expect(envelope.agent).toBe("coder");

    // ── The CHILD's own transcript proves the denial, not the prompt ─────────
    const children = subagentSessions.listByParent("plan-session");
    expect(children.length).toBe(1);
    const childToolMsgs = children[0].messages.filter((m) => m.role === "tool");
    expect(childToolMsgs.length).toBe(1);
    expect(childToolMsgs[0].content).toContain("Permission Denied");
    expect(childToolMsgs[0].content).toMatch(/write_file/);
  });

  // ── B. Explore delegation + context isolation ─────────────────────────────

  test("B. explore delegation finds a symbol and keeps its transcript out of the parent", async () => {
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "src", "auth.ts"),
      "export function authenticate(user: string): boolean {\n  return true;\n}\n"
    );

    scriptModel([
      {
        tool_calls: [
          call("t1", "task", {
            description: "locate authentication",
            prompt: "Find the function that handles authentication in src and report the file.",
            subagent_type: "explore",
          }),
        ],
      },
      { tool_calls: [call("g1", "grep", { pattern: "authenticate", path: "src" })] },
      { content: "Found `authenticate` defined in src/auth.ts (line 1)." },
      { content: "explore reported the authentication function in src/auth.ts." },
    ]);

    const engine = new AgentEngine();
    const result = await engine.run({
      prompt: "Nhờ explore agent tìm hàm xử lý authentication và báo lại file liên quan.",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 6,
      sessionId: "explore-session",
    });

    // Parent transcript holds ONE tool result: the delegation envelope.
    const parentToolMsgs = toolMessages(result.messages as any);
    expect(parentToolMsgs.length).toBe(1);

    const envelope = extractTaskResult(parentToolMsgs[0].content);
    expect(envelope.agent).toBe("explore");
    expect(envelope.status).toBe("completed");
    expect(envelope.tool_calls).toBeGreaterThanOrEqual(1);
    expect(String(parentToolMsgs[0].content)).toContain("authenticate");

    // The child session is traceable back to the parent.
    const children = subagentSessions.listByParent("explore-session");
    expect(children.length).toBe(1);
    expect(children[0].agentId).toBe("explore");
    expect(children[0].depth).toBe(1);

    // …and the child really ran the search: its OWN transcript has the grep result.
    const childToolMsgs = children[0].messages.filter((m) => m.role === "tool");
    expect(childToolMsgs.length).toBe(1);
    expect(childToolMsgs[0].content).toContain("auth.ts");

    // Isolation: the child's raw tool output never entered the parent
    // conversation — only the delegation envelope (whose text mentions the
    // file) did. The grep envelope is a distinctive marker for raw output.
    expect((result.messages ?? []).some((m) => m.content.includes("match(es):"))).toBe(false);
    // The parent still has its own final answer, of course.
    expect((result.messages ?? []).some((m) => m.role === "assistant" && m.content.includes("auth.ts"))).toBe(true);
  });

  // ── C. Coder self-repair inside a child ───────────────────────────────────

  test("C. coder subagent repairs a failing test and verifies the fix", async () => {
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "src", "math.ts"),
      "export function add(a: number, b: number): number {\n  return a * b;\n}\n"
    );
    fs.writeFileSync(
      path.join(workspace, "src", "math.test.ts"),
      [
        'import { test, expect } from "bun:test";',
        'import { add } from "./math";',
        "",
        'test("adds two numbers", () => {',
        "  expect(add(2, 3)).toBe(5);",
        "});",
        "",
      ].join("\n")
    );
    fs.writeFileSync(path.join(workspace, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));

    scriptModel([
      {
        tool_calls: [
          call("t1", "task", {
            description: "fix add",
            prompt: "Hàm add đang trả về phép nhân. Sửa lại và chạy test.",
            subagent_type: "coder",
          }),
        ],
      },
      // child: read
      { tool_calls: [call("r1", "read_file", { path: "src/math.ts" })] },
      // child: run tests → must FAIL
      { tool_calls: [call("s1", "shell", { command: `${runtime} test src/math.test.ts` })] },
      // child: repair
      { tool_calls: [call("e1", "edit_file", { path: "src/math.ts", old_string: "return a * b;", new_string: "return a + b;" })] },
      // child: run tests → must PASS
      { tool_calls: [call("s2", "shell", { command: `${runtime} test src/math.test.ts` })] },
      // child: report
      { content: "Fixed add (was multiplying). Both assertions now pass." },
      // parent: report
      { content: "coder đã sửa hàm add và test pass." },
    ]);

    const engine = new AgentEngine();
    const result = await engine.run({
      prompt: "Nhờ coder sửa hàm add đang trả phép nhân, sau đó chạy test.",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 12,
      sessionId: "coder-session",
    });

    // ── The real workspace changed ──────────────────────────────────────────
    const fixed = fs.readFileSync(path.join(workspace, "src", "math.ts"), "utf8");
    expect(fixed).toContain("return a + b;");
    expect(fixed).not.toContain("return a * b;");

    // ── The child performed read → fail → edit → pass ───────────────────────
    const child = subagentSessions.listByParent("coder-session")[0];
    expect(child.agentId).toBe("coder");
    const childTools = child.messages.filter((m) => m.role === "tool");
    expect(childTools.length).toBe(4);

    const failed = JSON.parse(childTools[1].content);
    expect(failed.exitCode).not.toBe(0);
    expect(String(failed.stderr ?? "")).not.toBe("");

    const passed = JSON.parse(childTools[3].content);
    expect(passed.exitCode).toBe(0);

    // ── The parent gets a real, structured result ───────────────────────────
    const envelope = extractTaskResult(toolMessages(result.messages as any)[0].content);
    expect(envelope.status).toBe("completed");
    expect(envelope.tool_calls).toBeGreaterThanOrEqual(4);
    expect(child.toolCalls).toBeGreaterThanOrEqual(4);
  });

  // ── D. Resume ─────────────────────────────────────────────────────────────

  test("D. task_id resumes the SAME child session with its history intact", async () => {
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "auth.ts"), "export const authenticate = () => true;\n");
    fs.writeFileSync(path.join(workspace, "src", "auth.test.ts"), 'import { test } from "bun:test";\ntest("x", () => {});\n');

    const firstChildId = "sub:resume-session:explore:1";

    scriptModel([
      // 1. parent: first delegation
      {
        tool_calls: [
          call("t1", "task", {
            description: "inspect auth",
            prompt: "Inspect this auth module.",
            subagent_type: "explore",
          }),
        ],
      },
      // 2. child: read the module
      { tool_calls: [call("r1", "read_file", { path: "src/auth.ts" })] },
      // 3. child: report
      { content: "src/auth.ts exports `authenticate`." },
      // 4. parent: resume with an explicit task_id
      {
        tool_calls: [
          call("t2", "task", {
            description: "inspect tests",
            prompt: "Now inspect the tests and tell me what is missing.",
            subagent_type: "explore",
            task_id: firstChildId,
          }),
        ],
      },
      // 5. resumed child: read the test file
      { tool_calls: [call("r2", "read_file", { path: "src/auth.test.ts" })] },
      // 6. resumed child: report
      { content: "The test file only has a placeholder token name; it does not cover authenticate." },
      // 7. parent: report
      { content: "Resumed the same explore session; tests are missing coverage." },
    ]);

    const engine = new AgentEngine();
    await engine.run({
      prompt: "Kiểm tra module auth rồi cho tôi biết test còn thiếu gì.",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 12,
      sessionId: "resume-session",
    });

    const children = subagentSessions.listByParent("resume-session");
    // Exactly ONE child: the resume continued it instead of forking a new one.
    expect(children.length).toBe(1);
    expect(children[0].id).toBe(firstChildId);

    // History is retained across both calls: 2 user prompts + both transcripts.
    const userMessages = children[0].messages.filter((m) => m.role === "user");
    expect(userMessages.length).toBe(2);
    expect(userMessages[0].content).toBe("Inspect this auth module.");
    expect(userMessages[1].content).toContain("Now inspect the tests");

    // The first call's tool result is still present after the resume.
    const childToolMsgs = children[0].messages.filter((m) => m.role === "tool");
    expect(childToolMsgs.length).toBeGreaterThanOrEqual(2);
    expect(childToolMsgs[0].content).toContain("authenticate");
  });

  // ── E. Depth limit ────────────────────────────────────────────────────────

  test("E. a child cannot spawn a grandchild (depth limit)", async () => {
    scriptModel([
      // 1. parent: delegate one level down
      {
        tool_calls: [
          call("t1", "task", { description: "level 1", prompt: "Delegate the next level down.", subagent_type: "general" }),
        ],
      },
      // 2. child (depth 1): try to recurse
      {
        tool_calls: [
          call("t2", "task", { description: "level 2", prompt: "Do the work yourself.", subagent_type: "general" }),
        ],
      },
      // 3. child: honest report
      { content: "I could not spawn a nested subagent." },
      // 4. parent: report
      { content: "Only one level of delegation is permitted." },
    ]);

    const engine = new AgentEngine();
    await engine.run({
      prompt: "Delegate this task to a subagent.",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 8,
      sessionId: "depth-session",
    });

    // The grandchild was refused BEFORE any child session could be created.
    const children = subagentSessions.listByParent("depth-session");
    expect(children.length).toBe(1);

    const grandchildAttempt = children[0].messages.find((m) => m.role === "tool");
    expect(grandchildAttempt).toBeDefined();
    expect(grandchildAttempt!.content).toMatch(/depth limit reached|recursion limit/i);
  });

  // ── F. Cancellation ───────────────────────────────────────────────────────

  test("F. an aborted parent signal is reported as cancelled, not as success", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await subagentManager.run({
      agentId: "explore",
      prompt: "Inspect the workspace.",
      parentSessionId: "cancel-session",
      parentPermission: { defaultDecision: "allow", tools: {} },
      parentDepth: 0,
      cwd: workspace,
      workspaceRoot: workspace,
      signal: controller.signal,
    });

    expect(result.status).toBe("cancelled");
    expect(result.summary).toMatch(/cancelled/i);
    expect(subagentSessions.list()[0].status).toBe("cancelled");
  });

  test("F2. an in-flight shell command is killed when the request is cancelled", async () => {
    const { executeTool } = await import("../../lib/agentTools");
    const controller = new AbortController();
    // Give the child process a moment to spawn, then cancel mid-flight.
    setTimeout(() => controller.abort(), 200);

    const startedAt = Date.now();
    const raw = await executeTool(
      "shell",
      { command: "sleep 8" },
      {
        cwd: workspace,
        workspaceRoot: workspace,
        sandboxMode: "full-access",
        signal: controller.signal,
      }
    );
    const elapsed = Date.now() - startedAt;

    const payload = JSON.parse(raw);
    expect(payload.exitCode).toBe(130);
    // Killed promptly — nowhere near the 8s the command asked for.
    expect(elapsed).toBeLessThan(4000);
  });

  // ── G. Scope gate: ASK / DENY ─────────────────────────────────────────────

  test("G. an ASK-scoped tool prompts once; denial leaves no side effect, approval runs it", async () => {
    const gatedScope = { defaultDecision: "allow" as const, tools: { write_file: "ask" as const } };

    // ── Deny path ───────────────────────────────────────────────────────────
    scriptModel([
      { tool_calls: [call("w1", "write_file", { path: "gated.ts", content: "export const x = 1;\n" })] },
      { content: "I could not write the file." },
    ]);

    const engine = new AgentEngine();
    let approvals = 0;
    const denied = await engine.run({
      prompt: "Create gated.ts",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 4,
      sessionId: "ask-deny",
      toolPermissionSet: gatedScope,
      requestApproval: async () => {
        approvals++;
        return false;
      },
    });

    expect(approvals).toBe(1);
    expect(fs.existsSync(path.join(workspace, "gated.ts"))).toBe(false);
    expect(denied.evidence.successfulMutations).toBe(0);

    // ── Approve path ────────────────────────────────────────────────────────
    scriptModel([
      { tool_calls: [call("w2", "write_file", { path: "gated.ts", content: "export const x = 1;\n" })] },
      { content: "Created gated.ts." },
    ]);

    let approvals2 = 0;
    const approved = await engine.run({
      prompt: "Create gated.ts",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 4,
      sessionId: "ask-approve",
      toolPermissionSet: gatedScope,
      requestApproval: async () => {
        approvals2++;
        return true;
      },
    });

    expect(approvals2).toBe(1);
    expect(fs.existsSync(path.join(workspace, "gated.ts"))).toBe(true);
    expect(approved.evidence.successfulMutations).toBe(1);
  });

  test("G2. a DENY-scoped tool is never unlockable by approval", async () => {
    const lockedScope = { defaultDecision: "allow" as const, tools: { write_file: "deny" as const } };

    scriptModel([
      { tool_calls: [call("w1", "write_file", { path: "locked.ts", content: "nope\n" })] },
      { content: "Denied." },
    ]);

    const engine = new AgentEngine();
    let approvals = 0;
    const result = await engine.run({
      prompt: "Create locked.ts",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 4,
      sessionId: "deny-session",
      toolPermissionSet: lockedScope,
      // A malicious/buggy front-end that approves everything still cannot help.
      requestApproval: async () => {
        approvals++;
        return true;
      },
    });

    expect(approvals).toBe(0);
    expect(fs.existsSync(path.join(workspace, "locked.ts"))).toBe(false);
    expect(result.evidence.successfulMutations).toBe(0);
  });
});
