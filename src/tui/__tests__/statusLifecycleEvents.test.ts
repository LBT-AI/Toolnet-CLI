/**
 * Canonical status for approval + compaction.
 *
 * The engine now forwards `permission-required` and `compaction` on the same
 * event stream the TUI already consumes. These tests drive the REAL wiring the
 * TUI uses (`buildTuiAgentCallbacks`) and assert the single status surface
 * reflects both states instead of leaving a tool looking "running" forever.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { buildTuiAgentCallbacks } from "../events/agentWiring";
import { tuiState } from "../state";
import { statusManager } from "../statusService";

describe("Canonical approval / compaction status", () => {
  beforeEach(() => {
    tuiState.clearMessages();
    tuiState.clearToolActivities();
    tuiState.startNewRun("sess_status");
    statusManager.start("Thinking…");
  });

  afterEach(() => {
    statusManager.stop();
    tuiState.clearMessages();
    tuiState.clearToolActivities();
    tuiState.finalizeActiveReasoning("test-teardown");
  });

  it("surfaces permission-required as waiting_approval", () => {
    const cb = buildTuiAgentCallbacks(tuiState.currentRunId);
    cb.onEvent({ type: "permission-required", callId: "call-1", resource: "run_command" });

    expect(tuiState.agentPhase).toBe("waiting_approval");
    expect(tuiState.statusText).toContain("Waiting for approval");
  });

  it("returns to working once the gated tool actually starts", () => {
    const cb = buildTuiAgentCallbacks(tuiState.currentRunId);
    cb.onEvent({ type: "permission-required", callId: "call-1", resource: "run_command" });
    cb.onEvent({ type: "tool-running", callId: "call-1" });

    expect(tuiState.agentPhase).toBe("working");
  });

  it("surfaces compaction as a distinct state", () => {
    const cb = buildTuiAgentCallbacks(tuiState.currentRunId);
    cb.onEvent({ type: "compaction", trigger: "provider_overflow", originalTokens: 1000, newCount: 8 });

    expect(tuiState.agentPhase).toBe("compacting");
    expect(tuiState.statusText).toContain("Compacting");
  });
});
