import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { SandboxMode, PermissionResult, PermissionCapability } from "./types";
import { isSensitiveFile } from "./secretGuard";

export interface PathCheckResult {
  isInside: boolean;
  resolvedPath: string;
  realWorkspaceRoot: string;
  relative: string;
  reason?: string;
}

/**
 * Validates that a parent directory exists, is canonicalized, and is within workspace.
 * This reduces TOCTOU by validating the parent before file operations.
 */
export function validateParentDirectory(
  targetPath: string,
  workspaceRoot?: string,
  cwd?: string
): PathCheckResult {
  const parentDir = path.dirname(targetPath);
  return isPathInsideWorkspace(parentDir, workspaceRoot, cwd);
}

/**
 * Checks for symlink race condition: verifies that the target's parent directory
 * is not a symlink pointing outside workspace, and the target itself (if exists)
 * is not a symlink escaping workspace.
 */
export function checkSymlinkEscape(
  targetPath: string,
  workspaceRoot?: string,
  cwd?: string
): { hasEscape: boolean; reason?: string } {
  const realRoot = getRealWorkspaceRoot(workspaceRoot);
  const baseCwd = cwd || process.cwd();
  
  // Expand and resolve target path
  let expanded = targetPath.trim();
  if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  } else if (expanded.startsWith("$HOME/") || expanded.startsWith("$HOME\\")) {
    expanded = path.join(os.homedir(), expanded.slice(5));
  }
  const absPath = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseCwd, expanded);
  
  // Check each parent directory component for symlinks
  let current = absPath;
  while (current && current !== path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        const realCurrent = fs.realpathSync(current);
        const rel = path.relative(realRoot, realCurrent);
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          return { hasEscape: true, reason: `Symlink escape detected: '${current}' -> '${realCurrent}' outside workspace` };
        }
      }
    } catch {}
    current = path.dirname(current);
    if (current === realRoot) break;
  }
  
  return { hasEscape: false };
}

/**
 * Returns canonical, symlink-resolved workspace root directory.
 */
export function getRealWorkspaceRoot(workspaceRoot?: string): string {
  const root = workspaceRoot || process.cwd();
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

/**
 * Canonicalizes a target path by expanding home directory,
 * resolving relative paths against cwd, and resolving symlinks.
 */
export function resolveRealPath(targetPath: string, cwd?: string): string {
  if (!targetPath) return cwd || process.cwd();

  const baseCwd = cwd || process.cwd();
  let expanded = targetPath.trim();

  // Expand ~ or ~/...
  if (expanded === "~" || expanded.startsWith("~/") || expanded.startsWith("~\\")) {
    expanded = path.join(os.homedir(), expanded.slice(1));
  } else if (expanded.startsWith("$HOME/") || expanded.startsWith("$HOME\\")) {
    expanded = path.join(os.homedir(), expanded.slice(5));
  }

  const absPath = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(baseCwd, expanded);

  try {
    return fs.realpathSync(absPath);
  } catch {
    // If target doesn't exist yet, resolve the closest existing parent directory
    let curr = absPath;
    const parts: string[] = [];

    while (curr && curr !== path.dirname(curr)) {
      parts.unshift(path.basename(curr));
      curr = path.dirname(curr);
      try {
        if (fs.existsSync(curr)) {
          const realParent = fs.realpathSync(curr);
          return path.join(realParent, ...parts);
        }
      } catch {}
    }

    return absPath;
  }
}

/**
 * Validates whether a target path is strictly contained within the active workspace root.
 * Protects against ../ traversal, symlink escapes, home expansion, and absolute path escaping.
 */
export function isPathInsideWorkspace(
  targetPath: string,
  workspaceRoot?: string,
  cwd?: string
): PathCheckResult {
  const realRoot = getRealWorkspaceRoot(workspaceRoot);
  const realTarget = resolveRealPath(targetPath, cwd);

  let rel = path.relative(realRoot, realTarget);
  let isInside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));

  // Check additional workspace roots if available in multi-root setups
  if (!isInside && !workspaceRoot) {
    try {
      const { getWorkspaceRoots } = require("../codingAgent");
      const roots: string[] = getWorkspaceRoots();
      for (const root of roots) {
        const rootReal = getRealWorkspaceRoot(root);
        const rootRel = path.relative(rootReal, realTarget);
        if (rootRel === "" || (!rootRel.startsWith("..") && !path.isAbsolute(rootRel))) {
          isInside = true;
          rel = rootRel;
          return {
            isInside: true,
            resolvedPath: realTarget,
            realWorkspaceRoot: rootReal,
            relative: rel,
          };
        }
      }
    } catch {}
  }

  return {
    isInside,
    resolvedPath: realTarget,
    realWorkspaceRoot: realRoot,
    relative: rel,
    reason: isInside ? undefined : `Path '${realTarget}' escapes workspace root '${realRoot}'`,
  };
}

/**
 * Universal Workspace Boundary Policy Evaluator.
 * Used uniformly across read, write, delete, rename, copy, and patch operations.
 */
export function evaluateWorkspacePolicy(
  targetPath: string,
  capability: PermissionCapability,
  mode: SandboxMode,
  workspaceRoot?: string,
  cwd?: string
): PermissionResult {
  if (mode === "full-access") {
    return { allowed: true, needsApproval: false, capability, riskLevel: "SAFE_READ" };
  }

  const check = isPathInsideWorkspace(targetPath, workspaceRoot, cwd);
  const isSecret = isSensitiveFile(check.resolvedPath);

  // 1. Guard Clause: Strict Workspace Boundary enforcement
  if (!check.isInside) {
    if (mode === "workspace") {
      return {
        allowed: false,
        needsApproval: false,
        capability,
        riskLevel: "CRITICAL_DENY",
        resolvedPath: check.resolvedPath,
        reason: `Workspace boundary violation: Access to '${check.resolvedPath}' outside workspace is strictly blocked in 'workspace' sandbox mode.`,
      };
    }

    if (mode === "ask") {
      return {
        allowed: true,
        needsApproval: true,
        capability,
        riskLevel: capability === "READ" ? "MODERATE_WRITE" : "DANGEROUS",
        resolvedPath: check.resolvedPath,
        reason: `Access to external path outside workspace '${check.resolvedPath}' requires user confirmation.`,
      };
    }
  }

  // 2. Guard Clause: Sensitive Secret Credentials protection
  if (isSecret.isSensitive) {
    if (mode === "workspace") {
      return {
        allowed: false,
        needsApproval: false,
        capability,
        riskLevel: "CRITICAL_DENY",
        resolvedPath: check.resolvedPath,
        reason: `Access to sensitive credential file blocked by workspace security: ${isSecret.reason}`,
      };
    }

    if (mode === "ask") {
      return {
        allowed: true,
        needsApproval: true,
        capability,
        riskLevel: "DANGEROUS",
        resolvedPath: check.resolvedPath,
        reason: `Warning: Operation targets sensitive credential file (${isSecret.reason})`,
      };
    }
  }

  // 3. Inside workspace and safe
  return {
    allowed: true,
    needsApproval: false,
    capability,
    riskLevel: capability === "READ" ? "SAFE_READ" : "MODERATE_WRITE",
    resolvedPath: check.resolvedPath,
  };
}
