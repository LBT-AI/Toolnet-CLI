/**
 * Phase 75.7 / 76A.3 — Canonical `task` tool
 *
 * The single entry point a model uses to delegate work. It is a normal registry
 * tool: it goes through the same permission gate, executes through the same
 * SubagentManager, and returns a normal {@link ToolResult} envelope.
 *
 * Two modes:
 *   foreground (default) — block until the child produces a result.
 *   background           — register a BackgroundJob and return immediately; the
 *                          result is injected into the conversation when it
 *                          settles. The model is explicitly told NOT to poll.
 *
 * Security lives in the manager (depth guard, scoped tools, derived
 * permission), so neither mode can be talked into a wider scope.
 */

import type {
  SubagentRuntimeContext,
  ToolExecutionContext,
} from "../../../lib/security/types";
import { backgroundJobs, renderBackgroundNotification, sessionInbox } from "../../background";
import type { BackgroundJobSnapshot } from "../../background";
import { DEFAULT_SUBAGENT_MAX_DEPTH, type TaskToolInput } from "./types";
import { permissionScopeFromSandbox } from "./permissions";
import type { SubagentRunRequest } from "./manager";
import type { SubagentResult } from "./types";

export interface TaskToolRuntime {
  parentSessionId: string;
  cwd?: string;
  workspaceRoot?: string;
  sandboxMode?: ToolExecutionContext["sandboxMode"];
  signal?: AbortSignal;
  requestApproval?: SubagentRunRequest["requestApproval"];
  subagent: SubagentRuntimeContext;
}

/**
 * Build the runtime view from a tool execution context. Fail-safe: when the
 * harness did not attach a subagent context we derive the parent scope from the
 * sandbox mode and treat the caller as a primary agent (depth 0) — never as an
 * already-privileged child.
 */
export function resolveTaskRuntime(ctx: ToolExecutionContext): TaskToolRuntime {
  const attached = ctx.subagent;

  return {
    parentSessionId: ctx.sessionId || "session",
    cwd: ctx.cwd,
    workspaceRoot: ctx.workspaceRoot,
    sandboxMode: ctx.sandboxMode,
    signal: ctx.signal,
    subagent: attached ?? {
      permission: permissionScopeFromSandbox(ctx.sandboxMode || "workspace"),
      depth: ctx.agentDepth ?? 0,
      maxDepth: DEFAULT_SUBAGENT_MAX_DEPTH,
    },
  };
}

/** Render a settled child result as the parent model's tool result. */
export function formatTaskResult(agentId: string, result: SubagentResult): string {
  return renderTaskEnvelope({
    taskId: result.taskId,
    state: result.status,
    summary: result.summary,
    text: result.output?.trim() ?? "",
    agent: result.agent,
    toolCalls: result.toolCalls,
    durationMs: result.durationMs,
    error: result.error,
  });
}

export interface TaskEnvelopeInput {
  taskId: string;
  state: "running" | "completed" | "error" | "cancelled";
  summary: string;
  text: string;
  agent: string;
  toolCalls?: number;
  durationMs?: number;
  error?: string;
}

/**
 * The one author of the `<task …>` envelope, used by the foreground result, the
 * background placeholder and the completion notification alike.
 *
 * Layout is deliberate: the STRUCTURED block comes first so `<task_result>`
 * always carries machine-readable JSON, and the human-readable answer lives in
 * `<subagent_output>`. A failed task uses `<task_error>` for the structured
 * block, so a consumer can tell outcome from element name alone.
 */
export function renderTaskEnvelope(input: TaskEnvelopeInput): string {
  const failed = input.state === "error" || input.state === "cancelled";

  const structured = JSON.stringify({
    task_id: input.taskId,
    agent: input.agent,
    status: input.state,
    summary: input.summary,
    tool_calls: input.toolCalls ?? 0,
    duration_ms: input.durationMs ?? 0,
    ...(input.error ? { error: input.error } : {}),
  });

  const body = input.text?.trim();

  const lines = [
    `<task id="${input.taskId}" state="${input.state}" agent="${input.agent}">`,
    `  <summary>${input.summary}</summary>`,
    failed
      ? `  <task_error>${structured}</task_error>`
      : `  <task_result>${structured}</task_result>`,
    ...(body ? [`  <subagent_output>`, body, `  </subagent_output>`] : []),
    "</task>",
  ];

  return lines.join("\n");
}

/** What the parent model is told after launching background work (§76A.4). */
const BACKGROUND_STARTED = [
  "The task is running in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n");

export function formatTaskRuntime(
  agentId: string,
  result: SubagentResult
): { stdout: string; stderr: string; exitCode: number } {
  const text = formatTaskResult(agentId, result);
  if (result.status === "completed") return { stdout: text, stderr: "", exitCode: 0 };
  return { stdout: text, stderr: result.error || result.summary, exitCode: 1 };
}

/**
 * Execute one `task` call. Registered as the `task` tool's execute hook.
 */
export async function runTaskTool(
  input: TaskToolInput,
  ctx: ToolExecutionContext
): Promise<string> {
  const prompt = String(input?.prompt ?? "").trim();
  if (!prompt) {
    return JSON.stringify({
      stdout: "",
      stderr: "The `task` tool requires a non-empty `prompt` describing what the subagent should do.",
      exitCode: 1,
    });
  }

  // Lazy import: keeps the registry graph small and guarantees the manager is
  // the only construction path for a child run.
  const { subagentManager } = await import("./manager");
  const runtime = resolveTaskRuntime(ctx);
  const agentId = subagentManager.resolveAgentId(input.subagent_type);

  const request: SubagentRunRequest = {
    agentId,
    description: input.description,
    prompt,
    parentSessionId: runtime.parentSessionId,
    parentPermission: runtime.subagent.permission,
    parentDepth: runtime.subagent.depth,
    maxDepth: runtime.subagent.maxDepth,
    cwd: runtime.cwd,
    workspaceRoot: runtime.workspaceRoot,
    sandboxMode: runtime.sandboxMode,
    signal: runtime.signal,
    requestApproval: runtime.requestApproval,
    ...(input.task_id ? { taskId: input.task_id } : {}),
  };

  if (input.background === true) return startBackgroundTask(request, input, agentId);

  const result = await subagentManager.run(request);
  return JSON.stringify(formatTaskRuntime(result.agent, result));
}

/**
 * Launch the child as a background job and return immediately.
 *
 * The job owns the abort signal, so cancelling it cancels the child engine, its
 * provider request and any process tree it started. On settlement the result is
 * pushed into the parent session's inbox — the notification that replaces
 * polling.
 */
async function startBackgroundTask(
  request: SubagentRunRequest,
  input: TaskToolInput,
  agentId: string
): Promise<string> {
  const { subagentManager } = await import("./manager");

  // Resolve the child session up front — a resume keeps the existing session so
  // the job and the session stay correlated from the first event.
  const childSessionId = subagentManager.resolveSessionId({
    parentSessionId: request.parentSessionId,
    agentId,
    ...(request.taskId ? { taskId: request.taskId } : {}),
  });
  const resuming = Boolean(request.taskId && childSessionId === request.taskId);

  const title = input.description?.trim() || `Background ${agentId} task`;

  const job = backgroundJobs.start({
    type: "subagent",
    title,
    parentSessionId: request.parentSessionId,
    childSessionId,
    metadata: {
      agent: agentId,
      depth: request.parentDepth + 1,
      background: true,
    },
    run: (signal) =>
      subagentManager.run({
        ...request,
        // A resume must keep using taskId; a fresh run pins the reserved id.
        ...(resuming ? { sessionId: undefined } : { sessionId: childSessionId }),
        // The job's signal replaces the caller's: the parent turn may end long
        // before this job does, so the job must own cancellation.
        signal,
      }),
    onSettle: (info: BackgroundJobSnapshot) => notifyParent(info, title),
  });

  return JSON.stringify({
    stdout: [
      renderTaskEnvelope({
        taskId: job.childSessionId || job.id,
        state: "running",
        summary: `Background task started: ${title}`,
        text: BACKGROUND_STARTED,
        agent: agentId,
      }),
      `\n<job id="${job.id}" status="${job.status}" />`,
    ].join("\n"),
    stderr: "",
    exitCode: 0,
  });
}

/** Exposed for tests and UIs that need the placeholder text verbatim. */
export function backgroundStartedNotice(): string {
  return BACKGROUND_STARTED;
}

/**
 * Push a settled background result into the owning session's inbox. Never
 * throws: a failed notification must not corrupt the job lifecycle.
 */
function notifyParent(info: BackgroundJobSnapshot, title: string): void {
  if (!info.parentSessionId) return;

  const result = info.result as SubagentResult | undefined;

  // A subagent never throws, so a job can be `completed` while the child run
  // failed. The notification must report the CHILD's verdict — telling the
  // parent "completed" for a failed child is fake success.
  const status =
    info.status === "cancelled" || result?.status === "cancelled"
      ? "cancelled"
      : info.status === "completed" && result?.status !== "error"
        ? "completed"
        : "error";

  const summary =
    status === "error"
      ? result?.error || result?.summary || info.error || "Background task failed."
      : result?.summary || info.error || "Background task finished.";

  const content = renderBackgroundNotification({
    jobId: info.childSessionId || info.id,
    title,
    status,
    summary,
    ...(result?.output ? { output: result.output } : {}),
  });

  sessionInbox.push(info.parentSessionId, content, {
    jobId: info.id,
    metadata: { status: info.status, agent: result?.agent },
  });
}
