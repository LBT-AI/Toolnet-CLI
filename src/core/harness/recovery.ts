/**
 * Phase 5 — Structured error-driven recovery policy.
 *
 * The agent must recover from tool failures using the MACHINE-READABLE
 * `StructuredToolError.code` (Phase 1.4 contract), never by guessing from
 * prose. This module is the single decision point for that:
 *
 *   failure → code → one bounded, semantically valid recovery (or a stop)
 *
 * Design rules (non-negotiable):
 *   - No uncontrolled autonomous retry loop. Every recovery is bounded by
 *     RECOVERY_MAX_ATTEMPTS_PER_SIGNATURE and RECOVERY_MAX_TOTAL_ATTEMPTS,
 *     independent of the turn budget (Phase 3 owns that).
 *   - Security / permission denials are NEVER recovered by mutating the
 *     command into a variant that might slip past the policy. A repeat against
 *     the same target stops the run.
 *   - Codes outside RECOVERY_CODES carry no recovery policy: the governor
 *     returns `action: "none"` and consumes nothing, so legacy behavior
 *     (e.g. the Phase 3 semantic failure guard for generic EXECUTION_FAILED)
 *     is untouched.
 */

import type { StructuredToolError, ToolErrorCode } from "../contracts";
import { semanticFailureSignature } from "./continuation";

/** One deterministic recovery per (tool, args, code, target) signature. */
export const RECOVERY_MAX_ATTEMPTS_PER_SIGNATURE = 1;
/**
 * Hard ceiling on recoveries per run — a bounded recovery budget that is
 * INDEPENDENT of the Phase 3 turn budget.
 */
export const RECOVERY_MAX_TOTAL_ATTEMPTS = 3;
/** Fallback recovery tool when a directory read is attempted. */
export const RECOVERY_DEFAULT_DIRECTORY_TOOL = "list_dir";

/** Codes with a machine-readable recovery policy. Anything else is `none`. */
export const RECOVERY_CODES: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  "NOT_A_FILE",
  "TOOL_UNAVAILABLE",
  "TIMEOUT",
  "NETWORK_ERROR",
  "HTTP_ERROR",
  "SECURITY_DENIED",
  "PERMISSION_DENIED",
  "PERMISSION_REQUIRED",
  "OUTSIDE_WORKSPACE",
  "CANCELLED",
  "INTERNAL_ERROR",
]);

/** Denials: a second attempt against the SAME target is a bypass attempt. */
const DENIAL_CODES: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  "SECURITY_DENIED",
  "PERMISSION_DENIED",
  "PERMISSION_REQUIRED",
  // A workspace-boundary verdict is a policy verdict: the same target must not
  // be re-attempted through argument variants (a DIFFERENT target stays legal).
  "OUTSIDE_WORKSPACE",
]);

/** Terminal codes: never recover, always stop. */
const TERMINAL_CODES: ReadonlySet<ToolErrorCode> = new Set<ToolErrorCode>([
  "CANCELLED",
  "INTERNAL_ERROR",
]);

export type RecoveryAction =
  /** A deterministic, semantically valid alternative tool was selected. */
  | "alternate"
  /** One retry is allowed, but never the identical call. */
  | "retry-with-changes"
  /** Change approach / report; no bypass attempts, no tool loop. */
  | "replan"
  /** Wait for the permission gate; never spam alternative commands. */
  | "await-approval"
  /** Stop recovery now (terminal). */
  | "stop"
  /** No recovery policy for this code — leave behavior untouched. */
  | "none";

export interface RecoveryFailure {
  toolName: string;
  args: Record<string, unknown>;
  error: StructuredToolError;
  /** Explicit target (path/url/command). Derived from args when omitted. */
  target?: string;
  /** Tool names available this turn. An alternate outside this set is never offered. */
  availableTools?: ReadonlySet<string>;
}

export interface RecoveryDecision {
  action: RecoveryAction;
  code: ToolErrorCode;
  /** Stable failure signature (tool + normalized args + code + target). */
  signature: string;
  /** True when the harness must stop the run with `error`. */
  stop: boolean;
  reason: string;
  /** Deterministic alternative selected for this failure. */
  alternateTool?: string;
  /** Model-facing instruction injected into the transcript. */
  instruction?: string;
  /** Terminal message when `stop` is true. */
  error?: string;
  /** Recoveries already granted for this exact signature (0 = first failure). */
  attemptsUsed: number;
}

/** Alternate tools per failing tool — semantically valid, never a bypass. */
const ALTERNATE_BY_TOOL: Record<string, string> = {
  browser: "web_fetch",
  browser_action: "web_fetch",
  read_file: "list_dir",
  list_dir: "tree",
  tree: "list_dir",
};

/**
 * Signals that a browser request genuinely requires a real browser session
 * (screenshots, DOM interaction, page script evaluation). `web_fetch` cannot
 * satisfy those semantics, so it is NOT offered as an alternate.
 */
const BROWSER_INTERACTION_HINTS = [
  "screenshot",
  "pdf",
  "click",
  "fill",
  "type(",
  "press",
  "hover",
  "drag",
  "select",
  "upload",
  "setinputfiles",
  "waitfor",
  "evaluate",
  "keyboard",
  "mouse",
  "cookies",
  "localstorage",
  "trace",
];

const TARGET_ARG_KEYS = [
  "path",
  "file",
  "filepath",
  "filename",
  "url",
  "link",
  "command",
  "cmd",
  "pattern",
  "query",
  "name",
  "root",
  "dir",
  "directory",
];

/** Best-effort resource the call targeted — part of the failure signature. */
export function recoveryTargetFor(toolName: string, args: Record<string, unknown> | undefined): string {
  const input = args ?? {};
  for (const key of TARGET_ARG_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

/**
 * Anti-loop signature. Includes tool, normalized intent/args, the structured
 * error code and the relevant target, so "the same failure" and "an equivalent
 * variant" collapse to one signature while a genuinely changed call does not.
 */
export function recoveryFailureSignature(
  toolName: string,
  args: Record<string, unknown>,
  code: ToolErrorCode,
  target = recoveryTargetFor(toolName, args)
): string {
  return `${semanticFailureSignature(toolName, args)}::${code}::${target.toLowerCase()}`;
}

/** Coarse signature for denials: ANY retry against the same target. */
export function recoveryDenialSignature(
  toolName: string,
  code: ToolErrorCode,
  target: string
): string {
  // Whitespace/case only variants of the same target are the SAME attempt: a
  // `cat  /etc/shadow ` re-issue must not look like a new strategy.
  const normalized = String(target ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${String(toolName).toLowerCase()}::${code}::${normalized}`;
}

/** True when the request requires real browser interaction (semantics guard). */
export function browserRequestRequiresRealBrowser(args: Record<string, unknown> | undefined): boolean {
  let blob = "";
  try {
    blob = JSON.stringify(args ?? {}).toLowerCase();
  } catch {
    blob = String(args ?? "").toLowerCase();
  }
  return BROWSER_INTERACTION_HINTS.some((hint) => blob.includes(hint));
}

function isAvailable(name: string, available: ReadonlySet<string> | undefined): boolean {
  if (!available) return true; // unknown inventory: the schema of the turn is authoritative upstream
  const lower = name.toLowerCase();
  for (const candidate of available) {
    if (candidate.toLowerCase() === lower) return true;
  }
  return false;
}

/**
 * Deterministic alternate selection: the error's own `suggestedTool` wins when
 * it is actually available, then the tool mapping — with the browser semantics
 * guard applied.
 */
export function selectAlternateTool(failure: RecoveryFailure): string | undefined {
  const { toolName, args, error, availableTools } = failure;
  const hint = error.suggestedTool;
  if (hint && isAvailable(hint, availableTools)) return hint;

  const candidate = ALTERNATE_BY_TOOL[String(toolName).toLowerCase()];
  if (!candidate || !isAvailable(candidate, availableTools)) return undefined;
  if (candidate === "web_fetch" && browserRequestRequiresRealBrowser(args)) return undefined;
  return candidate;
}

/** Distinguishable terminal message for an exhausted recovery budget. */
export function recoveryExhaustedError(toolName: string, code: ToolErrorCode): string {
  return `Recovery exhausted: '${toolName}' failed with ${code} and the equivalent retry already consumed its bounded recovery. Stopping instead of looping.`;
}

export function recoveryBudgetError(): string {
  return `Recovery budget exhausted (${RECOVERY_MAX_TOTAL_ATTEMPTS} bounded recoveries per run). Stopping instead of looping.`;
}

/** Distinguishable terminal message for a repeated policy denial. */
export function policyBypassError(toolName: string, code: ToolErrorCode, target: string): string {
  return `Policy bypass attempt blocked: '${toolName}' was denied with ${code} again${target ? ` for '${target}'` : ""}. Command variants must never be used to work around a security or permission verdict. Stopping.`;
}

/** Distinguishable terminal message for approval-request spam. */
export function approvalPendingError(toolName: string, target: string): string {
  return `Approval is still pending for '${toolName}'${target ? ` ('${target}')` : ""}. Waiting for the decision instead of spamming alternative commands. Stopping.`;
}

export function cancelledError(): string {
  return "Cancelled: recovery stopped (the run was cancelled).";
}

export function internalErrorStop(): string {
  return "Internal tool error: not retrying automatically (no blind retry).";
}

export class RecoveryGovernor {
  private readonly attempts = new Map<string, number>();
  private readonly denials = new Map<string, number>();
  private grantedTotal = 0;

  /** Recoveries granted this run (bounded by RECOVERY_MAX_TOTAL_ATTEMPTS). */
  get totalRecoveries(): number {
    return this.grantedTotal;
  }

  get trackedSignatures(): number {
    return this.attempts.size + this.denials.size;
  }

  snapshot(): { totalRecoveries: number; attempts: Record<string, number>; denials: Record<string, number> } {
    return {
      totalRecoveries: this.grantedTotal,
      attempts: Object.fromEntries(this.attempts),
      denials: Object.fromEntries(this.denials),
    };
  }

  /**
   * Decide what the loop may do about one structured failure.
   *
   * `stop: true` means the harness must end the run with `error` after the
   * current batch has been answered. `stop: false` + `instruction` means the
   * model gets exactly one bounded, recovery-shaped next step.
   */
  assess(failure: RecoveryFailure): RecoveryDecision {
    const code = failure.error.code;
    const target = failure.target ?? recoveryTargetFor(failure.toolName, failure.args);
    const signature = recoveryFailureSignature(failure.toolName, failure.args, code, target);

    // No policy for this code: leave the legacy behavior completely untouched.
    if (!RECOVERY_CODES.has(code)) {
      return {
        action: "none",
        code,
        signature,
        stop: false,
        reason: `No structured recovery policy for code '${code}'.`,
        attemptsUsed: 0,
      };
    }

    const attemptsUsed = this.attempts.get(signature) ?? 0;

    if (TERMINAL_CODES.has(code)) {
      return {
        action: "stop",
        code,
        signature,
        stop: true,
        attemptsUsed,
        reason: code === "CANCELLED" ? "run cancelled" : "internal error is not retried automatically",
        error: code === "CANCELLED" ? cancelledError() : internalErrorStop(),
      };
    }

    // Denials: a repeat against the same target is a bypass attempt.
    if (DENIAL_CODES.has(code)) {
      const coarse = recoveryDenialSignature(failure.toolName, code, target);
      const priorDenials = this.denials.get(coarse) ?? 0;
      if (priorDenials >= 1) {
        return {
          action: "stop",
          code,
          signature,
          stop: true,
          attemptsUsed: priorDenials,
          reason: "repeated denial against the same target",
          error:
            code === "PERMISSION_REQUIRED"
              ? approvalPendingError(failure.toolName, target)
              : policyBypassError(failure.toolName, code, target),
        };
      }
      this.denials.set(coarse, priorDenials + 1);
      this.grantedTotal += 1;
      return this.denialDecision(failure, code, signature, target, priorDenials);
    }

    // Bounded recovery budget: per signature, then per run.
    if (attemptsUsed >= RECOVERY_MAX_ATTEMPTS_PER_SIGNATURE) {
      return {
        action: "stop",
        code,
        signature,
        stop: true,
        attemptsUsed,
        reason: "recovery already consumed for this equivalent failure",
        error: recoveryExhaustedError(failure.toolName, code),
      };
    }
    if (this.grantedTotal >= RECOVERY_MAX_TOTAL_ATTEMPTS) {
      return {
        action: "stop",
        code,
        signature,
        stop: true,
        attemptsUsed,
        reason: "run-level recovery budget exhausted",
        error: recoveryBudgetError(),
      };
    }

    this.attempts.set(signature, attemptsUsed + 1);
    this.grantedTotal += 1;
    return this.recoveryDecision(failure, code, signature, target, attemptsUsed);
  }

  // ── Policy bodies ───────────────────────────────────────────────────────

  private denialDecision(
    failure: RecoveryFailure,
    code: ToolErrorCode,
    signature: string,
    target: string,
    attemptsUsed: number
  ): RecoveryDecision {
    if (code === "PERMISSION_REQUIRED") {
      return {
        action: "await-approval",
        code,
        signature,
        stop: false,
        attemptsUsed,
        reason: "approval required",
        instruction:
          "This action requires user approval. Wait for the decision and do NOT issue alternative commands to obtain the same effect; report the pending approval instead.",
      };
    }
    const reason =
      code === "SECURITY_DENIED"
        ? "security policy denied the action"
        : "the user denied the action";
    return {
      action: "replan",
      code,
      signature,
      stop: false,
      attemptsUsed,
      reason,
      instruction: `${reason}${target ? ` for '${target}'` : ""}. Do NOT rewrite the command into a variant to bypass the policy and do not retry it. Replan without this action, or stop and report why it is blocked.`,
    };
  }

  private recoveryDecision(
    failure: RecoveryFailure,
    code: ToolErrorCode,
    signature: string,
    target: string,
    attemptsUsed: number
  ): RecoveryDecision {
    const { toolName, error, args } = failure;

    switch (code) {
      case "NOT_A_FILE": {
        const alternate = selectAlternateTool(failure) ?? RECOVERY_DEFAULT_DIRECTORY_TOOL;
        return {
          action: "alternate",
          code,
          signature,
          stop: false,
          attemptsUsed,
          alternateTool: alternate,
          reason: "target is a directory, not a file",
          instruction: `'${toolName}' failed with NOT_A_FILE${target ? ` for '${target}'` : ""}. Recover with ONE '${alternate}' call on that same target; do not call '${toolName}' on it again.`,
        };
      }

      case "TOOL_UNAVAILABLE": {
        const alternate = selectAlternateTool(failure);
        if (alternate) {
          return {
            action: "alternate",
            code,
            signature,
            stop: false,
            attemptsUsed,
            alternateTool: alternate,
            reason: "tool unavailable, semantically valid alternative exists",
            instruction: `'${toolName}' is unavailable. Use '${alternate}' instead${target ? ` for '${target}'` : ""}; never call '${toolName}' again in this run.`,
          };
        }
        return {
          action: "replan",
          code,
          signature,
          stop: false,
          attemptsUsed,
          reason: "tool unavailable and no equivalent tool exists",
          instruction:
            browserRequestRequiresRealBrowser(args)
              ? `'${toolName}' is unavailable and this request needs real browser interaction, so web_fetch is NOT equivalent. Stop retrying it; report that the capability is missing.`
              : `'${toolName}' is unavailable and has no equivalent tool here. Choose a different available tool; never call '${toolName}' again.`,
        };
      }

      case "TIMEOUT":
      case "NETWORK_ERROR": {
        const alternate = selectAlternateTool(failure);
        if (alternate) {
          return {
            action: "alternate",
            code,
            signature,
            stop: false,
            attemptsUsed,
            alternateTool: alternate,
            reason: `${code}: bounded alternate strategy`,
            instruction: `'${toolName}' exhausted its internal retries (${code}). Take the ONE bounded alternate: '${alternate}'${target ? ` for '${target}'` : ""}. Do not repeat the identical call.`,
          };
        }
        return {
          action: "retry-with-changes",
          code,
          signature,
          stop: false,
          attemptsUsed,
          reason: `${code}: internal retries already exhausted`,
          instruction: `'${toolName}' exhausted its internal retries (${code}). Take ONE different strategy — a different tool, target or approach. Repeating the identical call is not allowed.`,
        };
      }

      case "HTTP_ERROR": {
        const status = Number((error.details as Record<string, unknown> | undefined)?.status);
        if (status === 404 || status === 403) {
          return {
            action: "replan",
            code,
            signature,
            stop: false,
            attemptsUsed,
            reason: `HTTP ${status}: retrying cannot help`,
            instruction: `'${toolName}' returned HTTP ${status}${target ? ` for '${target}'` : ""}. Do not retry the same request; replan (different resource or stop and report).`,
          };
        }
        const alternate = selectAlternateTool(failure);
        if (alternate) {
          return {
            action: "alternate",
            code,
            signature,
            stop: false,
            attemptsUsed,
            alternateTool: alternate,
            reason: `HTTP ${Number.isFinite(status) ? status : "error"}: bounded alternate strategy`,
            instruction: `'${toolName}' exhausted its internal retries (HTTP ${Number.isFinite(status) ? status : "error"}). Take the ONE bounded alternate: '${alternate}'. Do not repeat the identical call.`,
          };
        }
        return {
          action: "retry-with-changes",
          code,
          signature,
          stop: false,
          attemptsUsed,
          reason: `HTTP ${Number.isFinite(status) ? status : "error"}: internal retries exhausted`,
          instruction: `'${toolName}' exhausted its internal retries (HTTP ${Number.isFinite(status) ? status : "error"}). Take ONE different strategy; do not repeat the identical call.`,
        };
      }

      default:
        return {
          action: "retry-with-changes",
          code,
          signature,
          stop: false,
          attemptsUsed,
          reason: `${code}: one bounded changed retry`,
          instruction: `'${toolName}' failed with ${code}. Take ONE changed approach; repeating the identical call is not allowed.`,
        };
    }
  }
}

/**
 * Structured error carried by a tool result envelope, if any. Recovery is
 * driven ONLY by this machine-readable block — never by parsing stderr prose.
 */
export function extractStructuredError(result: unknown): StructuredToolError | null {
  if (typeof result !== "string" || result.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = (parsed as { structuredError?: unknown }).structuredError;
  if (!candidate || typeof candidate !== "object") return null;
  const error = candidate as StructuredToolError;
  if (typeof error.code !== "string" || typeof error.message !== "string") return null;
  return error;
}
