/**
 * Phase 75.7 — Canonical `task` tool
 *
 * The single entry point a model uses to delegate work. It is a normal registry
 * tool: it goes through the same permission gate, executes through the same
 * SubagentManager, and returns a normal {@link ToolResult} envelope.
 *
 * The tool is intentionally thin. Everything security-relevant (depth guard,
 * scoped tools, derived permission) lives in the manager so it cannot be
 * bypassed by calling the tool with different arguments.
 */

import type {
  SubagentRuntimeContext,
  ToolExecutionContext,
} from "../../../lib/security/types";
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

/** Render the child result as the parent model's tool result. */
export function formatTaskResult(agentId: string, result: SubagentResult): string {
  const header = `Subagent "${agentId}" ${result.status} — task ${result.taskId}, ${result.toolCalls} tool call(s), ${result.durationMs}ms.`;

  const body = result.output?.trim() ? `\n\n<subagent_output>\n${result.output.trim()}\n</subagent_output>` : "";

  // Structured companion so the parent model can branch on status without
  // parsing prose. Both forms describe exactly the same run.
  const structured = `\n\n<task_result>${JSON.stringify({
    task_id: result.taskId,
    agent: result.agent,
    status: result.status,
    summary: result.summary,
    tool_calls: result.toolCalls,
    duration_ms: result.durationMs,
    ...(result.error ? { error: result.error } : {}),
  })}</task_result>`;

  return `${header}${body}${structured}`;
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

  const runtime = resolveTaskRuntime(ctx);

  // Lazy import: keeps the registry graph small and guarantees the manager is
  // the only construction path for a child run.
  const { subagentManager } = await import("./manager");

  const result = await subagentManager.run({
    agentId: input.subagent_type,
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
  });

  const text = formatTaskResult(result.agent, result);

  if (result.status === "completed") {
    return JSON.stringify({ stdout: text, stderr: "", exitCode: 0 });
  }

  return JSON.stringify({ stdout: text, stderr: result.error || result.summary, exitCode: 1 });
}
