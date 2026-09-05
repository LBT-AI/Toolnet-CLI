import { tuiState } from "../state";
import { SessionTrustManager } from "../../lib/security/sessionTrust";
import { securityEngine } from "../../lib/security/securityEngine";
import { setCurrentSessionId as bindCurrentContextSession } from "../../lib/context";

export interface ApprovalModalRequest {
  toolName: string;
  args: any;
  /**
   * Canonical target key — MUST come from securityEngine.getSessionTrustTargetKey()
   * so that recordDecision(toolName, targetKey, "SESSION") matches the exact key
   * SecurityEngine later looks up via isTrustedForSession(toolName, targetKey, mode).
   * When omitted it is derived through the same engine helper (never guessed here).
   */
  targetKey?: string;
  reason?: string;
}

/**
 * Interactive approval modal for ASK tools.
 *
 * Layer 4 Phase 1 semantics:
 *   Y    → allow ONCE. Nothing is persisted. Resolve(true), no trust record.
 *   A    → allow FOR SESSION. Records sessionTrust under
 *          (toolName, targetKey, "SESSION") using the canonical target key.
 *   N    → deny ONCE. Records "DENIED" so later identical asks in this session
 *          are auto-denied by SecurityEngine. Resolve(false).
 *   Esc  → deny WITHOUT recording (dismiss). Resolve(false).
 *
 * CRITICAL_DENY actions never reach this modal: the ToolGateway blocks them
 * before any approval flow begins, and userApproved cannot override them.
 */
export async function requestApprovalModal(
  requestOrReason: ApprovalModalRequest | string,
  legacyArgs?: any
): Promise<boolean> {
  // Backward-compatible positional signature: (reason, args)
  const req: ApprovalModalRequest =
    typeof requestOrReason === "string"
      ? { toolName: "shell", args: legacyArgs ?? {}, reason: requestOrReason }
      : requestOrReason;

  const { toolName, args } = req;
  // Canonical target key via the SAME helper SecurityEngine uses for lookup.
  const targetKey = req.targetKey ?? securityEngine.getSessionTrustTargetKey(toolName, args);
  const reason = req.reason || `Tool ${toolName} requires permission`;

  const sessionId = tuiState.currentSessionId || "";
  // Keep the deprecated test/migration singleton aligned with the explicit
  // TUI session at this compatibility boundary. Gateway production paths use
  // the explicit context.sessionId directly and do not depend on this hook.
  if (sessionId) bindCurrentContextSession(sessionId);
  return new Promise<boolean>((resolve) => {
    tuiState.pendingConfirmation = {
      prompt: reason,
      onDecision: (choice) => {
        if (choice === "a") {
          // "A" = allow for session: record under (toolName, targetKey).
          new SessionTrustManager().recordDecision(sessionId, toolName, targetKey, "SESSION");
        } else if (choice === "n") {
          // "N" = deny for session: later identical asks auto-deny.
          new SessionTrustManager().recordDecision(sessionId, toolName, targetKey, "DENIED");
        }
        // "y" (once) and Esc-recorded "n"-via-inputHandler path persist nothing here;
        // Esc carries no onDecision call from the input handler — dismiss only.
      },
      resolve,
    };
    tuiState.requestRender();
  });
}
