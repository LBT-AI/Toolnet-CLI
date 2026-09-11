import {
  toolBash,
  toolRead,
  toolWrite,
  toolEdit,
  toolReplaceAll,
  toolGrep,
  toolGlob,
  toolGetCwd,
  toolListDir,
  toolTree,
  toolFileExists,
  toolWebFetch,
  toolAuditUrl,
  toolFindPath,
  toolGitStatus,
  toolGitDiff,
  toolApplyPatch,
} from "./codingAgent";
import {
  verifyFileWritten,
  verifyFileEdited,
  snapshotFileHash,
  verifyArtifactWritten,
} from "./toolVerification";
import { getMcpAgentTools as getMcpRunnerAgentTools, executeMcpTool } from "./mcpRunner";
import { executeBrowserTool } from "./browserTool";
import { ToolCache } from "./harness/toolPlanner";
import { toolRegistry } from "./harness/toolRegistry";
import type { ToolExecutionContext } from "./security/types";

// ── Shared tool cache — used by ALL callers (TUI, AgentRuntime, SubAgent, Harness)
const _toolCache = new ToolCache();

export function getToolCache(): ToolCache {
  return _toolCache;
}

export function flushToolCache(): void {
  _toolCache.invalidateAll();
}

/**
 * Model-facing tool schemas.
 *
 * Phase 73.11 — this array is DERIVED from `toolRegistry`, the single schema
 * source. The historical hand-maintained array duplicated every definition and
 * additionally leaked dispatch aliases (`glob_search`, `grep_search`) to the
 * model. Deriving here makes the registry comment literally true and guarantees
 * the model sees exactly the canonical names the registry declares.
 */
export const agentTools = toolRegistry.schemas();

export function getMcpAgentTools(): Array<any> {
  return getMcpRunnerAgentTools();
}

export function getMergedAgentTools(): Array<any> {
  return [...agentTools, ...getMcpAgentTools()];
}

export function isDangerousCommand(name: string, args: any, cwd: string): boolean {
  const { securityEngine } = require("./security/securityEngine");
  const { getSandboxMode } = require("./permissions");
  const perm = securityEngine.evaluate(name, args, getSandboxMode(), cwd);
  return perm.needsApproval || !perm.allowed;
}

export interface ExecuteToolOptions {
  cwd?: string;
  workspaceRoot?: string;
  sandboxMode?: "workspace" | "ask" | "full-access";
  userApproved?: boolean;
  /** Layer 4 Phase 1: full security context propagated to the executor. */
  sessionId?: string;
  agentRole?: string;
  agentDepth?: number;
  source?: "tui" | "headless" | "subagent" | "teamwork" | "plugin" | "vision" | "mcp";
  /** Abort signal — propagated to long-running executors (shell, fetch). */
  signal?: AbortSignal;
}

// ── Raw tool execution (no cache, no compression) ──────────────────────
// INTERNAL executor — invoked ONLY by ToolGateway. It performs NO security
// evaluation, NO approval gating, and MUST NOT be used as a public execution
// entrypoint. All production callers must go through ToolGateway.execute()
// (executeTool is a thin compatibility wrapper around the gateway).

export async function _executeToolRaw(name: string, args: any, options?: ExecuteToolOptions): Promise<string> {
  // Guard: pre-aborted request — nothing executes after cancellation.
  if (options?.signal?.aborted) {
    return JSON.stringify({ stdout: "", stderr: "Cancelled", exitCode: 130 });
  }

  // Path-resolving tools MUST receive the explicit execution context. Falling
  // back to module-global cwd would write/read outside the configured
  // workspace (e.g. a harness workspace that differs from process.cwd()).
  const pathCtx = { cwd: options?.cwd, workspaceRoot: options?.workspaceRoot };

  try {
    if (name === "get_cwd") {
      const res = toolGetCwd();
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "list_dir") {
      const dirPath = args.path || ".";
      const res = toolListDir(dirPath, pathCtx);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "file_exists") {
      const filePath = args.path || ".";
      const res = toolFileExists(filePath, pathCtx);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "find_path") {
      const res = toolFindPath(args.query, args.root, args.maxDepth, args.type, pathCtx);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "run_command" || name === "shell") {
      const cmd = args.command || args.cmd || "";
      // Hardened executor receives the EXPLICIT execution context — never
      // module-global cwd/workspace/mode when a caller context exists.
      const res = await toolBash(cmd, 30000, {
        cwd: options?.cwd,
        workspaceRoot: options?.workspaceRoot,
        sandboxMode: options?.sandboxMode,
        env: typeof args.env === "object" && args.env !== null ? args.env : undefined,
        signal: options?.signal,
      });
      return JSON.stringify({ stdout: res.stdout || "", stderr: res.stderr || res.error || "", exitCode: res.exitCode });
    } else if (name === "tree") {
      const res = toolTree(args.path, args.depth, pathCtx);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "read_file") {
      const res = toolRead(args.path, args.offset || 0, args.limit || 500, pathCtx);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "write_file") {
      const res = toolWrite(args.path, args.content, pathCtx);
      if (res.success) {
        // Postcondition: the file must REALLY exist and be readable after the
        // write. A tool success payload alone is not proof of mutation.
        const post = verifyFileWritten(args.path, pathCtx);
        if (!post.ok) {
          return JSON.stringify({ stdout: "", stderr: post.error, exitCode: 1 });
        }
      }
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "edit_file") {
      const oldStr = args.old_string || args.oldString || "";
      const newStr = args.new_string || args.newString || "";
      const beforeHash = snapshotFileHash(args.path, pathCtx);
      const res = toolEdit(args.path, oldStr, newStr, pathCtx);
      if (res.success) {
        const post = verifyFileEdited(args.path, beforeHash, pathCtx);
        if (!post.ok) {
          return JSON.stringify({ stdout: "", stderr: post.error, exitCode: 1 });
        }
      }
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "replace_all") {
      const oldStr = args.old_string || args.oldString || "";
      const newStr = args.new_string || args.newString || "";
      const beforeHash = snapshotFileHash(args.path, pathCtx);
      const res = toolReplaceAll(args.path, oldStr, newStr, pathCtx);
      if (res.success) {
        const post = verifyFileEdited(args.path, beforeHash, pathCtx);
        if (!post.ok) {
          return JSON.stringify({ stdout: "", stderr: post.error, exitCode: 1 });
        }
      }
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "apply_patch" || name === "patch") {
      const patchText = args.patch || args.diff || "";
      const res = await toolApplyPatch(patchText);
      if (res.success) {
        // Patches may create or modify multiple files; re-verify every target
        // path the patch declared (a/b/ headers). At least one must exist.
        const targets = extractPatchTargets(patchText);
        if (targets.length > 0) {
          const missing = targets.filter((t) => {
            const v = verifyFileWritten(t, pathCtx);
            return !v.ok;
          });
          if (missing.length === targets.length) {
            return JSON.stringify({ stdout: "", stderr: `patch reported success but none of its target files exist: ${targets.join(", ")}`, exitCode: 1 });
          }
        }
      }
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "git_status") {
      const res = await toolGitStatus(args.path);
      return JSON.stringify({ stdout: res.stdout || res.data || "", stderr: res.stderr || res.error || "", exitCode: res.exitCode ?? (res.success ? 0 : 1) });
    } else if (name === "git_diff") {
      const res = await toolGitDiff(args.path, Boolean(args.staged));
      return JSON.stringify({ stdout: res.stdout || res.data || "", stderr: res.stderr || res.error || "", exitCode: res.exitCode ?? (res.success ? 0 : 1) });
    } else if (name === "grep" || name === "grep_search") {
      const searchPath = args.path || ".";
      const res = toolGrep(args.pattern, searchPath, args.include, pathCtx);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "glob" || name === "glob_search") {
      const searchPath = args.path || ".";
      const res = toolGlob(args.pattern, searchPath, pathCtx);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "web_fetch" || name === "web_crawl" || name === "fetch") {
      const url = args.url || args.link || "";
      const res = await toolWebFetch(url, options?.signal);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "browser" || name === "browser_action" || name === "playwright") {
      const res = await executeBrowserTool(args);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "audit_url" || name === "audit") {
      const url = args.url || args.link || "";
      const res = await toolAuditUrl(url);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "create_artifact" || name === "update_artifact") {
      const artifactName = args.name || "";
      const content = args.content || "";
      if (!artifactName) {
        return JSON.stringify({ stdout: "", stderr: "Missing artifact name", exitCode: 1 });
      }
      const targetPath = `.artifacts/${artifactName}`;
      const res = toolWrite(targetPath, content);
      if (res.success) {
        const post = verifyArtifactWritten(artifactName);
        if (!post.ok) {
          return JSON.stringify({ stdout: "", stderr: post.error, exitCode: 1 });
        }
      }
      return JSON.stringify({ stdout: res.success ? `Artifact ${name === "create_artifact" ? "created" : "updated"}: ${artifactName}` : "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    } else if (name === "spawn_subagent" || name === "delegate_task") {
      const { executeSubagentTask } = await import("../teamwork/subagentRuntime");
      const role = args.role || "GENERAL";
      const task = args.task || args.prompt || "";
      const context = args.context || "";
      const res = await executeSubagentTask({
        id: `sub-${Date.now()}`,
        title: task.slice(0, 50),
        role: role.toUpperCase() as any,
        prompt: context ? `${context}\n\nTask: ${task}` : task,
        status: "PENDING",
        dependencies: [],
      });
      return JSON.stringify({ stdout: res.output || "", stderr: res.error || "", exitCode: res.success ? 0 : 1, tokensUsed: res.tokensUsed, toolCallsCount: res.toolCallsCount });
    } else {
      const mcpResult = await executeMcpTool(name, args);
      if (mcpResult !== null) {
        return mcpResult;
      }
      const regEntry = toolRegistry.get(name);
      if (regEntry?.execute) {
        const ctx: ToolExecutionContext = options
          ? {
              cwd: options.cwd,
              workspaceRoot: options.workspaceRoot,
              sandboxMode: options.sandboxMode,
              signal: options.signal,
              sessionId: options.sessionId,
              agentRole: options.agentRole,
              agentDepth: options.agentDepth,
              source: options.source,
            }
          : {};
        const result = await regEntry.execute(args, ctx);
        return result;
      }
      return JSON.stringify({ stdout: "", stderr: `Unknown tool: ${name}`, exitCode: 1 });
    }
  } catch (e: any) {
    return JSON.stringify({ stdout: "", stderr: `Error executing tool: ${e.message}`, exitCode: 1 });
  }
}

/**
 * Public executeTool — thin COMPATIBILITY WRAPPER around ToolGateway.execute.
 * Layer 4 Phase 1: the ONLY security evaluation happens inside the gateway
 * (SecurityEngine). This wrapper re-evaluates nothing and returns the gateway
 * result. userApproved is forwarded so an interactive caller that already
 * obtained user consent can execute an ASK tool once.
 */
export async function executeTool(name: string, args: any, options?: ExecuteToolOptions): Promise<string> {
  try {
    const { ToolGateway } = await import("./security/toolGateway");
    const res = await ToolGateway.execute(
      { name, args },
      {
        cwd: options?.cwd,
        workspaceRoot: options?.workspaceRoot,
        sandboxMode: options?.sandboxMode,
        userApproved: options?.userApproved,
        sessionId: options?.sessionId,
        agentRole: options?.agentRole,
        agentDepth: options?.agentDepth,
        source: options?.source,
        signal: options?.signal,
      }
    );
    if (!res.allowed) {
      return JSON.stringify({
        stdout: "",
        stderr: res.stderr || res.reason || "Permission denied by sandbox policy.",
        exitCode: res.exitCode ?? 1,
        ...(res.needsApproval ? { needsApproval: true, approvalRequired: true } : {}),
      });
    }
    return res.stdout;
  } catch (e: any) {
    return JSON.stringify({ stdout: "", stderr: `Error executing tool: ${e.message}`, exitCode: 1 });
  }
}

/**
 * Extract target file paths from a unified-diff patch (a/ b/ headers), used to
 * verify patch postconditions. Best-effort: skips /dev/null targets.
 */
export function extractPatchTargets(patchText: string): string[] {
  const targets = new Set<string>();
  for (const m of patchText.matchAll(/^\+\+\+ \S+/gm)) {
    const raw = m[0].replace(/^\+\+\+ /, "").trim();
    if (!raw || raw === "/dev/null") continue;
    targets.add(raw.replace(/^b\//, "").replace(/\t.*$/, ""));
  }
  return [...targets];
}
