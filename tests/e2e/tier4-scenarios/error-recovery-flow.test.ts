import { describe, it, expect } from "bun:test";
import {
  renderWithErrorBoundary,
  renderFallbackFrame,
  terminalTeardownSequence,
} from "../../../src/tui/renderers/errorBoundary";
import { computeLayoutGeometry, MIN_COLS, MIN_ROWS } from "../../../src/tui/layout";
import { tuiState } from "../../../src/tui/state";
import {
  getPermissionInterruptManager,
  requestApprovalModal,
  cancelPendingApproval,
} from "../../../src/tui/permissions/permissionModal";
import { createAsyncMutation } from "../../../src/tui/asyncMutation";
import stripAnsi from "strip-ansi";

/**
 * Error-recovery flow: a fault mid-turn must preserve session state, leave
 * pending work in a defined state, and always paint a recoverable frame.
 */
describe("Tier 4 Scenario: Error Recovery Flow", () => {
  it("T4.16: a render fault mid-turn preserves session state and messages", () => {
    const state = tuiState;
    const messagesBefore = [...state.messages];
    const sessionIdBefore = state.currentSessionId;

    const res = renderWithErrorBoundary(() => {
      throw new Error("transcript renderer exploded mid-turn");
    }, 100, 30);

    expect(res.hasError).toBe(true);
    expect(res.error?.message).toContain("exploded");
    // Session state untouched by the render fault.
    expect(state.currentSessionId).toBe(sessionIdBefore);
    expect(state.messages).toEqual(messagesBefore);
  });

  it("T4.17: an exception thrown inside a mutation leaves error state captured and visible", async () => {
    const mutation = createAsyncMutation(async () => {
      throw new Error("session save failed: disk full");
    });

    const attempt = mutation.execute(undefined);
    await attempt.catch(() => undefined);

    expect(mutation.state).toBe("error");
    expect(mutation.error).toBeInstanceOf(Error);
    expect(mutation.error?.message).toContain("disk full");

    // Recovery: reset returns the pipeline to idle for the next action.
    mutation.reset();
    expect(mutation.state).toBe("idle");
    expect(mutation.error).toBeNull();
  });

  it("T4.18: fault during an active approval dialog unwinds the pending request", async () => {
    const manager = getPermissionInterruptManager();
    let settled: boolean | null = null;

    const p = requestApprovalModal({ toolName: "shell", args: {}, reason: "fault while asking" });
    void p.then((ok) => (settled = ok));
    await new Promise((r) => setTimeout(r, 5));
    expect(tuiState.pendingConfirmation).not.toBeNull();

    // The dialog is cancelled (abort path) rather than left hanging forever.
    expect(cancelPendingApproval()).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    expect(manager.hasPending()).toBe(false);
  });

  it("T4.19: repeated faults always produce a bounded, recoverable frame", () => {
    for (let i = 0; i < 3; i++) {
      const res = renderWithErrorBoundary(() => {
        throw new Error(`fault ${i}`);
      }, 80, 24);
      expect(res.hasError).toBe(true);
      const plain = stripAnsi(res.frame);
      expect(plain).toContain("Ctrl+L");
      expect(plain).toContain("/exit");
      // Frame width is bounded by the box renderer (58 wide on roomy
      // terminals, the 40-col floor otherwise) — never the raw terminal width.
      for (const line of plain.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(58);
      }
    }
  });

  it("T4.20: terminal teardown sequence fully restores the terminal after exceptional exit", () => {
    const seq = terminalTeardownSequence("\x1b[?2004l");
    // Cursor shown, bracketed paste disabled, alternate screen left — in order.
    expect(seq.indexOf("\x1b[?25h")).toBe(0);
    expect(seq.indexOf("\x1b[?2004l")).toBeGreaterThan(0);
    expect(seq.indexOf("\x1b[?1049l")).toBe(seq.length - "\x1b[?1049l".length);
  });

  it("T4.21: layout floor guarantees a recoverable frame at the smallest terminal", () => {
    const geo = computeLayoutGeometry(1, 1, 0, 2, 0, false, 1);
    expect(geo.cols).toBe(MIN_COLS);
    expect(geo.rows).toBe(MIN_ROWS);
    expect(geo.chatRows).toBeGreaterThanOrEqual(2);
    expect(geo.inputRows).toBeGreaterThanOrEqual(2);
    expect(geo.cursorRow).toBeLessThan(geo.rows);
  });
});
