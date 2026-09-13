/**
 * Workspace identity.
 *
 * A session is bound to a project, not to a path string. Resume therefore
 * classifies the relationship between the recorded workspace and the current
 * one instead of trusting an equality check — copying a checkout to a new
 * directory must be recognized as *moved*, and opening a session from a
 * different repository must be recognized as *mismatch* and refused.
 *
 * The identity key prefers git provenance (remote + path inside the repo) so a
 * move is detectable, and falls back to a project marker, then to the directory
 * name for plain folders.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkspaceContext } from "../../lib/harness/workspace";
import type { WorkspaceIdentity, WorkspaceMatch } from "./types";

function readGitOrigin(gitRoot: string): string | null {
  try {
    const dotGit = path.join(gitRoot, ".git");
    let configPath = path.join(dotGit, "config");
    // Worktrees and submodules store `.git` as a pointer file.
    if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
      const pointer = fs.readFileSync(dotGit, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (match) configPath = path.join(match[1].trim(), "config");
    }
    if (!fs.existsSync(configPath)) return null;
    const config = fs.readFileSync(configPath, "utf8");
    const origin = /\[remote "origin"\][^[]*?url\s*=\s*(.+)/s.exec(config);
    if (origin) return origin[1].trim().split("\n")[0] || null;
    return null;
  } catch {
    return null;
  }
}

function readPackageName(root: string): string | null {
  try {
    const pkgPath = path.join(root, "package.json");
    if (!fs.existsSync(pkgPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const name = parsed?.name;
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

function relativeSuffix(root: string, cwd: string): string {
  const rel = path.relative(root, cwd);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return "";
  return rel.split(path.sep).join("/");
}

/** Build the stable key that answers "is this the same project?". */
export function workspaceKeyFor(root: string, gitRoot: string | undefined, cwd: string): string {
  const suffix = relativeSuffix(gitRoot ?? root, cwd);
  if (gitRoot) {
    const origin = readGitOrigin(gitRoot);
    if (origin) return `git:${origin}#${suffix}`;
    return `git:${path.basename(gitRoot)}#${suffix}`;
  }
  const pkg = readPackageName(root);
  if (pkg) return `pkg:${pkg}#${suffix}`;
  return `path:${path.basename(root)}`;
}

export function normalizeWorkspaceIdentity(cwd: string = process.cwd()): WorkspaceIdentity {
  const resolved = path.resolve(cwd);
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    /* a workspace that does not exist yet keeps its logical path */
  }
  let root = real;
  let gitRoot: string | undefined;
  try {
    const ctx = createWorkspaceContext({ root: real, cwd: real });
    root = ctx.root;
    gitRoot = ctx.gitRoot;
  } catch {
    /* fall back to the resolved directory */
  }
  return {
    path: real,
    root,
    ...(gitRoot ? { gitRoot } : {}),
    key: workspaceKeyFor(root, gitRoot, real),
  };
}

/**
 * Relationship between a recorded workspace and the current directory.
 *
 * Order matters: a different project key is always a mismatch, because that is
 * the case that must never silently proceed. Only then can a same-key workspace
 * be reported missing or moved.
 */
export function classifyWorkspace(
  stored: WorkspaceIdentity | undefined,
  current: WorkspaceIdentity,
): WorkspaceMatch {
  if (!stored || !stored.key) return "mismatch";
  if (stored.key !== current.key) return "mismatch";
  if (!fs.existsSync(stored.path)) return "missing";
  if (path.resolve(stored.path) === path.resolve(current.path)) return "same";
  return "moved";
}

export function workspaceLabel(identity: WorkspaceIdentity): string {
  return identity.gitRoot ?? identity.root ?? identity.path;
}

export function hostname(): string {
  try {
    return os.hostname();
  } catch {
    return "unknown";
  }
}
