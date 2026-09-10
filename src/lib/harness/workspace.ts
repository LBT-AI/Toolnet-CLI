/**
 * Workspace Context — §8  The agent's view of where it may operate.
 *
 * Every filesystem or shell operation must be resolved against this context.
 * The TUI, harness, and subagents each carry an explicit WorkspaceContext —
 * no implicit `process.cwd()` drift.
 */

import fs from "node:fs";
import path from "node:path";
import { getSandboxMode } from "../permissions";

export interface WorkspaceContext {
  /** Workspace root — all relative paths are resolved here first. */
  root: string;
  /** Current working directory (always inside root unless sandbox is full-access). */
  cwd: string;
  /** Git repo root if detected. */
  gitRoot?: string;
  /** Whether the workspace is trusted (affects sandbox sensitivity). */
  trusted: boolean;
  sandboxMode: "workspace" | "ask" | "full-access";
}

function detectGitRoot(start: string): string | undefined {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 12; depth++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function createWorkspaceContext(opts: {
  root?: string;
  cwd?: string;
  trusted?: boolean;
  sandboxMode?: WorkspaceContext["sandboxMode"];
} = {}): WorkspaceContext {
  const root = path.resolve(opts.root ?? process.cwd());
  const cwd = path.resolve(opts.cwd ?? root);
  return {
    root,
    cwd,
    gitRoot: detectGitRoot(cwd),
    trusted: opts.trusted ?? false,
    sandboxMode: opts.sandboxMode ?? getSandboxMode(),
  };
}

/**
 * Resolve a user-supplied path against the workspace.
 * Returns the absolute, normalized path. Does NOT check existence.
 * Caller must pass the result through SecurityEngine before acting.
 */
export function resolveWorkspacePath(ws: WorkspaceContext, filePath: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.resolve(ws.cwd, filePath);
}

/**
 * Guard: is an absolute path inside the workspace boundary?
 * Mirrors the check in SecurityEngine but without the policy layer — used
 * for early UI feedback and for the workspace-aware nudge.
 */
export function isInsideWorkspace(ws: WorkspaceContext, absPath: string): boolean {
  if (ws.sandboxMode === "full-access") return true;
  let realRoot = ws.root;
  let realTarget = absPath;
  try { realRoot = fs.realpathSync(ws.root); } catch {}
  try { realTarget = fs.realpathSync(absPath); } catch {
    // Target may not exist yet — resolve its parent
    try { realTarget = path.join(fs.realpathSync(path.dirname(absPath)), path.basename(absPath)); } catch {}
  }
  const rel = path.relative(realRoot, realTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
