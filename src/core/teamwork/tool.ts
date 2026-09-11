/**
 * Phase 76B.11 — Canonical `teamwork` tool
 *
 * The tool only SUBMITS a plan. Execution stays in the shared engine: every
 * node becomes a BackgroundJob whose work is a scoped subagent run. The tool
 * therefore adds no execution path, and a malformed plan is rejected before a
 * single node runs.
 */

import type { ToolExecutionContext } from "../../lib/security/types";
import type { ToolDefinition } from "../../lib/harness/toolRegistry";
import { backgroundJobs, renderBackgroundNotification, sessionInbox } from "../background";
import { permissionScopeFromSandbox } from "../agent/agents/permissions";
import { DEFAULT_SUBAGENT_MAX_DEPTH } from "../agent/agents/types";
import type { TeamworkResult, TeamworkPlan } from "./types";
import type { TeamworkRunOptions } from "./engine";

const DESCRIPTION = [
  "Run a small dependency graph of specialised subagents as one unit of work.",
  "",
  "Each node names an agent (explore | coder | tester | reviewer | general) and a",
  "prompt, and may depend on other nodes by id. Independent nodes run in",
  "parallel; dependent nodes receive their dependencies' declared results (not",
  "their transcripts).",
  "",
  "Use this only when the work genuinely splits into stages with dependencies",
  "that must observe each other. For a single step, call `task` instead.",
  "",
  "Node fields:",
  "  id         unique short id (letters, digits, dot, dash, underscore)",
  "  agent      agent to run this node",
  "  prompt     the instruction for that agent",
  "  dependsOn  ids this node must wait for (default [])",
  "  condition  on_success (default) | on_failure | always",
  "  timeoutMs  optional per-node timeout",
  "  retry      optional { maxAttempts } (bounded)",
  "",
  "The plan is validated first: duplicate ids, unknown dependencies, cycles,",
  "unknown agents or out-of-range retries reject the whole plan without",
  "executing anything.",
].join("\n");

export interface TeamworkToolInput {
  nodes?: TeamworkPlan["nodes"];
  id?: string;
  /** Run the plan asynchronously and return immediately (Phase 76A). */
  background?: boolean;
}

interface TeamworkRuntime {
  parentSessionId: string;
  parentPermission: ReturnType<typeof permissionScopeFromSandbox>;
  parentDepth: number;
  maxDepth: number;
  cwd?: string;
  workspaceRoot?: string;
  sandboxMode?: ToolExecutionContext["sandboxMode"];
  signal?: AbortSignal;
  requestApproval?: TeamworkRunOptions["requestApproval"];
}

/** Same fail-safe resolution as the `task` tool: never assume extra privilege. */
function resolveRuntime(ctx: ToolExecutionContext): TeamworkRuntime {
  const attached = ctx.subagent;
  return {
    parentSessionId: ctx.sessionId || "session",
    parentPermission: attached?.permission ?? permissionScopeFromSandbox(ctx.sandboxMode || "workspace"),
    parentDepth: attached?.depth ?? ctx.agentDepth ?? 0,
    maxDepth: attached?.maxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH,
    cwd: ctx.cwd,
    workspaceRoot: ctx.workspaceRoot,
    sandboxMode: ctx.sandboxMode,
    signal: ctx.signal,
    requestApproval: attached?.requestApproval,
  };
}

/** Render the aggregate plan result for the parent model. */
export function renderTeamworkResult(result: TeamworkResult): string {
  const rows = Object.values(result.nodes).map((node) => {
    const attempts = node.attempts > 1 ? ` attempts=${node.attempts}` : "";
    return `  <node id="${node.nodeId}" agent="${node.agent}" status="${node.status}"${attempts}>${escape(node.summary)}</node>`;
  });

  return [
    `<teamwork id="${result.id}" state="${result.status}" duration_ms="${result.durationMs}">`,
    ...rows,
    `  <teamwork_result>${JSON.stringify({
      id: result.id,
      status: result.status,
      duration_ms: result.durationMs,
      nodes: Object.fromEntries(
        Object.entries(result.nodes).map(([id, node]) => [
          id,
          {
            status: node.status,
            agent: node.agent,
            attempts: node.attempts,
            error: node.error,
            child_session_id: node.childSessionId,
          },
        ])
      ),
      ...(result.error ? { error: result.error } : {}),
    })}</teamwork_result>`,
    "</teamwork>",
  ].join("\n");
}

function escape(value: string): string {
  return String(value ?? "").replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));
}

export async function runTeamworkTool(
  input: TeamworkToolInput,
  ctx: ToolExecutionContext
): Promise<string> {
  const nodes = Array.isArray(input?.nodes) ? input.nodes : [];
  if (nodes.length === 0) {
    return JSON.stringify({
      stdout: "",
      stderr: "The `teamwork` tool requires a non-empty `nodes` array.",
      exitCode: 1,
    });
  }

  const plan: TeamworkPlan = {
    id: input.id?.trim() || `teamwork_${Date.now().toString(36)}`,
    nodes,
  };

  const runtime = resolveRuntime(ctx);
  const { TeamworkEngine } = await import("./engine");
  const engine = new TeamworkEngine();

  const runOptions: TeamworkRunOptions = {
    plan,
    parentSessionId: runtime.parentSessionId,
    parentPermission: runtime.parentPermission,
    parentDepth: runtime.parentDepth,
    maxDepth: runtime.maxDepth,
    cwd: runtime.cwd,
    workspaceRoot: runtime.workspaceRoot,
    sandboxMode: runtime.sandboxMode,
    requestApproval: runtime.requestApproval,
  };

  if (input.background === true) return startBackgroundPlan(engine, runOptions, plan);

  const result = await engine.run({ ...runOptions, signal: runtime.signal });
  const text = renderTeamworkResult(result);

  return JSON.stringify({
    stdout: text,
    stderr: result.status === "completed" ? "" : result.error || `Plan ${result.status}`,
    exitCode: result.status === "completed" ? 0 : 1,
  });
}

/**
 * Launch the whole plan as one background job. Node-level jobs are still the
 * unit of execution; this job only represents the plan for the parent.
 */
async function startBackgroundPlan(
  engine: { run: (options: TeamworkRunOptions) => Promise<TeamworkResult> },
  runOptions: TeamworkRunOptions,
  plan: TeamworkPlan
): Promise<string> {
  const title = `Teamwork plan ${plan.id} (${plan.nodes.length} nodes)`;

  const job = backgroundJobs.start({
    type: "teamwork",
    title,
    parentSessionId: runOptions.parentSessionId,
    metadata: {
      teamworkId: plan.id,
      background: true,
      nodes: plan.nodes.map((n) => n.id),
    },
    run: (signal) => engine.run({ ...runOptions, signal }),
    onSettle: (info) => {
      const result = info.result as TeamworkResult | undefined;
      if (!info.parentSessionId) return;
      const status =
        info.status === "completed" ? "completed" : info.status === "cancelled" ? "cancelled" : "error";
      sessionInbox.push(
        info.parentSessionId,
        renderBackgroundNotification({
          jobId: jobIdOf(info, plan),
          title,
          status,
          summary: result?.error || `Plan finished with status ${result?.status ?? info.status}`,
          output: result ? renderTeamworkResult(result) : info.error,
        }),
        { jobId: info.id, metadata: { teamworkId: plan.id, status: info.status } }
      );
    },
  });

  return JSON.stringify({
    stdout: [
      `<teamwork id="${plan.id}" state="running">`,
      `  <summary>${title}</summary>`,
      `  <job id="${job.id}" status="${job.status}" />`,
      "</teamwork>",
      "",
      "The plan is running in the background. You will be notified when it finishes.",
      "DO NOT sleep, poll for progress, or duplicate the work it is doing.",
    ].join("\n"),
    stderr: "",
    exitCode: 0,
  });
}

function jobIdOf(info: { id: string }, plan: TeamworkPlan): string {
  return `${plan.id}@${info.id}`;
}

/** Registry entry for the canonical `teamwork` tool. */
export const teamworkToolDefinition: ToolDefinition<TeamworkToolInput, string> = {
  name: "teamwork",
  description: DESCRIPTION,
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Optional plan id (for logs/observability)." },
      background: {
        type: "boolean",
        description:
          "Run the plan asynchronously and return immediately. You will be notified when it completes.",
      },
      nodes: {
        type: "array",
        description: "The dependency graph of subagent steps.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique short node id." },
            title: { type: "string", description: "Short label for this step." },
            agent: {
              type: "string",
              enum: ["explore", "coder", "tester", "reviewer", "general"],
            },
            prompt: { type: "string", description: "Instruction for this node's agent." },
            dependsOn: {
              type: "array",
              items: { type: "string" },
              description: "Node ids this step must wait for.",
            },
            condition: {
              type: "string",
              enum: ["on_success", "on_failure", "always"],
              description: "When this node runs relative to its dependencies.",
            },
            timeoutMs: { type: "number", description: "Optional per-node timeout." },
            retry: {
              type: "object",
              properties: { maxAttempts: { type: "number" } },
              description: "Optional bounded retry policy.",
            },
          },
          required: ["id", "agent", "prompt"],
        },
      },
    },
    required: ["nodes"],
  },
  risk: "execute",
  category: "Agent",
  async execute(input, ctx) {
    const { runTeamworkTool } = await import("./tool");
    return runTeamworkTool(input ?? { nodes: [] }, ctx);
  },
};
