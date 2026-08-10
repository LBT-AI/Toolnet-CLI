import fs from "node:fs";
import path from "node:path";
import { getConfig, updateConfig } from "./config";

export type SandboxMode = "workspace" | "ask" | "full-access";

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
  currentSandboxMode = "ask";
  return "ask";
}

export function setSandboxMode(mode: SandboxMode): void {
  currentSandboxMode = mode;
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

export function isPathInsideWorkspace(targetPath: string, workspaceRoot?: string, cwd?: string): {
  isInside: boolean;
  resolvedPath: string;
  realWorkspaceRoot: string;
  relative: string;
} {
  const realRoot = getRealWorkspaceRoot(workspaceRoot);
  const realTarget = resolveRealPath(targetPath, cwd);
  
  const rel = path.relative(realRoot, realTarget);
  const isInside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  
  return {
    isInside,
    resolvedPath: realTarget,
    realWorkspaceRoot: realRoot,
    relative: rel,
  };
}

export function isDangerousShellCommand(command: string, cwd?: string, workspaceRoot?: string): {
  isDangerous: boolean;
  reason?: string;
} {
  if (!command) return { isDangerous: false };
  const cmd = command.trim();

  const dangerousPatterns = [
    "rm -rf /", "rm -rf ~", "rm -rf *",
    "mkfs", "dd if=", ":(){ :|:& };:",
    "chmod -R 777", "chown -R root",
    "shutdown", "reboot",
    "curl | sh", "curl | bash", "wget | sh", "wget | bash",
    "| bash", "| sh"
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

export interface PermissionResult {
  allowed: boolean;
  needsApproval: boolean;
  reason?: string;
  resolvedPath?: string;
}

export function evaluatePermission(
  toolName: string,
  args: any,
  mode: SandboxMode = getSandboxMode(),
  cwd?: string,
  workspaceRoot?: string
): PermissionResult {
  if (mode === "full-access") {
    return { allowed: true, needsApproval: false };
  }

  const isShell = toolName === "run_command" || toolName === "shell";
  const isWebTool = ["web_fetch", "browser", "browser_action", "audit_url"].includes(toolName);
  const isFileTool = [
    "read_file", "write_file", "edit_file", "replace_all", "file_exists",
    "list_dir", "tree", "grep", "glob", "find_path", "create_artifact", "update_artifact",
    "apply_patch", "git_status", "git_diff"
  ].includes(toolName);

  if (isWebTool) {
    const action = args?.action || "fetch";
    const url = args?.url || args?.link || "";
    if (mode === "ask" && (action === "click" || action === "fill" || action === "evaluate")) {
      return { allowed: true, needsApproval: true, reason: `Browser action '${action}' requires user approval` };
    }
    return { allowed: true, needsApproval: false };
  }

  if (isShell) {
    const command = args?.command || args?.cmd || "";
    const shellCheck = isDangerousShellCommand(command, cwd, workspaceRoot);

    if (mode === "workspace") {
      if (shellCheck.isDangerous) {
        return { allowed: false, needsApproval: false, reason: `Blocked in 'workspace' sandbox mode: ${shellCheck.reason}` };
      }
      return { allowed: true, needsApproval: false };
    }

    if (mode === "ask") {
      if (shellCheck.isDangerous) {
        return { allowed: true, needsApproval: true, reason: shellCheck.reason };
      }
      return { allowed: true, needsApproval: false };
    }
  }

  if (isFileTool) {
    const targetPath = toolName.includes("artifact")
      ? `.artifacts/${args?.name || ""}`
      : (args?.path || args?.root || args?.query || ".");

    if (toolName === "grep" || toolName === "glob" || toolName === "find_path") {
      const searchRoot = args?.path || args?.root || ".";
      const pathCheck = isPathInsideWorkspace(searchRoot, workspaceRoot, cwd);

      if (!pathCheck.isInside) {
        if (mode === "workspace") {
          return { allowed: false, needsApproval: false, reason: `Path traversal blocked: "${searchRoot}" is outside workspace.` };
        }
        if (mode === "ask") {
          return { allowed: true, needsApproval: true, reason: `Tool "${toolName}" accesses path outside workspace: "${pathCheck.resolvedPath}"` };
        }
      }
      return { allowed: true, needsApproval: false };
    }

    const pathCheck = isPathInsideWorkspace(targetPath, workspaceRoot, cwd);
    if (!pathCheck.isInside) {
      if (mode === "workspace") {
        return { allowed: false, needsApproval: false, reason: `Path traversal blocked: "${targetPath}" resolves outside workspace.` };
      }
      if (mode === "ask") {
        return { allowed: true, needsApproval: true, reason: `Tool "${toolName}" accesses path outside workspace: "${pathCheck.resolvedPath}"` };
      }
    }
    return { allowed: true, needsApproval: false };
  }

  return { allowed: true, needsApproval: false };
}
