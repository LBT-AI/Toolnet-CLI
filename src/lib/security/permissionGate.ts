import type { SandboxMode, PermissionResult, PermissionCapability, ActionCategory } from "./types";
import { securityEngine } from "./securityEngine";
import { auditLogger } from "./auditLogger";
import { detectSandboxCapability, type NetworkMode } from "./sandboxExecutor";

export interface PermissionGateOptions {
  cwd?: string;
  workspaceRoot?: string;
  mode?: SandboxMode;
  networkMode?: NetworkMode;
  isHeadless?: boolean;
}

/**
 * High-Level Permission Gate for all tool calls and agent actions.
 * Enforces Fail-Closed security in headless environments and coordinates
 * policy decisions across WorkspacePolicy, ShellParser, and OS Sandboxes.
 */
export class PermissionGate {
  private networkMode: NetworkMode = "ask";

  setNetworkMode(mode: NetworkMode) {
    this.networkMode = mode;
  }

  getNetworkMode(): NetworkMode {
    return this.networkMode;
  }

  /**
   * Main gate check before executing any tool or command.
   */
  evaluate(
    toolName: string,
    args: any,
    options: PermissionGateOptions = {}
  ): PermissionResult {
    const sandboxMode = options.mode || securityEngine.getMode();
    const isHeadless =
      options.isHeadless !== undefined
        ? options.isHeadless
        : Boolean(process.env.TOOLNET_HEADLESS || !process.stdin.isTTY);

    const result = securityEngine.evaluate(
      toolName,
      args,
      sandboxMode,
      options.cwd,
      options.workspaceRoot
    );

    // 1. Fail-Closed in Headless / Non-interactive environments
    if (result.needsApproval && isHeadless) {
      auditLogger.logEvent({
        timestamp: Date.now(),
        toolName,
        args,
        riskLevel: result.riskLevel || "DANGEROUS",
        category: result.category,
        capability: result.capability,
        mode: sandboxMode,
        decision: "BLOCKED_BY_POLICY",
        reason: "Approval required but running in headless / non-interactive mode (Fail-Closed).",
      });

      return {
        allowed: false,
        needsApproval: false,
        capability: result.capability,
        riskLevel: result.riskLevel,
        reason: `Action requires user approval, but CLI is executing in headless/non-interactive mode (${result.reason || "unauthorized action"}). Permission denied (Fail-Closed).`,
      };
    }

    // 2. Network Capability policy check
    if (result.capability === "NETWORK") {
      const netMode = options.networkMode || this.networkMode;
      if (netMode === "denied") {
        return {
          allowed: false,
          needsApproval: false,
          capability: "NETWORK",
          riskLevel: "CRITICAL_DENY",
          reason: "Network access is disabled by security policy (networkMode: denied).",
        };
      }
      if (netMode === "ask" && sandboxMode === "workspace") {
        if (isHeadless) {
          return {
            allowed: false,
            needsApproval: false,
            capability: "NETWORK",
            reason: "Network access requires approval but running in headless mode.",
          };
        }
        return {
          allowed: true,
          needsApproval: true,
          capability: "NETWORK",
          riskLevel: "MODERATE_WRITE",
          reason: `Tool '${toolName}' initiates external network communication.`,
        };
      }
    }

    return result;
  }
}

export const permissionGate = new PermissionGate();
