/**
 * Dynamic permission-context prompt generator.
 *
 * Builds an accurate description of the ACTIVE runtime permission policy so the
 * model's system prompt always reflects the real SecurityEngine sandbox mode.
 * This replaces any hardcoded claim that grants broader permissions than the
 * policy actually allows (e.g. "and system").
 */

import type { SandboxMode } from "./types";
import { detectSandboxCapability } from "./sandboxExecutor";
import { policyEngine } from "./policyEngine";

export interface PermissionContext {
  mode: SandboxMode;
  lines: string[];
}

function describeMode(mode: SandboxMode): string {
  switch (mode) {
    case "workspace":
      return "Workspace";
    case "ask":
      return "Ask";
    case "full-access":
      return "Full Access";
    default:
      return "Workspace";
  }
}

/**
 * Produces a human-readable list of permission facts for the given sandbox mode.
 * Each fact is derived from the actual policy engine, never hardcoded broader
 * than reality.
 */
export function buildPermissionContext(mode: SandboxMode = "workspace"): PermissionContext {
  const networkCap = policyEngine.isCapabilityAllowed("NETWORK");
  const execCap = policyEngine.isCapabilityAllowed("EXECUTE");
  const { backend } = detectSandboxCapability();

  const lines: string[] = [];

  if (mode === "full-access") {
    lines.push("Sandbox: Full Access");
    lines.push("Filesystem:");
    lines.push("- Read: unrestricted");
    lines.push("- Write: unrestricted");
    lines.push("- Execute: unrestricted");
    lines.push("- Outside workspace: allowed");
    lines.push(`Network: ${networkCap ? "allowed" : "denied"}`);
    lines.push(`OS isolation: ${backend}`);
    return { mode, lines };
  }

  lines.push(`Sandbox: ${describeMode(mode)}`);

  // Filesystem
  lines.push("Filesystem:");
  if (mode === "workspace") {
    lines.push("- Read: workspace");
    lines.push("- Write: workspace only");
    lines.push(`- Execute: ${execCap ? "sandboxed" : "denied by policy"}`);
    lines.push("- Outside workspace: denied");
  } else {
    // ask mode
    lines.push("- Read: workspace, plus paths approved by user");
    lines.push("- Write: workspace, plus paths approved by user");
    lines.push(`- Execute: ${execCap ? "sandboxed / policy-gated" : "denied by policy"}`);
    lines.push("- Outside workspace: requires user approval");
  }

  // Network
  lines.push(`Network: ${networkCap ? "ask" : "denied"}`);

  // OS isolation
  lines.push(`OS isolation: ${backend}`);

  return { mode, lines };
}

/**
 * Returns the permission-context block to embed into a system prompt.
 */
export function getPermissionContextPrompt(mode: SandboxMode = "workspace"): string {
  const { lines } = buildPermissionContext(mode);
  return [`[RUNTIME PERMISSION CONTEXT]`, ...lines].join("\n");
}

/**
 * Ensures child subagent sandbox policy is always <= parent policy.
 * A child can never be granted broader permissions than its parent,
 * but may self-impose a more restrictive (lower-privilege) mode.
 */
export function clampSandboxMode(requested: SandboxMode | undefined, parent: SandboxMode): SandboxMode {
  const rank: Record<SandboxMode, number> = {
    "workspace": 1,
    "ask": 2,
    "full-access": 3,
  };
  if (!requested) return parent;
  const parentRank = rank[parent] ?? 1;
  const requestedRank = rank[requested] ?? 1;
  if (requestedRank > parentRank) {
    return parent;
  }
  return requested;
}
