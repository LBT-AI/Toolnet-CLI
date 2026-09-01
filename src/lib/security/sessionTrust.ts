import type { TrustDuration, SandboxMode } from "./types";
import { canonicalizeJson } from "./auditLogger";

export class SessionTrustManager {
  private trustedActions = new Set<string>();
  private deniedActions = new Set<string>();

  /**
   * Generates a stable canonical key for an action or tool invocation.
   */
  generateKey(toolName: string, target?: string | Record<string, unknown>): string {
    let cleanTarget = "";
    if (typeof target === "string") {
      cleanTarget = target.trim().replace(/\s+/g, " ");
    } else if (target && typeof target === "object") {
      cleanTarget = canonicalizeJson(target);
    }
    return `${toolName}:${cleanTarget}`;
  }

  isTrustedForSession(toolName: string, target?: string | Record<string, unknown>, mode: SandboxMode = "workspace"): boolean {
    const key = this.generateKey(toolName, target);
    if (this.trustedActions.has(key)) return true;

    // Wildcard trust for tool is strictly forbidden for shell/command tools in workspace/ask mode
    const isShellTool = toolName === "shell" || toolName === "run_command" || toolName === "bash";
    if (isShellTool && mode !== "full-access") {
      return false;
    }

    if (this.trustedActions.has(`${toolName}:*`)) return true;

    return false;
  }

  isDeniedForSession(toolName: string, target?: string | Record<string, unknown>): boolean {
    const key = this.generateKey(toolName, target);
    return this.deniedActions.has(key) || this.deniedActions.has(`${toolName}:*`);
  }

  recordDecision(toolName: string, target: string | Record<string, unknown>, duration: TrustDuration | "ALWAYS") {
    const key = this.generateKey(toolName, target);

    if (duration === "SESSION" || (duration as any) === "ALWAYS") {
      this.trustedActions.add(key);
      this.deniedActions.delete(key);
    } else if (duration === "DENIED") {
      this.deniedActions.add(key);
      this.trustedActions.delete(key);
    }
  }

  trustEntireToolForSession(toolName: string, mode: SandboxMode = "workspace"): boolean {
    const isShellTool = toolName === "shell" || toolName === "run_command" || toolName === "bash";
    if (isShellTool && mode !== "full-access") {
      return false; // Whole-tool wildcard trust unavailable for shell outside full-access
    }
    this.trustedActions.add(`${toolName}:*`);
    return true;
  }

  listTrusted(): string[] {
    return Array.from(this.trustedActions);
  }

  clear() {
    this.trustedActions.clear();
    this.deniedActions.clear();
  }
}

export const sessionTrust = new SessionTrustManager();
