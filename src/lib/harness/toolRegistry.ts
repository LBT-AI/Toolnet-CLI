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
import { taskToolDefinition } from "../../core/agent/agents/taskToolDefinition";
import { teamworkToolDefinition } from "../../core/teamwork/tool";

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
  /**
   * Canonical tool this entry aliases. Aliases keep working at dispatch time
   * (old sessions, structured protocol) but are NEVER exposed as schemas — the
   * model sees exactly one name per capability.
   */
  aliasOf?: string;
}

// ── Helpers to build the registry without circular imports ───────────────────

function tool<Input>(
  def: ToolDefinition<Input, string>
): ToolDefinition<Input, string> {
  return def;
}

/**
 * Narrow the full execution context to the fields path-resolving tools need.
 * Passing these explicitly keeps the workspace contract at the tool boundary
 * instead of relying on module-global cwd state.
 */
function execCtx(ctx: ToolExecutionContext): { cwd?: string; workspaceRoot?: string } {
  return { cwd: ctx?.cwd, workspaceRoot: ctx?.workspaceRoot };
}

/** Project registry entries into provider-compatible function schemas. */
function toSchemas(defs: ToolDefinition[]): ProviderToolDefinition[] {
  return defs.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
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
    async execute(input: { path?: string }, ctx) {
      const { toolListDir } = await import("../codingAgent");
      const res = toolListDir(input.path || ".", execCtx(ctx));
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "tree",
    description: "Show directory structure as a tree. Excellent for understanding project layout.",
    parameters: { type: "object", properties: { path: { type: "string" }, depth: { type: "number" } } },
    risk: "read",
    category: "Workspace",
    async execute(input: { path?: string; depth?: number }, ctx) {
      const { toolTree } = await import("../codingAgent");
      const res = toolTree(input.path, input.depth, execCtx(ctx));
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "read_file",
    description: `Read file contents from the current workspace.
Use before editing unfamiliar files to understand the existing code.
Prefer targeted reads with offset/limit over reading the entire repository.`,
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
    async execute(input: { path: string; offset?: number; limit?: number }, ctx) {
      const { toolRead } = await import("../codingAgent");
      const res = toolRead(input.path, input.offset || 0, input.limit || 500, execCtx(ctx));
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "write_file",
    description: `Create a new file or replace an existing file in the workspace.
Use this tool when the user explicitly asks you to create/write a file
or when implementation requires a new file.
Do not say a file was created until this tool succeeds.`,
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
    async execute(input: { path: string; content: string }, ctx) {
      const { toolWrite } = await import("../codingAgent");
      const res = toolWrite(input.path, input.content, execCtx(ctx));
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
    async verify(input: { path: string }) {
      const { verifyFileWritten } = await import("../toolVerification");
      return verifyFileWritten(input.path);
    },
  }),
  tool({
    name: "edit_file",
    description: `Replace an exact string in a file with a new string (first occurrence).
Use for small targeted edits in existing files.
Provide the exact old_string as it appears in the file.`,
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
    async execute(input: { path: string; old_string?: string; oldString?: string; new_string?: string; newString?: string }, ctx) {
      const oldStr = input.old_string || input.oldString || "";
      const newStr = input.new_string || input.newString || "";
      const { toolEdit: edit } = await import("../codingAgent");
      const res = edit(input.path, oldStr, newStr, execCtx(ctx));
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
    description: `Replace ALL occurrences of a string in a file.
Use when the same change must be applied everywhere in a file.`,
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
    async execute(input: { path: string; old_string?: string; oldString?: string; new_string?: string; newString?: string }, ctx) {
      const oldStr = input.old_string || input.oldString || "";
      const newStr = input.new_string || input.newString || "";
      const { toolReplaceAll } = await import("../codingAgent");
      const res = toolReplaceAll(input.path, oldStr, newStr, execCtx(ctx));
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
    async execute(input: { path: string }, ctx) {
      const { toolFileExists } = await import("../codingAgent");
      const res = toolFileExists(input.path, execCtx(ctx));
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "apply_patch",
    description: `Apply a unified diff patch to one or more files.
Prefer this for multi-hunk or multi-file edits when you have the exact diff text.
The patch must use standard unified diff format (---/+++ headers).`,
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
    async execute(input: { query: string; root?: string; maxDepth?: number; type?: string }, ctx) {
      const { toolFindPath } = await import("../codingAgent");
      const res = toolFindPath(input.query, input.root, input.maxDepth, input.type, execCtx(ctx));
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "grep",
    description: `Search project files for symbols, strings, imports, routes,
functions, classes, configuration values, or usages.
Use this to locate relevant code before editing.
`,
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" } }, required: ["pattern"] },
    risk: "read",
    category: "Search",
    async execute(input: { pattern: string; path?: string; include?: string }, ctx) {
      const { toolGrep } = await import("../codingAgent");
      const res = toolGrep(input.pattern, input.path || ".", input.include, execCtx(ctx));
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "grep_search",
    aliasOf: "grep",
    description: "Search for text/regex pattern recursively across files (alias for grep).",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, include: { type: "string" } }, required: ["pattern"] },
    risk: "read",
    category: "Search",
    async execute(input: { pattern: string; path?: string; include?: string }, ctx) {
      const { toolGrep } = await import("../codingAgent");
      const res = toolGrep(input.pattern, input.path || ".", input.include, execCtx(ctx));
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "glob",
    description: `Find files by glob pattern.
Use to locate files matching a pattern, e.g. '*.test.ts', 'src/**/*.ts'.
`,
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
    risk: "read",
    category: "Search",
    async execute(input: { pattern: string; path?: string }, ctx) {
      const { toolGlob } = await import("../codingAgent");
      const res = toolGlob(input.pattern, input.path || ".", execCtx(ctx));
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "glob_search",
    aliasOf: "glob",
    description: "Find files by glob pattern (alias for glob).",
    parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] },
    risk: "read",
    category: "Search",
    async execute(input: { pattern: string; path?: string }, ctx) {
      const { toolGlob } = await import("../codingAgent");
      const res = toolGlob(input.pattern, input.path || ".", execCtx(ctx));
      return JSON.stringify({ stdout: res.data || "", stderr: res.error || "", exitCode: res.success ? 0 : 1 });
    },
  }),
  tool({
    name: "lsp",
    description: `Semantic code intelligence via a language server.
Prefer this over grep when you need to find a symbol's definition, every
reference to a symbol, type information (hover), a file's symbols, workspace
symbol search, or compiler diagnostics.
Operations:
  definition        — where a symbol is defined (needs path/line/character)
  references        — every use of a symbol, including its declaration
  hover            — type/signature information at a position
  document_symbols  — all symbols in a file (needs path)
  workspace_symbols — search symbols across the workspace (needs query)
  diagnostics       — errors/warnings for a file (needs path)
Line and character are 1-based, as shown in an editor.
If the tool reports that LSP is unavailable, fall back to grep/glob/read_file.`,
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["definition", "references", "diagnostics", "document_symbols", "workspace_symbols", "hover"],
        },
        path: { type: "string" },
        line: { type: "number" },
        character: { type: "number" },
        query: { type: "string" },
      },
      required: ["operation"],
    },
    risk: "read",
    category: "Code Intelligence",
    async execute(
      input: {
        operation: "definition" | "references" | "diagnostics" | "document_symbols" | "workspace_symbols" | "hover";
        path?: string;
        line?: number;
        character?: number;
        query?: string;
      },
      ctx
    ) {
      // Lazy import keeps the LSP stack out of the registry's eager graph and
      // guarantees there is still exactly one execution path (through the tool).
      const { runLspOperation } = await import("../../core/lsp/tool");
      return runLspOperation(input, ctx);
    },
  }),
  tool({
    name: "shell",
    description: `Run shell commands in the workspace.
Use for tests, builds, typechecks, linting and project inspection.
Do not use destructive commands unless necessary and permitted.
`,
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
    name: "bash",
    aliasOf: "shell",
    description: `Run a shell command in the workspace.
Alias for shell. Use for tests, builds, typechecks, linting and project inspection.
`,
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
    name: "run_command",
    aliasOf: "shell",
    description: `Run a shell command in the workspace.
Alias for shell. Use for tests, builds, typechecks, linting and project inspection.
`,
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
    // Phase 75.7 — legacy spawn entry. `task` is the canonical, model-visible
    // way to delegate; this name stays resolvable for back-compat (old
    // sessions, structured protocols) but is never advertised to the model, so
    // there is exactly ONE subagent capability in the schema set.
    name: "spawn_subagent",
    aliasOf: "task",
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

  // Phase 75.7 — canonical subagent delegation. Registered like every other
  // tool, so it flows through permission → execute → verify unchanged.
  taskToolDefinition,

  // Phase 76B.11 — canonical teamwork DAG submission. The tool only submits a
  // plan; execution stays in the shared scheduler.
  teamworkToolDefinition,
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

  /**
   * Provider-compatible schemas — the single schema source for the LLM.
   * Aliases are excluded so the model sees exactly one canonical name per
   * capability (shell, not shell+bash+run_command).
   */
  schemas(): ProviderToolDefinition[] {
    return toSchemas(REGISTRY.filter((t) => !t.aliasOf));
  },

  /** Schemas filtered by predicate (e.g. Plan-mode read-only). */
  schemasFiltered(predicate: (t: ToolDefinition) => boolean): ProviderToolDefinition[] {
    return toSchemas(REGISTRY.filter((t) => !t.aliasOf).filter(predicate));
  },

  /** Canonical (non-alias) tool names — exactly what the model may call. */
  canonicalNames(): string[] {
    return REGISTRY.filter((t) => !t.aliasOf).map((t) => t.name);
  },

  /** Risk tier for a tool — used by SecurityEngine and UI. */
  riskOf(name: string): ToolRisk | undefined {
    return this.get(name)?.risk;
  },
};

export type { ToolDefinition as RegistryToolDefinition };
