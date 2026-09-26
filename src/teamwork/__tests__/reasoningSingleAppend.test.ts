/**
 * Regression: reasoning must reach the TUI exactly ONCE.
 *
 * Before the fix the TUI passed BOTH `onReasoningDelta` (legacy engine
 * callback) AND `onEvent` (normalized contract) to AgentEngine.run. The engine
 * fans a single `agent:reasoning_chunk` out to both, and both called
 * appendReasoningDelta — so every chunk was appended twice ("AABBCC").
 *
 * These tests drive the REAL handler the TUI wires (`buildTuiAgentCallbacks`)
 * and assert the canonical path is the only one.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { buildTuiAgentCallbacks } from "../../tui/events/agentWiring";
import { tuiState } from "../../tui/state";
import { statusManager } from "../../tui/statusService";

describe("Reasoning single-append — canonical live-event path", () => {
  beforeEach(() => {
    tuiState.clearMessages();
    tuiState.clearToolActivities();
    tuiState.isStreaming = true;
  });

  afterEach(() => {
    statusManager.stop();
    tuiState.isStreaming = false;
    tuiState.clearMessages();
    tuiState.clearToolActivities();
    tuiState.finalizeActiveReasoning("test-teardown");
  });

  it("does not expose a second reasoning callback on the TUI wiring", () => {
    const callbacks = buildTuiAgentCallbacks("run_x");
    // The normalized event stream is the ONE reasoning path.
    expect(typeof callbacks.onEvent).toBe("function");
    expect(typeof callbacks.onTextDelta).toBe("function");
    expect("onReasoningDelta" in callbacks).toBe(false);
  });

  it("appends a single chunk exactly once", () => {
    const runId = tuiState.startNewRun("sess_single");
    const cb = buildTuiAgentCallbacks(runId);

    cb.onEvent({ type: "reasoning-start" });
    cb.onEvent({ type: "reasoning-delta", text: "only-once" });

    expect(tuiState.activeReasoningDraft?.text).toBe("only-once");
  });

  it("concatenates chunks A/B/C to 'ABC' (never 'AABBCC')", () => {
    const runId = tuiState.startNewRun("sess_abc");
    const cb = buildTuiAgentCallbacks(runId);

    cb.onEvent({ type: "reasoning-start" });
    for (const chunk of ["A", "B", "C"]) {
      cb.onEvent({ type: "reasoning-delta", text: chunk });
    }

    expect(tuiState.activeReasoningDraft?.text).toBe("ABC");
  });

  it("opens on reasoning-start, accumulates deltas, and closes on reasoning-end", () => {
    const runId = tuiState.startNewRun("sess_lifecycle");
    const cb = buildTuiAgentCallbacks(runId);

    cb.onEvent({ type: "reasoning-start" });
    expect(tuiState.activeReasoningDraft).not.toBeNull();
    expect(tuiState.activeReasoningDraft?.text).toBe("");

    cb.onEvent({ type: "reasoning-delta", text: "step 1. " });
    cb.onEvent({ type: "reasoning-delta", text: "step 2." });
    expect(tuiState.activeReasoningDraft?.text).toBe("step 1. step 2.");

    cb.onEvent({ type: "reasoning-end", timestamp: 12345 });
    expect(tuiState.activeReasoningDraft?.endedAt).toBe(12345);
  });

  it("finalizes into exactly ONE reasoning transcript block", () => {
    const runId = tuiState.startNewRun("sess_finalize");
    const cb = buildTuiAgentCallbacks(runId);

    cb.onEvent({ type: "reasoning-start" });
    cb.onEvent({ type: "reasoning-delta", text: "ABC" });
    cb.onEvent({ type: "agent-complete" });

    const reasoningMessages = tuiState.messages.filter((m) => m.role === "reasoning");
    expect(reasoningMessages).toHaveLength(1);
    expect(reasoningMessages[0].content).toBe("ABC");
  });
});
