import fs from "node:fs";
import { execSync } from "node:child_process";
import type { SandboxMode } from "./types";

export type SandboxBackend = "bwrap" | "seatbelt" | "direct";
export type NetworkMode = "allowed" | "ask" | "denied";

export interface SandboxCapability {
  available: boolean;
  backend: SandboxBackend;
  label: string;
  details: string;
}

export interface SandboxExecOptions {
  workspaceRoot: string;
  cwd?: string;
  sandboxMode: SandboxMode;
  networkMode?: NetworkMode;
  toolName?: string;
  isMutation?: boolean;
}

let cachedCapability: SandboxCapability | null = null;

/**
 * Probes the operating system for OS-level kernel isolation backends (e.g. Bubblewrap bwrap).
 */
export function detectSandboxCapability(): SandboxCapability {
  if (cachedCapability) return cachedCapability;

  const isLinux = process.platform === "linux";
  const isDarwin = process.platform === "darwin";

  if (isLinux) {
    let hasBwrap = false;
    try {
      execSync("which bwrap", { stdio: "ignore" });
      hasBwrap = true;
    } catch {
      hasBwrap = fs.existsSync("/usr/bin/bwrap") || fs.existsSync("/usr/local/bin/bwrap");
    }

    if (hasBwrap) {
      cachedCapability = {
        available: true,
        backend: "bwrap",
        label: "bwrap ✓",
        details: "Linux Bubblewrap kernel namespace sandbox active (Root read-only, Workspace read-write)",
      };
      return cachedCapability;
    }
  }

  if (isDarwin) {
    const hasSeatbelt = fs.existsSync("/usr/bin/sandbox-exec");
    if (hasSeatbelt) {
      cachedCapability = {
        available: true,
        backend: "seatbelt",
        label: "seatbelt ✓",
        details: "macOS sandbox-exec Seatbelt profile isolation active",
      };
      return cachedCapability;
    }
  }

  cachedCapability = {
    available: false,
    backend: "direct",
    label: "OS isolation unavailable",
    details: "OS kernel isolation binary not found on host. Relying on AST & WorkspacePolicy userspace guardrails.",
  };
  return cachedCapability;
}

/**
 * Determines if a tool/command requires OS sandbox isolation.
 * Mutation tools (write, delete, shell with dangerous commands) always require sandbox.
 */
export function requiresOsSandbox(toolName: string, isMutation?: boolean): boolean {
  if (isMutation === false) return false;
  if (isMutation === true) return true;
  const mutationTools = new Set([
    "shell", "run_command", "bash",
    "write_file", "edit_file", "replace_all", "apply_patch",
    "delete_file", "create_artifact", "update_artifact",
  ]);
  return mutationTools.has(toolName);
}

/**
 * Builds the sandboxed execution command line array or wrapped string.
 */
export function buildSandboxedCommandLine(
  rawCommand: string,
  options: SandboxExecOptions
): { executable: string; args: string[]; isOsSandboxed: boolean; denied?: boolean; reason?: string } {
  const cap = detectSandboxCapability();
  const { toolName, isMutation, sandboxMode } = options;

  // If in full-access mode, execute directly without wrapper
  if (sandboxMode === "full-access") {
    return {
      executable: "bash",
      args: ["-c", rawCommand],
      isOsSandboxed: false,
    };
  }

  const needsOsSandbox = requiresOsSandbox(toolName || "", isMutation);

  // Linux Bubblewrap Sandbox
  if (cap.backend === "bwrap" && (sandboxMode === "workspace" || sandboxMode === "ask")) {
    const bwrapArgs = [
      "--ro-bind", "/", "/",
      "--bind", options.workspaceRoot, options.workspaceRoot,
      "--bind", "/tmp", "/tmp",
      "--dev", "/dev",
      "--proc", "/proc",
      "--die-with-parent",
    ];

    if (options.networkMode === "denied") {
      bwrapArgs.push("--unshare-net");
    }

    if (options.cwd) {
      bwrapArgs.push("--chdir", options.cwd);
    }

    bwrapArgs.push("--", "bash", "-c", rawCommand);

    return {
      executable: "bwrap",
      args: bwrapArgs,
      isOsSandboxed: true,
    };
  }

  // macOS Seatbelt Sandbox
  if (cap.backend === "seatbelt" && (sandboxMode === "workspace" || sandboxMode === "ask")) {
    // Basic seatbelt profile - can be extended
    const profile = `
(version 1)
(deny default)
(allow file-read* (literal "/"))
(allow file-write* (subpath "${options.workspaceRoot}"))
(allow network* (literal "${options.networkMode === "denied" ? "" : "auto"}"))
`;
    return {
      executable: "sandbox-exec",
      args: ["-p", profile, "--", "bash", "-c", rawCommand],
      isOsSandboxed: true,
    };
  }

  // Fallback: Direct execution with userspace policy gates.
  // PermissionGate / SecurityEngine already evaluated the command before
  // reaching this point, so we fall back to direct execution when the OS
  // sandbox backend is unavailable.
  return {
    executable: "bash",
    args: ["-c", rawCommand],
    isOsSandboxed: false,
  };
}

/**
 * Formats a human-readable summary badge of the active sandbox and OS isolation status.
 */
export function getSandboxStatusBadge(
  mode: SandboxMode,
  networkMode: NetworkMode = "ask"
): { badge: string; isOsIsolated: boolean; backend: SandboxBackend; label: string } {
  const cap = detectSandboxCapability();

  if (mode === "full-access") {
    return {
      badge: "Sandbox: Full Access (Bypass)",
      isOsIsolated: false,
      backend: "direct",
      label: "full-access",
    };
  }

  if (mode === "ask") {
    return {
      badge: `Sandbox: Ask (Interactive) · ${cap.label}`,
      isOsIsolated: cap.available,
      backend: cap.backend,
      label: "ask",
    };
  }

  // Workspace mode
  return {
    badge: `Sandbox: Workspace · ${cap.label}`,
    isOsIsolated: cap.available,
    backend: cap.backend,
    label: "workspace",
  };
}
