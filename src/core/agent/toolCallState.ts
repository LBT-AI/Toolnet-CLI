/**
 * Phase 73.4/73.8 — Tool Call State
 *
 * Each tool call moves through a documented lifecycle:
 *
 *   pending → running → completed
 *   pending → running → error
 *   pending → cancelled
 *
 * The state is the single record of what happened to a call: its permission
 * decision, its output, and its verification outcome. UIs render from here;
 * the Completion Gate accumulates evidence from verified outputs.
 */

import type {
  PermissionDecision,
  ToolCallState,
  ToolResult,
  ToolCallStatus,
  VerificationResult,
} from "../contracts";

const VALID_TRANSITIONS: Record<ToolCallStatus, ToolCallStatus[]> = {
  pending: ["running", "cancelled", "error"],
  running: ["completed", "error", "cancelled"],
  completed: [],
  error: [],
  cancelled: [],
};

export function isValidTransition(
  from: ToolCallStatus,
  to: ToolCallStatus
): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from].includes(to);
}

export class ToolCallStateStore {
  private calls = new Map<string, ToolCallState>();

  begin(callId: string, name: string, input: unknown): ToolCallState {
    const state: ToolCallState = {
      callId,
      name,
      input,
      status: "pending",
    };
    this.calls.set(callId, state);
    return state;
  }

  get(callId: string): ToolCallState | undefined {
    return this.calls.get(callId);
  }

  list(): ToolCallState[] {
    return [...this.calls.values()];
  }

  private transition(callId: string, to: ToolCallStatus, reason?: string): void {
    const state = this.calls.get(callId);
    if (!state) return;
    if (!isValidTransition(state.status, to)) return;
    state.status = to;
    if (to === "running" && state.startedAt === undefined) {
      state.startedAt = Date.now();
    }
    if (to === "completed" || to === "error" || to === "cancelled") {
      state.endedAt = Date.now();
    }
    if (reason !== undefined && to === "error") state.error = reason;
  }

  markRunning(callId: string): void {
    this.transition(callId, "running");
  }

  setPermission(callId: string, decision: PermissionDecision): void {
    const state = this.calls.get(callId);
    if (!state) return;
    state.permission = decision;
  }

  complete(callId: string, output: ToolResult): void {
    const state = this.calls.get(callId);
    if (!state) return;
    state.output = output;
    if (output.verification) state.verification = output.verification;
    this.transition(callId, "completed");
  }

  fail(callId: string, error: string): void {
    this.transition(callId, "error", error);
  }

  cancel(callId: string): void {
    this.transition(callId, "cancelled");
  }

  setVerification(callId: string, verification: VerificationResult): void {
    const state = this.calls.get(callId);
    if (!state) return;
    state.verification = verification;
    if (state.output) state.output.verification = verification;
  }

  clear(): void {
    this.calls.clear();
  }
}