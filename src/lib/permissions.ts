import fs from "node:fs";
import path from "node:path";
import { getConfig, updateConfig } from "./config";
import { securityEngine } from "./security";
import type { SandboxMode, PermissionResult } from "./security/types";

export type { SandboxMode, PermissionResult };

let currentSandboxMode: SandboxMode | null = null;

export function getSandboxMode(): SandboxMode {
  if (process.env.TOOLNETAPI_SANDBOX_MODE) {
    const envMode = process.env.TOOLNETAPI_SANDBOX_MODE.toLowerCase();
    if (envMode === "workspace" || envMode === "ask" || envMode === "full-access") {
      return envMode as SandboxMode;
    }
  }
  if (currentSandboxMode) return currentSandboxMode;
  try {
    const cfg = getConfig();
    if (cfg.sandboxMode && ["workspace", "ask", "full-access"].includes(cfg.sandboxMode)) {
      currentSandboxMode = cfg.sandboxMode as SandboxMode;
      return currentSandboxMode;
    }
  } catch {}
  currentSandboxMode = "workspace";
  return "workspace";
}

export function setSandboxMode(mode: SandboxMode): void {
  currentSandboxMode = mode;
  securityEngine.setMode(mode);
  try {
    updateConfig({ sandboxMode: mode });
  } catch {}
}

export function getRealWorkspaceRoot(workspaceRoot?: string): string {
  const root = workspaceRoot || process.cwd();
  try {
    return fs.realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

export function resolveRealPath(targetPath: string, cwd?: string): string {
  const baseCwd = cwd || process.cwd();
  const absPath = path.isAbsolute(targetPath) ? path.normalize(targetPath) : path.resolve(baseCwd, targetPath);

  try {
    return fs.realpathSync(absPath);
  } catch {
    const parentDir = path.dirname(absPath);
    const fileName = path.basename(absPath);
    try {
      const realParent = fs.realpathSync(parentDir);
      return path.join(realParent, fileName);
    } catch {
      return absPath;
    }
  }
}

export function isPathInsideWorkspace(
  targetPath: string,
  workspaceRoot?: string,
  cwd?: string
): {
  isInside: boolean;
  resolvedPath: string;
  realWorkspaceRoot: string;
  relative: string;
} {
  const realRoot = getRealWorkspaceRoot(workspaceRoot);
  const realTarget = resolveRealPath(targetPath, cwd);

  let rel = path.relative(realRoot, realTarget);
  let isInside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));

  if (!isInside && !workspaceRoot) {
    try {
      const { getWorkspaceRoots } = require("./codingAgent");
      const roots: string[] = getWorkspaceRoots();
      for (const root of roots) {
        const rootReal = getRealWorkspaceRoot(root);
        const rootRel = path.relative(rootReal, realTarget);
        if (rootRel === "" || (!rootRel.startsWith("..") && !path.isAbsolute(rootRel))) {
          isInside = true;
          rel = rootRel;
          break;
        }
      }
    } catch {}
  }

  return {
    isInside,
    resolvedPath: realTarget,
    realWorkspaceRoot: realRoot,
    relative: rel,
  };
}

export function isDangerousShellCommand(
  command: string,
  cwd?: string,
  workspaceRoot?: string
): {
  isDangerous: boolean;
  reason?: string;
} {
  if (!command) return { isDangerous: false };
  const cmd = command.trim();

  const dangerousPatterns = [
    "rm -rf /",
    "rm -rf ~",
    "rm -rf *",
    "mkfs",
    "dd if=",
    ":(){ :|:& };:",
    "chmod -R 777",
    "chown -R root",
    "shutdown",
    "reboot",
    "curl | sh",
    "curl | bash",
    "wget | sh",
    "wget | bash",
    "| bash",
    "| sh",
  ];
  for (const pattern of dangerousPatterns) {
    if (cmd.includes(pattern)) {
      return { isDangerous: true, reason: `Command contains dangerous pattern: "${pattern}"` };
    }
  }

  if (/\bsudo\b/.test(cmd) || /\bsu\b/.test(cmd)) {
    return { isDangerous: true, reason: "Command uses privileged execution (sudo/su)" };
  }

  if (/\brm\s+-[rR]/.test(cmd) || /\brmdir\b/.test(cmd)) {
    return { isDangerous: true, reason: "Command contains recursive file/directory removal" };
  }

  const sysDirs = ["/etc", "/var", "/usr", "/bin", "/sbin", "/root", "/proc", "/sys", "/dev"];
  for (const sysDir of sysDirs) {
    if (cmd.includes(sysDir)) {
      return { isDangerous: true, reason: `Command targets system directory (${sysDir})` };
    }
  }

  if (/\.\.\//.test(cmd)) {
    return { isDangerous: true, reason: "Command references parent directory path (../)" };
  }

  return { isDangerous: false };
}

export function evaluatePermission(
  toolName: string,
  args: any,
  mode: SandboxMode = getSandboxMode(),
  cwd?: string,
  workspaceRoot?: string
): PermissionResult {
  return securityEngine.evaluate(toolName, args, mode, cwd, workspaceRoot);
}

export * from "./security";
