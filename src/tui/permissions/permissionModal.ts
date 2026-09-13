import { tuiState } from "../state";
import { SessionTrustManager } from "../../lib/security/sessionTrust";
import { securityEngine } from "../../lib/security/securityEngine";
import { recordAlwaysTrust } from "../../lib/security/persistentTrust";
import { setCurrentSessionId as bindCurrentContextSession } from "../../lib/context";
import {
  PermissionInterruptManager,
  type PermissionChoice,
  type PermissionRequest,
} from "./interruptManager";
import type { ApprovalChoice } from "../types";

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
 * The ONE permission-approval queue for the TUI. Every approval-style dialog
 * (tool approval, plan confirmation) enqueues here so concurrent requests can
 * never overwrite the on-screen modal or leave an earlier requester awaiting
 * forever: the head is displayed, and the next request is promoted only after
 * the current one has been answered and dequeued.
 */
let interruptManager: PermissionInterruptManager | null = null;

export function getPermissionInterruptManager(): PermissionInterruptManager {
  if (!interruptManager) interruptManager = new PermissionInterruptManager();
  return interruptManager;
}

function mapChoice(choice: ApprovalChoice): PermissionChoice {
  return choice === "y" ? "yes" : choice === "n" ? "no" : "always";
}

/**
 * Record the trust consequence of a decision. Pure side-effect policy:
 * y records nothing, a/t persist session/always trust, n records a denial.
 */
function recordTrustFor(choice: ApprovalChoice, sessionId: string, toolName: string, targetKey: string): void {
  if (choice === "a") {
    // "A" = allow for session: record under (toolName, targetKey).
    new SessionTrustManager().recordDecision(sessionId, toolName, targetKey, "SESSION");
  } else if (choice === "t") {
    // "T" = always trust: persist the rule so future runs never ask
    // again, AND record session trust so the current session is covered.
    recordAlwaysTrust(toolName, targetKey);
    new SessionTrustManager().recordDecision(sessionId, toolName, targetKey, "ALWAYS");
  } else if (choice === "n") {
    // "N" = deny for session: later identical asks auto-deny.
    new SessionTrustManager().recordDecision(sessionId, toolName, targetKey, "DENIED");
  }
  // "y" (once) and Esc-recorded dismissal persist nothing here.
}

/**
 * Display the queue head as the active approval modal. The dialog resolves
 * exactly once: trust consequences are recorded at keypress, while dequeue +
 * promotion of the next queued request happen in the dialog's resolve
 * callback — the same point where the closing animation hands the modal back.
 */
function displayHead(): void {
  const manager = getPermissionInterruptManager();
  const head = manager.current();
  if (!head) {
    tuiState.pendingConfirmation = null;
    return;
  }

  let decided: ApprovalChoice | null = null; // trust recording happens at most once
  let replied = false; // dequeue + promotion happen at most once
  const finish = (mapped: PermissionChoice) => {
    if (replied) return;
    replied = true;
    void manager
      .replyCurrent(mapped)
      .then(() => {
        displayHead();
        tuiState.requestRender();
      })
      .catch(() => {
        displayHead();
        tuiState.requestRender();
      });
  };

  tuiState.pendingConfirmation = {
    prompt: head.reason,
    selectedIndex: 0,
    onDecision: (choice) => {
      if (decided) return;
      decided = choice;
      recordTrustFor(choice, tuiState.currentSessionId || "", head.tool, targetKeyOf(head));
    },
    resolve: (val) => {
      finish(decided === null ? (val ? "yes" : "no") : mapChoice(decided));
    },
  };
}

function targetKeyOf(request: PermissionRequest): string {
  return securityEngine.getSessionTrustTargetKey(request.tool, request.args);
}

/**
 * Interactive approval modal for ASK tools.
 *
 * Layer 4 semantics:
 *   Y    → allow ONCE. Nothing is persisted. Resolve(true), no trust record.
 *   A    → allow FOR SESSION. Records sessionTrust under
 *          (toolName, targetKey, "SESSION") using the canonical target key.
 *   T    → always trust. Persists the rule AND records session trust.
 *   N    → deny ONCE. Records "DENIED" so later identical asks in this session
 *          are auto-denied by SecurityEngine. Resolve(false).
 *   Esc  → deny WITHOUT recording (dismiss). Resolve(false).
 *
 * CRITICAL_DENY actions never reach this modal: the ToolGateway blocks them
 * before any approval flow begins, and userApproved cannot override them.
 *
 * Requests arriving while another dialog is on screen are queued FIFO and
 * shown in order; the returned promise settles when THIS request is answered.
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
    const request: PermissionRequest = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      tool: toolName,
      args,
      reason,
      resolve,
      reject: () => resolve(false),
    };
    getPermissionInterruptManager().enqueue(request);
    if (!tuiState.pendingConfirmation) displayHead();
    tuiState.requestRender();
  });
}

/**
 * Abort path for Ctrl+C while an approval dialog is on screen: deny the head
 * request (so the awaiting backend unwinds instead of hanging forever), close
 * the dialog, and promote the next queued request if any.
 */
export function cancelPendingApproval(): boolean {
  const manager = getPermissionInterruptManager();
  if (!tuiState.pendingConfirmation) return false;
  const cancelled = manager.cancelCurrent(new Error("permission dialog dismissed by abort"));
  if (cancelled) {
    tuiState.pendingConfirmation = null;
    displayHead();
    tuiState.requestRender();
  }
  return cancelled;
}

/**
 * Queue a plain yes/no confirmation (no trust recording) through the same
 * FIFO pipeline, e.g. the plan-approval handoff.
 */
export function requestConfirmation(prompt: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const request: PermissionRequest = {
      id: `confirm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      tool: "confirmation",
      args: {},
      reason: prompt,
      resolve,
      reject: () => resolve(false),
    };
    getPermissionInterruptManager().enqueue(request);
    if (!tuiState.pendingConfirmation) displayHead();
    tuiState.requestRender();
  });
}
