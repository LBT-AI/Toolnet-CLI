/**
 * Regression: parallel tool activity lifecycle.
 *
 * The core dispatches independent read-only tools in parallel (ToolPlanner),
 * but the TUI used to keep ONE `activeToolActivity` slot, so only the last
 * started tool was visible (and a progress/complete for an earlier tool was
 * dropped). The store is now keyed by callId.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  tuiState,
  openActiveToolActivity,
  updateActiveToolProgress,
  closeActiveToolActivity,
  cancelActiveToolActivity,
  getActiveToolActivities,
} from "../../tui/state";
import { renderToolActivities, MAX_ACTIVITY_ROWS } from "../../tui/renderers/chatRenderer";
import { computeLayoutGeometry, stripAnsi } from "../../tui/layout";

function runningIds(): string[] {
  return getActiveToolActivities().map((activity) => activity.callId);
}

describe("Parallel tool activity — callId-keyed lifecycle", () => {
  beforeEach(() => {
    tuiState.clearMessages();
    tuiState.clearToolActivities();
  });

  afterEach(() => {
    tuiState.clearMessages();
    tuiState.clearToolActivities();
  });

  it("keeps A, B and C active after all three start", () => {
    openActiveToolActivity("A", "read_file", { path: "a.ts" });
    openActiveToolActivity("B", "read_file", { path: "b.ts" });
    openActiveToolActivity("C", "read_file", { path: "c.ts" });

    expect(getActiveToolActivities()).toHaveLength(3);
    expect(runningIds()).toEqual(["A", "B", "C"]);
  });

  it("routes progress to the matching callId only", () => {
    openActiveToolActivity("A", "read_file", { path: "a.ts" });
    openActiveToolActivity("B", "read_file", { path: "b.ts" });

    updateActiveToolProgress("A", { elapsedMs: 250, tail: ["a-line"] });

    expect(tuiState.findToolActivity("A")?.elapsedMs).toBe(250);
    expect(tuiState.findToolActivity("A")?.tail).toEqual(["a-line"]);
    expect(tuiState.findToolActivity("B")?.elapsedMs).toBe(0);
    expect(tuiState.findToolActivity("B")?.tail).toEqual([]);
  });

  it("completing B leaves A and C active", () => {
    openActiveToolActivity("A", "read_file", { path: "a.ts" });
    openActiveToolActivity("B", "read_file", { path: "b.ts" });
    openActiveToolActivity("C", "read_file", { path: "c.ts" });

    closeActiveToolActivity("B");

    expect(runningIds()).toEqual(["A", "C"]);
    expect(tuiState.findToolActivity("B")).toBeUndefined();
    expect(tuiState.hasActiveToolActivity("A")).toBe(true);
  });

  it("survives out-of-order completion (B done → A progress → A done) without losing A", () => {
    openActiveToolActivity("A", "grep", { pattern: "x" });
    openActiveToolActivity("B", "grep", { pattern: "y" });

    // B finishes first.
    closeActiveToolActivity("B");
    expect(getActiveToolActivities()).toHaveLength(1);

    // A's later progress must still land on A.
    updateActiveToolProgress("A", { elapsedMs: 900, tail: ["still running"] });
    expect(tuiState.findToolActivity("A")?.elapsedMs).toBe(900);
    expect(getActiveToolActivities()).toHaveLength(1);

    // A then finishes.
    closeActiveToolActivity("A");
    expect(getActiveToolActivities()).toHaveLength(0);
    expect(tuiState.findToolActivity("A")).toBeUndefined();
  });

  it("cancels all running activities without dropping any", () => {
    openActiveToolActivity("A", "bash", { command: "a" });
    openActiveToolActivity("B", "bash", { command: "b" });

    const cancelled = tuiState.cancelAllToolActivities();

    expect(cancelled.map((a) => a.callId).sort()).toEqual(["A", "B"]);
    expect(cancelled.every((a) => a.status === "cancelled")).toBe(true);
    expect(getActiveToolActivities()).toHaveLength(0);
  });

  it("cancelActiveToolActivity targets a single callId", () => {
    openActiveToolActivity("A", "bash", { command: "a" });
    openActiveToolActivity("B", "bash", { command: "b" });

    expect(cancelActiveToolActivity("A")).toBe(true);
    expect(tuiState.findToolActivity("A")?.status).toBe("cancelled");
    expect(tuiState.findToolActivity("B")?.status).toBe("running");
  });

  it("keeps the legacy single-slot accessor as the most recent running activity", () => {
    openActiveToolActivity("A", "bash", { command: "a" });
    openActiveToolActivity("B", "bash", { command: "b" });

    expect(tuiState.activeToolActivity?.callId).toBe("B");
    // Assigning still replaces the whole set (old API).
    tuiState.activeToolActivity = null;
    expect(getActiveToolActivities()).toHaveLength(0);
  });
});

describe("Parallel tool activity — bounded 52x20 rendering", () => {
  beforeEach(() => {
    tuiState.clearToolActivities();
  });

  afterEach(() => {
    tuiState.clearToolActivities();
  });

  it("renders each running activity within width and bounds the total rows", () => {
    const layout = computeLayoutGeometry(52, 20);
    openActiveToolActivity("A", "grep", { pattern: "a very long search pattern that would overflow" });
    openActiveToolActivity("B", "grep", { pattern: "another long search pattern" });
    openActiveToolActivity("C", "grep", { pattern: "third long search pattern" });

    const lines = renderToolActivities(getActiveToolActivities(), layout.chatCols);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(MAX_ACTIVITY_ROWS);
    for (const line of lines) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(layout.chatCols);
    }
  });

  it("renders nothing when no tool is running", () => {
    expect(renderToolActivities([], 52)).toEqual([]);
  });
});
