
import fs from "node:fs";
import path from "node:path";
import { getSandboxMode } from "../permissions";

export interface WorkspaceContext {
  root: string;
  cwd: string;
  gitRoot?: string;
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

export function resolveWorkspacePath(ws: WorkspaceContext, filePath: string): string {
  if (path.isAbsolute(filePath)) return path.normalize(filePath);
  return path.resolve(ws.cwd, filePath);
}

export function isInsideWorkspace(ws: WorkspaceContext, absPath: string): boolean {
  if (ws.sandboxMode === "full-access") return true;
  let realRoot = ws.root;
  let realTarget = absPath;
  try { realRoot = fs.realpathSync(ws.root); } catch {}
  try {
    realTarget = fs.realpathSync(absPath);
  } catch {
    try {
      realTarget = path.join(fs.realpathSync(path.dirname(absPath)), path.basename(absPath));
    } catch {}
  }
  const rel = path.relative(realRoot, realTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
