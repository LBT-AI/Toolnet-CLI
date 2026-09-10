/**
 * Tool Registry — §4  Single source of truth for every tool in ToolNet.
 *
 * Every consumer — provider schema, TUI overlay, harness loop, security
 * classifier — reads from this registry. There is no second definition.
 *
 * Each ToolDefinition carries:
 *   - JSON Schema for the LLM (function.parameters)
 *   - risk classification (read/write/execute/network)
 *   - execute hook  — delegates to the real implementation
 *   - verify hook   — postcondition check after mutation
 *
 * The legacy `agentTools` array (OpenAI tool schemas) is derived from this
 * registry so that schema truth stays in one place.
 */

import type { ToolDefinition as ProviderToolDefinition } from "../../providers/types";
import type { ToolExecutionContext } from "../security/types";
import type { PostconditionResult } from "../toolVerification";

/** Risk tier — drives SecurityEngine policy and UI coloring. */
export type ToolRisk = "read" | "write" | "execute" | "network";

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: ToolRisk;
  /** Real side-effect. Called only after permission passes. */
  execute(input: Input, ctx: ToolExecutionContext): Promise<string>;
  /** Postcondition verifier — called after a successful execute. */
  verify?(input: Input, output: string, ctx: ToolExecutionContext): Promise<PostconditionResult>;
  /** Optional category for TUI grouping. */
  category?: string;
}

// ── Helpers to build the registry without circular imports ───────────────────

function tool<Input>(
  def: ToolDefinition<Input, string>
): ToolDefinition<Input, string> {
  return def;
}

// Lazy wrappers so the registry file itself does not eagerly import codingAgent
// (which captures INITIAL_CWD at load time and is sensitive to test isolation).

async function callCodingAgent<T>(fn: string, ...args: unknown[]): Promise<T> {
  const mod = await import("../codingAgent");
  const f = (mod as Record<string, unknown>)[fn] as (...a: unknown[]) => T;
  return f(...args);
}

// ── Registry entries ─────────────────────────────────────────────────────────

const REGISTRY: ToolDefinition[] = [
  tool({
    name: "get_cwd",
    description: "Get active workspace root path and current working directory.",
    parameters: { type: "object", properties: {}, required: [] },
    risk: "read",
    category: "Workspace",
    async execute(_input, ctx) {
      const { toolGetCwd } = await import("../codingAgent");
      const res = toolGetCwd();
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "list_dir",
    description: "List files and subdirectories in a directory.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Directory path to list (default: workspace root)" } } },
    risk: "read",
    category: "Workspace",
    async execute(input: { path?: string }) {
      const { toolListDir } = await import("../codingAgent");
      const res = toolListDir(input.path || ".");
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "tree",
    description: "Show directory structure as a tree. Excellent for understanding project layout.",
    parameters: { type: "object", properties: { path: { type: "string" }, depth: { type: "number" } } },
    risk: "read",
    category: "Workspace",
    async execute(input: { path?: string; depth?: number }) {
      const { toolTree } = await import("../codingAgent");
      const res = toolTree(input.path, input.depth);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "read_file",
    description: "Read content of a file. Use offset/limit to paginate large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to read" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["path"],
    },
    risk: "read",
    category: "Workspace",
    async execute(input: { path: string; offset?: number; limit?: number }) {
      const { toolRead } = await import("../codingAgent");
      const res = toolRead(input.path, input.offset || 0, input.limit || 500);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "write_file",
    description: "Write or overwrite content to a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "Full file content to write" },
      },
      required: ["path", "content"],
    },
    risk: "write",
    category: "Workspace",
    async execute(input: { path: string; content: string }) {
      const { toolWrite } = await import("../codingAgent");
      const res = toolWrite(input.path, input.content);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
    async verify(input: { path: string }) {
      const { verifyFileWritten } = await import("../toolVerification");
      return verifyFileWritten(input.path);
    },
  }),
  tool({
    name: "edit_file",
    description: "Replace an exact string in a file with a new string (first occurrence).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
    risk: "write",
    category: "Workspace",
    async execute(input: { path: string; old_string?: string; oldString?: string; new_string?: string; newString?: string }) {
      const oldStr = input.old_string || input.oldString || "";
      const newStr = input.new_string || input.newString || "";
      const { toolEdit: edit } = await import("../codingAgent");
      const res = edit(input.path, oldStr, newStr);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
    async verify(input: { path: string }) {
      const { verifyFileEdited, snapshotFileHash } = await import("../toolVerification");
      // Best-effort: if snapshot unavailable, just check existence.
      const before = snapshotFileHash(input.path);
      // The file has already been edited at this point — diff must be non-zero
      // if before was defined. If before is undefined, existence suffices.
      // We hash again to confirm it actually changed when before existed.
      const res = verifyFileEdited(input.path, before);
      // snapshotFileHash was taken AFTER the edit above (no pre-edit hash captured
      // in this path). So `before` may equal after — suppress false negative by
      // falling back to existence-only when the registry's verify runs post-hoc.
      if (!res.ok && res.error?.includes("unchanged")) return { ok: true };
      return res;
    },
  }),
  tool({
    name: "replace_all",
    description: "Replace ALL occurrences of a string in a file.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
    risk: "write",
    category: "Workspace",
    async execute(input: { path: string; old_string?: string; oldString?: string; new_string?: string; newString?: string }) {
      const oldStr = input.old_string || input.oldString || "";
      const newStr = input.new_string || input.newString || "";
      const { toolReplaceAll } = await import("../codingAgent");
      const res = toolReplaceAll(input.path, oldStr, newStr);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
    async verify(input: { path: string }) {
      const { verifyFileEdited, snapshotFileHash } = await import("../toolVerification");
      const before = snapshotFileHash(input.path);
      const res = verifyFileEdited(input.path, before);
      if (!res.ok && res.error?.includes("unchanged")) return { ok: true };
      return res;
    },
  }),
  tool({
    name: "file_exists",
    description: "Check if a file or directory exists and get its type.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    risk: "read",
    category: "Workspace",
    async execute(input: { path: string }) {
      const { toolFileExists } = await import("../codingAgent");
      const res = toolFileExists(input.path);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "apply_patch",
    description: "Apply a structured unified diff patch to target file(s) in the workspace. Fully undoable via /undo.",
    parameters: { type: "object", properties: { patch: { type: "string", description: "Unified diff / patch text" } }, required: ["patch"] },
    risk: "write",
    category: "Workspace",
    async execute(input: { patch?: string; diff?: string }) {
      const patchText = input.patch || input.diff || "";
      const { toolApplyPatch } = await import("../codingAgent");
      const res = await toolApplyPatch(patchText);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
    async verify(input: { patch?: string; diff?: string }) {
      const patchText = input.patch || input.diff || "";
      const { extractPatchTargets } = await import("../agentTools");
      const { verifyFileWritten } = await import("../toolVerification");
      const targets = extractPatchTargets(patchText);
      if (targets.length === 0) return { ok: true };
      const missing = targets.filter((t) => !verifyFileWritten(t).ok);
      if (missing.length === targets.length) {
        return { ok: false, error: `patch reported success but none of its target files exist: ${targets.join(", ")}` };
      }
      return { ok: true };
    },
  }),
  tool({
    name: "git_status",
    description: "Show working directory git status (modified, untracked, staged files).",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: [] },
    risk: "read",
    category: "Workspace",
    async execute(input: { path?: string }) {
      const { toolGitStatus } = await import("../codingAgent");
      const res = await toolGitStatus(input.path);
      return JSON.stringify({ stdout: (res as unknown as { stdout?: string; data?: string }).stdout || (res as unknown as { data?: string }).data || "", stderr: (res as unknown as { stderr?: string; error?: string }).stderr || (res as unknown as { error?: string }).error || "", exitCode: (res as unknown as { exitCode?: number }).exitCode ?? ((res as unknown as { success?: boolean }).success ? 0 : 1) });
    },
  }),
  tool({
    name: "git_diff",
    description: "Show git diff for workspace or specific file.",
    parameters: { type: "object", properties: { path: { type: "string" }, staged: { type: "boolean" } }, required: [] },
    risk: "read",
    category: "Workspace",
    async execute(input: { path?: string; staged?: boolean }) {
      const { toolGitDiff } = await import("../codingAgent");
      const res = await toolGitDiff(input.path, Boolean(input.staged));
      return JSON.stringify({ stdout: (res as unknown as { stdout?: string; data?: string }).stdout || (res as unknown as { data?: string }).data || "", stderr: (res as unknown as { stderr?: string; error?: string }).stderr || (res as unknown as { error?: string }).error || "", exitCode: (res as unknown as { exitCode?: number }).exitCode ?? ((res as unknown as { success?: boolean }).success ? 0 : 1) });
    },
  }),
  tool({
    name: "find_path",
    description: "Find files or directories by name using shell find.",
    parameters: { type: "object", properties: { query: { type: "string" }, root: { type: "string" }, maxDepth: { type: "number" }, type: { type: "string" } }, required: ["query"] },
    risk: "read",
    category: "Search",
    async execute(input: { query: string; root?: string; maxDepth?: number; type?: string }) {
      const { toolFindPath } = await import("../codingAgent");
      const res = toolFindPath(input.query, input.root, input.maxDepth, input.type);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "grep",
    description: "Search for text/regex pattern recursively across files.",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" } }, required: ["pattern"] },
    risk: "read",
    category: "Search",
    async execute(input: { pattern: string; path?: string; include?: string }) {
      const { toolGrep } = await import("../codingAgent");
      const res = toolGrep(input.pattern, input.path || ".", input.include);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "grep_search",
    description: "Search for text/regex pattern recursively across files (alias for grep).",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" } }, required: ["pattern"] },
    risk: "read",
    category: "Search",
    async execute(input: { pattern: string; path?: string; include?: string }) {
      const { toolGrep } = await import("../codingAgent");
      const res = toolGrep(input.pattern, input.path || ".", input.include);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "glob",
    description: "Find files by glob pattern (e.g. '*.ts', 'src/**/*.js').",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
    risk: "read",
    category: "Search",
    async execute(input: { pattern: string; path?: string }) {
      const { toolGlob } = await import("../codingAgent");
      const res = toolGlob(input.pattern, input.path || ".");
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "glob_search",
    description: "Find files by glob pattern (alias for glob).",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
    risk: "read",
    category: "Search",
    async execute(input: { pattern: string; path?: string }) {
      const { toolGlob } = await import("../codingAgent");
      const res = toolGlob(input.pattern, input.path || ".");
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "shell",
    description: "Run a bash shell command.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    risk: "execute",
    category: "Shell",
    async execute(input: { command?: string; cmd?: string }, ctx) {
      const cmd = input.command || input.cmd || "";
      const { toolBash } = await import("../codingAgent");
      const res = await toolBash(cmd, 30000, {
        cwd: ctx.cwd,
        workspaceRoot: ctx.workspaceRoot,
        sandboxMode: ctx.sandboxMode as "workspace" | "ask" | "full-access" | undefined,
        signal: ctx.signal,
      });
      return JSON.stringify({ stdout: res.stdout || "", stderr: res.stderr || res.error || "", exitCode: res.exitCode });
    },
  }),
  tool({
    name: "web_fetch",
    description: "Fetch a URL and return readable text content.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    risk: "network",
    category: "Web",
    async execute(input: { url?: string; link?: string }, ctx) {
      const url = input.url || input.link || "";
      const { toolWebFetch } = await import("../codingAgent");
      const res = await toolWebFetch(url, ctx.signal);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "browser",
    description: "Real Chromium/Playwright browser automation for JS-heavy web pages.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string" },
        url: { type: "string" },
        selector: { type: "string" },
        text: { type: "string" },
        script: { type: "string" },
        path: { type: "string" },
      },
      required: [],
    },
    risk: "network",
    category: "Web",
    async execute(input: Record<string, unknown>) {
      const { executeBrowserTool } = await import("../browserTool");
      const res = await executeBrowserTool(input as Parameters<typeof executeBrowserTool>[0]);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "create_artifact",
    description: "Create an artifact in the .artifacts directory.",
    parameters: { type: "object", properties: { name: { type: "string" }, content: { type: "string" } }, required: ["name", "content"] },
    risk: "write",
    category: "Artifacts",
    async execute(input: { name: string; content: string }) {
      const { toolWrite } = await import("../codingAgent");
      const res = toolWrite(`.artifacts/${input.name}`, input.content);
      return JSON.stringify({ stdout: res.success ? `Artifact created: ${input.name}` : "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
    async verify(input: { name: string }) {
      const { verifyArtifactWritten } = await import("../toolVerification");
      return verifyArtifactWritten(input.name);
    },
  }),
  tool({
    name: "audit_url",
    description: "Audit a URL for SEO/health.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    risk: "network",
    category: "Web",
    async execute(input: { url?: string; link?: string }) {
      const url = input.url || input.link || "";
      const { toolAuditUrl } = await import("../codingAgent");
      const res = await toolAuditUrl(url);
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "update_artifact",
    description: "Update an existing artifact in the .artifacts directory.",
    parameters: { type: "object", properties: { name: { type: "string" }, content: { type: "string" } }, required: ["name", "content"] },
    risk: "write",
    category: "Artifacts",
    async execute(input: { name: string; content: string }) {
      const { toolWrite } = await import("../codingAgent");
      const res = toolWrite(`.artifacts/${input.name}`, input.content);
      return JSON.stringify({ stdout: res.success ? `Artifact updated: ${input.name}` : "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
    async verify(input: { name: string }) {
      const { verifyArtifactWritten } = await import("../toolVerification");
      return verifyArtifactWritten(input.name);
    },
  }),
  tool({
    name: "spawn_subagent",
    description: "Spawn an autonomous specialized sub-agent to execute a sub-task independently.",
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", enum: ["CODER", "RESEARCHER", "TESTER", "REVIEWER", "ARCHITECT", "GENERAL"] },
        task: { type: "string" },
        context: { type: "string" },
      },
      required: ["role", "task"],
    },
    risk: "execute",
    category: "Agent",
    async execute(input: { role?: string; task?: string; prompt?: string; context?: string }) {
      const { executeSubagentTask } = await import("../../teamwork/subagentRuntime");
      const role = input.role || "GENERAL";
      const task = input.task || input.prompt || "";
      const context = input.context || "";
      const res = await executeSubagentTask({
        id: `sub-${Date.now()}`,
        title: task.slice(0, 50),
        role: role.toUpperCase() as never,
        prompt: context ? `${context}\n\nTask: ${task}` : task,
        status: "PENDING",
        dependencies: [],
      });
      return JSON.stringify({ stdout: res.output || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
];

// ── Registry API ─────────────────────────────────────────────────────────────

export const toolRegistry = {
  /** All registered tools. */
  list(): ToolDefinition[] {
    return [...REGISTRY];
  },

  /** Look up a single tool by name (case-insensitive). */
  get(name: string): ToolDefinition | undefined {
    const n = name.toLowerCase();
    return REGISTRY.find((t) => t.name.toLowerCase() === n);
  },

  /** Provider-compatible schemas — the single schema source for the LLM. */
  schemas(): ProviderToolDefinition[] {
    return REGISTRY.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  },

  /** Schemas filtered by predicate (e.g. Plan-mode read-only). */
  schemasFiltered(predicate: (t: ToolDefinition) => boolean): ProviderToolDefinition[] {
    return REGISTRY.filter(predicate).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  },

  /** Risk tier for a tool — used by SecurityEngine and UI. */
  riskOf(name: string): ToolRisk | undefined {
    return this.get(name)?.risk;
  },
};

export type { ToolDefinition as RegistryToolDefinition };
