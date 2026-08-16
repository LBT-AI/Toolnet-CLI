import type { TrustDuration } from "./types";

export class SessionTrustManager {
  private trustedActions = new Set<string>();
  private deniedActions = new Set<string>();

  /**
   * Generates a stable key for an action or tool invocation.
   */
  generateKey(toolName: string, target?: string): string {
    const cleanTarget = (target || "").trim().replace(/\s+/g, " ");
    return `${toolName}:${cleanTarget}`;
  }

  isTrustedForSession(toolName: string, target?: string): boolean {
    const key = this.generateKey(toolName, target);
    if (this.trustedActions.has(key)) return true;

    // Check wildcard trust for tool (e.g. "shell:*")
    if (this.trustedActions.has(`${toolName}:*`)) return true;

    return false;
  }

  isDeniedForSession(toolName: string, target?: string): boolean {
    const key = this.generateKey(toolName, target);
    return this.deniedActions.has(key) || this.deniedActions.has(`${toolName}:*`);
  }

  recordDecision(toolName: string, target: string, duration: TrustDuration) {
    const key = this.generateKey(toolName, target);

    if (duration === "SESSION" || duration === "ALWAYS") {
      this.trustedActions.add(key);
      this.deniedActions.delete(key);
    } else if (duration === "DENIED") {
      this.deniedActions.add(key);
      this.trustedActions.delete(key);
    }
  }

  trustEntireToolForSession(toolName: string) {
    this.trustedActions.add(`${toolName}:*`);
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
