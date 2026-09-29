import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";
import type { SandboxMode } from "./types";

function isSystemOrRootDirectory(dirPath: string): boolean {
  try {
    const norm = path.resolve(dirPath);
    if (norm === "/" || norm === "") return true;
    const sysRoots = ["/etc", "/sys", "/proc", "/usr", "/bin", "/sbin", "/boot", "/dev"];
    return sysRoots.some((sys) => norm === sys || norm.startsWith(sys + "/"));
  } catch {
    return false;
  }
}

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

/** Quotes a path as an s-expression string literal in a Seatbelt profile. */
function sexpString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Builds the macOS Seatbelt profile for a shell execution.
 *
 * Policy: deny-by-default, reads everywhere (binaries, frameworks and
 * stdlib live outside the workspace), writes ONLY inside the workspace and
 * the OS temp directory, network only when the caller allows it.
 */
function seatbeltProfile(options: { workspaceRoot: string; networkMode?: NetworkMode }): string {
  const writable = new Set<string>([path.resolve(options.workspaceRoot)]);
  for (const candidate of [options.workspaceRoot, os.tmpdir()]) {
    try {
      writable.add(fs.realpathSync(candidate));
    } catch {
      // Path may not exist yet — the resolved form above still covers it.
    }
  }

  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow file-read*)",
    ...[...writable].map((dir) => `(allow file-write* (subpath ${sexpString(dir)}))`),
    '(allow file-write* (literal "/dev/null"))',
    '(allow file-write* (literal "/dev/stdout"))',
    '(allow file-write* (literal "/dev/stderr"))',
  ];
  if (options.networkMode !== "denied") rules.push("(allow network*)");
  return rules.join("\n");
}

/**
 * Verifies that sandbox-exec can actually apply a profile on THIS host by
 * running a real write inside the sandbox. Presence of the binary is not
 * enough: on macOS releases where sandbox_apply is restricted the binary
 * exists but every call fails (exit 71), which would otherwise break every
 * workspace-mode shell command.
 */
function seatbeltIsOperational(): boolean {
  const probeRoot = (() => {
    try {
      if (fs.statSync(os.tmpdir()).isDirectory()) return os.tmpdir();
    } catch {}
    return "/tmp";
  })();
  const probeFile = path.join(probeRoot, `.toolnet-sandbox-probe-${process.pid}-${Date.now()}`);
  const profile = seatbeltProfile({ workspaceRoot: probeRoot, networkMode: "ask" });
  try {
    // Mirrors the real invocation shape (bash -c), so a profile that cannot
    // resolve/execute its shell or write inside the allowed roots fails here
    // instead of breaking every user command at runtime.
    const res = spawnSync(
      "/usr/bin/sandbox-exec",
      ["-p", profile, "bash", "-c", `printf ok > '${probeFile}'; exit 42`],
      { stdio: "ignore", timeout: 5000 },
    );
    return res.status === 42 && fs.existsSync(probeFile);
  } catch {
    return false;
  } finally {
    try {
      fs.rmSync(probeFile, { force: true });
    } catch {}
  }
}

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
    if (hasSeatbelt && seatbeltIsOperational()) {
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
    details: "No usable OS kernel isolation backend on this host. Relying on AST & WorkspacePolicy userspace guardrails.",
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
    if (isSystemOrRootDirectory(options.workspaceRoot)) {
      return {
        executable: "",
        args: [],
        isOsSandboxed: false,
        denied: true,
        reason: `Workspace root "${options.workspaceRoot}" is a system or root directory and cannot be mounted read-write in sandbox.`,
      };
    }

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
    if (isSystemOrRootDirectory(options.workspaceRoot)) {
      return {
        executable: "",
        args: [],
        isOsSandboxed: false,
        denied: true,
        reason: `Workspace root "${options.workspaceRoot}" is a system or root directory and cannot be mounted read-write in sandbox.`,
      };
    }

    const profile = seatbeltProfile({
      workspaceRoot: options.workspaceRoot,
      networkMode: options.networkMode,
    });

    return {
      executable: "/usr/bin/sandbox-exec",
      args: ["-p", profile, "bash", "-c", rawCommand],
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
