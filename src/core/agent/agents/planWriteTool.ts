/**
 * `plan_write` — the ONE mutation Plan is allowed.
 *
 * Plan mode is read-only everywhere except the session's own plan file. This
 * tool is the dedicated capability for that single write class:
 *
 *   <workspaceRoot>/.toolnet/plans/<session-id>.md
 *
 * Security model (why not generic write_file):
 *   - The path is DERIVED from the execution context (workspaceRoot + session),
 *     never taken from tool input, so the model cannot aim it anywhere else.
 *   - Content is the only model-controlled input.
 *   - The write goes through the security-evaluated `toolWrite` (workspace
 *     invariant, history snapshot) — never a raw fs write bypass.
 *   - A second session in the same workspace gets a different file; `/cd`
 *     cannot move an existing plan because the path is workspaceRoot-stable.
 *
 * The tool carries risk "write" so permission scopes that deny mutation tools
 * must explicitly ALLOW this name for a Plan turn — the scope, not the tool,
 * decides. A generic scope that denies write_file does NOT deny plan_write
 * unless the scope says so; the Plan wiring grants exactly this exception.
 */

export const PLAN_DIR = ".toolnet/plans";

/** Filesystem-safe plan file stem for a session id. */
export function planFileStem(sessionId: string): string {
  const cleaned = String(sessionId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  return (cleaned || "session").slice(0, 80);
}

/**
 * The exact plan path for a session. `workspaceRoot` wins over `cwd` so a
 * `/cd` inside the workspace never relocates the plan; session id (sanitized)
 * keeps concurrent sessions collision-free.
 */
export function planPathForSession(workspaceRoot: string, sessionId: string): string {
  return `${workspaceRoot.replace(/\/+$/, "")}/${PLAN_DIR}/${planFileStem(sessionId)}.md`;
}

/** Parse a `session-id: content` plan_write input. */
export function parsePlanWriteInput(args: any): { content: string; status?: string } | null {
  if (!args || typeof args !== "object") return null;
  const content = typeof args.content === "string" ? args.content : null;
  if (content === null) return null;
  const status = typeof args.status === "string" ? args.status : undefined;
  return { content, status };
}

/** Metadata header written (idempotently) at the top of a plan file. */
export function buildPlanHeader(sessionId: string, workspaceRoot: string, status: string): string {
  return [
    "<!-- toolnet:plan",
    `session: ${sessionId}`,
    `workspace: ${workspaceRoot}`,
    `updated: ${new Date().toISOString()}`,
    `status: ${status}`,
    "-->",
  ].join("\n");
}

/** Replace or insert the status line in an existing metadata header. */
export function setPlanStatus(content: string, status: string): string {
  if (!content.includes("<!-- toolnet:plan")) return content;
  return content.replace(/^status: .*$/m, `status: ${status}`);
}

export const PLAN_WRITE_TOOL = {
  name: "plan_write",
  description: [
    "Save or update the execution plan for THIS session.",
    "",
    "The plan file path is managed by ToolNet: it is always",
    "`<workspaceRoot>/.toolnet/plans/<session-id>.md` and cannot be changed.",
    "Only the plan `content` is yours to provide.",
    "",
    "The final save is your plan exit: after it, the user reviews the plan and",
    "chooses whether to approve it for Build execution. Do not write source",
    "files, run commands, or write to any other path — you cannot.",
  ].join("\n"),
  parameters: {
    type: "object",
    properties: {
      content: { type: "string", description: "Full plan content (Markdown), metadata header excluded." },
      status: { type: "string", enum: ["draft", "ready"], description: "Plan lifecycle status. Final saves use 'ready'." },
    },
    required: ["content"],
  },
  risk: "write" as const,
  category: "Plan",
  async execute(input: { content?: string; status?: string }, ctx: { workspaceRoot?: string; sessionId?: string }) {
    const parsed = parsePlanWriteInput(input);
    if (!parsed) {
      return JSON.stringify({ stdout: "", stderr: "plan_write requires string `content`.", exitCode: 1 });
    }
    const workspaceRoot = (ctx?.workspaceRoot || process.cwd()).replace(/\/+$/, "");
    const sessionId = ctx?.sessionId || "session";
    const planPath = planPathForSession(workspaceRoot, sessionId);

    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });

    // The one class of mutation allowed: through the security-evaluated
    // writer, at the derived path, with the session header maintained.
    const { toolWrite } = await import("../../../lib/codingAgent");
    const existing = fs.existsSync(planPath) ? fs.readFileSync(planPath, "utf8") : "";
    const status = parsed.status === "draft" ? "draft" : "ready";
    const keepHeader = existing.startsWith("<!-- toolnet:plan")
      ? existing.split("-->")[0] + "-->"
      : buildPlanHeader(sessionId, workspaceRoot, status);
    const body = parsed.content.replace(/^<!-- toolnet:plan[\s\S]*?-->\n?/, "");
    const header = setPlanStatus(keepHeader, status);

    const writeRes = toolWrite(planPath, `${header}\n\n${body.trim()}\n`);
    if (!writeRes.success) {
      return JSON.stringify({ stdout: "", stderr: writeRes.error || "Failed to write plan", exitCode: 1 });
    }
    return JSON.stringify({
      stdout: `Plan saved: .toolnet/plans/${planFileStem(sessionId)}.md (status: ${status})`,
      planPath,
      planStatus: status,
      exitCode: 0,
    });
  },
};
