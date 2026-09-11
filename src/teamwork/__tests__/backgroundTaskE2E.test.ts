/**
 * Phase 76A — Background task E2E (deterministic).
 *
 * Drives the REAL engine + registry + permission derivation + job service
 * against a LANE-AWARE scripted model, so a parent and its background child can
 * both consume scripted responses concurrently without the test depending on
 * how they interleave.
 *
 * Scenarios (§76A.11–76A.13):
 *   A. background task returns immediately; the parent keeps working; the
 *      result is injected as a notification on the next turn (no polling).
 *   B. cancelling a background job kills the running shell and the child.
 *   C. a background task resumed by task_id reuses the same child session.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { AgentEngine } from "../../core/agent/agentEngine";
import { subagentSessions } from "../../core/agent/agents/sessions";
import { backgroundJobs } from "../../core/background/service";
import { sessionInbox } from "../../core/background/inbox";
import { setSandboxMode } from "../../lib/permissions";

// ── Lane-aware scripted model ────────────────────────────────────────────────

interface ScriptedResponse {
  content?: string;
  tool_calls?: any[];
}

interface CapturedRequest {
  lane: string;
  messages: Array<{ role: string; content: string }>;
}

/**
 * Script responses per lane ("parent" | "child"). Routing by the system prompt
 * makes the test independent of parent/child interleaving, which is what makes
 * a background test deterministic at all.
 */
function scriptLanes(script: { parent?: ScriptedResponse[]; child?: ScriptedResponse[] }) {
  const queues: Record<string, ScriptedResponse[]> = {
    parent: [...(script.parent ?? [])],
    child: [...(script.child ?? [])],
  };
  const requests: CapturedRequest[] = [];

  globalThis.fetch = (async (_url: string, init: any) => {
    let body: any = {};
    try {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    } catch {}

    const messages: Array<{ role: string; content: string }> = body.messages ?? [];
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const lane = /You are ToolNet subagent/i.test(system) ? "child" : "parent";
    requests.push({ lane, messages });

    const queue = queues[lane];
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

  return { requests, served: (lane: string) => queues[lane].length };
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function toolMessages(messages: Array<{ role: string; content: string }> | undefined) {
  return (messages ?? []).filter((m) => m.role === "tool");
}

function extractJobId(toolContent: string): string {
  const outer = JSON.parse(toolContent);
  const match = /<job id="([^"]+)" status="[^"]*" \/>/.exec(String(outer.stdout ?? ""));
  if (!match) throw new Error(`No job id in tool output: ${outer.stdout}`);
  return match[1];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Suite ────────────────────────────────────────────────────────────────────

describe.serial("Phase 76A — background task E2E", () => {
  const originalFetch = globalThis.fetch;
  const SESSION = "bg-e2e-session";
  let workspace: string;

  beforeEach(() => {
    setSandboxMode("full-access");
    subagentSessions.clear();
    sessionInbox.clear();
    workspace = fs.mkdtempSync(path.join("/tmp", "toolnet-bg-e2e-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const job of backgroundJobs.list({ parentSessionId: SESSION })) {
      if (job.status === "running" || job.status === "queued" || job.status === "pending") {
        backgroundJobs.cancel(job.id, "test cleanup");
      }
    }
    sessionInbox.clear();
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch {}
  });

  // ── A. Non-blocking + notification injection ──────────────────────────────

  test("A. background task returns immediately, the parent keeps working, and the result arrives as a notification", async () => {
    fs.writeFileSync(path.join(workspace, "README.md"), "# ToolNet fixture\n");
    fs.writeFileSync(path.join(workspace, "auth.ts"), "export const authenticate = () => true;\n");

    const script = scriptLanes({
      parent: [
        {
          tool_calls: [
            call("t1", "task", {
              description: "inspect auth flow",
              prompt: "Inspect the auth flow and report where authenticate is defined.",
              subagent_type: "explore",
              background: true,
            }),
          ],
        },
        { tool_calls: [call("r1", "read_file", { path: "README.md" })] },
        { content: "I launched the background auth inspection and read the README while it runs." },
        // A second turn for this session, used below to observe the injection.
        { content: "Noted the background result." },
      ],
      child: [
        { tool_calls: [call("g1", "grep", { pattern: "authenticate", path: "." })] },
        { content: "authenticate is defined in auth.ts and always returns true." },
      ],
    });

    const engine = new AgentEngine();
    const first = await engine.run({
      prompt: "Nhờ explore agent kiểm tra auth flow ở background, trong lúc đó tiếp tục đọc README.",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 6,
      sessionId: SESSION,
    });

    // ── The parent did NOT block on the child ────────────────────────────────
    const parentTools = toolMessages(first.messages as any);
    expect(parentTools.length).toBe(2); // task + read_file
    const taskOutput = String(JSON.parse(parentTools[0].content).stdout);
    expect(taskOutput).toContain('state="running"');
    expect(taskOutput).toContain('<subagent_output>');
    // The model is told explicitly not to poll or duplicate the work.
    expect(taskOutput).toMatch(/DO NOT sleep, poll/i);

    // The parent also read the README — it really did continue working.
    expect(first.output).toContain("README");

    // ── The background job runs and completes ────────────────────────────────
    const jobId = extractJobId(parentTools[0].content);
    const settled = await backgroundJobs.wait(jobId, 5000);
    expect(settled?.job.status).toBe("completed");

    const envelope = settled?.job.result as { summary?: string; output?: string };
    expect(envelope?.summary).toContain("authenticate");
    expect(settled?.job.childSessionId).toBeString();

    // The child session is traceable and really ran the search.
    const child = subagentSessions.get(settled!.job.childSessionId!)!;
    expect(child.agentId).toBe("explore");
    expect(child.messages.filter((m) => m.role === "tool").length).toBe(1);

    // ── The completion is a NOTIFICATION, not something the parent polled ────
    const pending = sessionInbox.peek(SESSION);
    expect(pending.length).toBe(1);
    expect(pending[0].content).toContain(`id="${settled!.job.childSessionId}"`);
    expect(pending[0].content).toContain("authenticate");
    expect(pending[0].synthetic).toBe(true);

    // ── The next turn receives it, and only once ────────────────────────────
    const second = await engine.run({
      prompt: "Continue.",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 4,
      sessionId: SESSION,
    });

    const parentRequests = script.requests.filter((r) => r.lane === "parent");
    const finalRequest = parentRequests[parentRequests.length - 1];
    const injected = finalRequest.messages.filter((m) => m.content.includes("<task id="));
    expect(injected.length).toBe(1);
    expect(injected[0].content).toContain("authenticate");

    // Drained exactly once: no duplicate notification on a later turn.
    expect(sessionInbox.peek(SESSION).length).toBe(0);
    expect(second.success).toBe(true);
  });

  // ── B. Cancellation kills the child process tree ──────────────────────────

  test("B. cancelling a background job kills its running shell and cancels the child", async () => {
    scriptLanes({
      parent: [
        {
          tool_calls: [
            call("t1", "task", {
              description: "long background probe",
              prompt: "Run a long-running probe in the background.",
              subagent_type: "general",
              background: true,
            }),
          ],
        },
        { content: "Probe launched in the background." },
      ],
      child: [
        // Writes a marker, then blocks: the marker proves a real process tree is
        // running, and `sleep 30` proves cancellation actually killed it (the
        // job would otherwise outlive the test's 5s budget).
        { tool_calls: [call("s1", "shell", { command: "touch probe.marker && sleep 30" })] },
        { content: "probe finished" },
      ],
    });

    const engine = new AgentEngine();
    const first = await engine.run({
      prompt: "Chạy một probe dài ở background.",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 4,
      sessionId: SESSION,
    });

    const jobId = extractJobId(toolMessages(first.messages as any)[0].content);

    // Wait until the child's shell has actually started. The marker file is
    // written by the child process itself, so it is evidence the process tree
    // exists — not a proxy for some internal counter.
    const marker = path.join(workspace, "probe.marker");
    let started = false;
    for (let i = 0; i < 100 && !started; i++) {
      started = fs.existsSync(marker);
      if (!started) await sleep(20);
    }
    expect(started).toBe(true);
    expect(backgroundJobs.get(jobId)?.status).toBe("running");

    const cancelStartedAt = Date.now();
    backgroundJobs.cancel(jobId, "cancelled by test");
    const settled = await backgroundJobs.wait(jobId, 5000);
    expect(settled?.job.status).toBe("cancelled");

    // The job settles immediately on cancel, but the child run must actually
    // UNWIND. `sleep 30` would hold it for ~30s if the process tree survived,
    // so reaching the terminal state inside this budget is the proof it died.
    const childId = settled!.job.childSessionId!;
    let childStatus = subagentSessions.get(childId)?.status;
    for (let i = 0; i < 200 && childStatus === "running"; i++) {
      await sleep(20);
      childStatus = subagentSessions.get(childId)?.status;
    }
    const cancelDuration = Date.now() - cancelStartedAt;

    expect(childStatus).toBe("cancelled");
    expect(cancelDuration).toBeLessThan(5000);

    // The parent CLI-level run is unaffected and long finished.
    expect(first.success).toBe(true);
  });

  // ── C. Resume a background task ───────────────────────────────────────────

  test("C. a background task resumed by task_id reuses the same child session", async () => {
    scriptLanes({
      parent: [
        {
          tool_calls: [
            call("t1", "task", {
              description: "inspect auth",
              prompt: "Inspect the auth module.",
              subagent_type: "explore",
              background: true,
            }),
          ],
        },
        { content: "Started inspection." },
      ],
      child: [{ content: "Phase one: the module exports authenticate." }],
    });

    const engine = new AgentEngine();
    const first = await engine.run({
      prompt: "Kiểm tra module auth ở background.",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 4,
      sessionId: SESSION,
    });

    const firstJobId = extractJobId(toolMessages(first.messages as any)[0].content);
    await backgroundJobs.wait(firstJobId, 5000);
    const childSessionId = backgroundJobs.get(firstJobId)!.childSessionId!;

    // A second parent turn. Re-scripting is necessary because the resume id only
    // exists after the first turn; the parent model is then told to resume it.
    scriptLanes({
      parent: [
        {
          tool_calls: [
            call("t2", "task", {
              description: "inspect tests",
              prompt: "Now inspect the tests.",
              subagent_type: "explore",
              background: true,
              task_id: childSessionId,
            }),
          ],
        },
        { content: "Started the follow-up inspection." },
      ],
      child: [{ content: "Phase two: the tests do not cover authenticate." }],
    });

    const second = await engine.run({
      prompt: `Tiếp tục kiểm tra test (task_id=${childSessionId}).`,
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 4,
      sessionId: SESSION,
    });

    const parentToolMsgs = toolMessages(second.messages as any);
    expect(parentToolMsgs.length).toBeGreaterThanOrEqual(1);

    // The parent's own `task` call carried the task_id, so the resume travelled
    // the real engine → registry → tool path.
    const resumedJobId = extractJobId(parentToolMsgs[0].content);
    const settled = await backgroundJobs.wait(resumedJobId, 5000);
    expect(settled?.job.status).toBe("completed");

    // No new session was created: the resume continued the original child.
    const children = subagentSessions.listByParent(SESSION);
    expect(children.length).toBe(1);
    expect(children[0].id).toBe(childSessionId);
    // …and its history grew rather than being replaced.
    expect(children[0].messages.filter((m) => m.role === "user").length).toBe(2);

    // The resumed job reports the SAME child session.
    expect(backgroundJobs.get(resumedJobId)!.childSessionId).toBe(childSessionId);
  });
});
