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
  // Persist to user config ONLY in real usage. Test runs (bun test sets
  // NODE_ENV=test) must never mutate the user's on-disk config — that caused
  // cross-run pollution where a test's "ask" mode leaked into the next run.
  if (process.env.NODE_ENV === "test") return;
  try {
    updateConfig({ sandboxMode: mode });
  } catch {}
}

// Path containment lives in the security kernel. Re-exported here (rather than
// re-implemented) so there is exactly ONE workspace-boundary rule: a second
// copy drifted and denied every relative path when the workspace root was
// reached through a symlink (e.g. macOS `/var` → `/private/var`).
export {
  getRealWorkspaceRoot,
  isPathInsideWorkspace,
  resolveRealPath,
} from "./security/workspacePolicy";

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
