/**
 * Canonical status ownership.
 *
 * The TUI has ONE lifecycle field (`tuiState.agentPhase`) written by the agent
 * event wiring. These tests pin the contract that the header badge and the
 * status line render FROM that canonical state instead of inferring a phase by
 * substring-matching the transient `statusText`.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { renderHeader } from "../renderers/headerRenderer";
import { renderWorkingStatus } from "../renderers/statusRenderer";
import { stripAnsi, visibleWidth } from "../layout";
import {
  sessionStatusFromPhase,
  describeAgentPhase,
  isActivePhase,
} from "../sessionStatus";
import { tuiState } from "../state";

describe("canonical session status", () => {
  beforeEach(() => {
    tuiState.statusText = "";
    tuiState.isStreaming = false;
    tuiState.spinnerIdx = 0;
    tuiState.elapsedDisplay = "";
    tuiState.agentPhase = "idle";
    tuiState.showHelp = false;
  });

  afterEach(() => {
    tuiState.statusText = "";
    tuiState.isStreaming = false;
    tuiState.agentPhase = "idle";
  });

  it("projects every agent phase onto the canonical status set", () => {
    expect(sessionStatusFromPhase("idle")).toBe("idle");
    expect(sessionStatusFromPhase("thinking")).toBe("thinking");
    expect(sessionStatusFromPhase("working")).toBe("tool_use");
    expect(sessionStatusFromPhase("streaming")).toBe("finalizing");
    expect(sessionStatusFromPhase("waiting_approval")).toBe("waiting_permission");
    expect(sessionStatusFromPhase("compacting")).toBe("compacting");
    expect(sessionStatusFromPhase("cancelled")).toBe("cancelled");
    expect(sessionStatusFromPhase("error")).toBe("error");
    // Terminal "done" folds back to idle — the transient ✔ text carries result.
    expect(sessionStatusFromPhase("done")).toBe("idle");
  });

  it("marks only live phases as active", () => {
    expect(isActivePhase("thinking")).toBe(true);
    expect(isActivePhase("working")).toBe(true);
    expect(isActivePhase("streaming")).toBe(true);
    expect(isActivePhase("waiting_approval")).toBe(true);
    expect(isActivePhase("compacting")).toBe(true);
    expect(isActivePhase("idle")).toBe(false);
    expect(isActivePhase("done")).toBe(false);
    expect(isActivePhase("cancelled")).toBe(false);
    expect(isActivePhase("error")).toBe(false);
  });

  it("renders the status line from agentPhase, never from statusText content", () => {
    // Thinking must win even though the stale statusText says "Running command…".
    const thinking = stripAnsi(
      renderWorkingStatus(80, {
        showHelp: false,
        isStreaming: true,
        spinnerIdx: 0,
        statusText: "Running command…",
        elapsedDisplay: "1.0s",
        primaryColor: "\x1b[36m",
        agentPhase: "thinking",
      }),
    );
    expect(thinking).toContain("Thinking");
    expect(thinking).not.toContain("Running command…");

    // Working must NOT be relabelled "Thinking" just because statusText says so.
    const working = stripAnsi(
      renderWorkingStatus(80, {
        showHelp: false,
        isStreaming: true,
        spinnerIdx: 0,
        statusText: "Thinking",
        elapsedDisplay: "2.0s",
        primaryColor: "\x1b[36m",
        agentPhase: "working",
      }),
    );
    expect(working).toContain("Working");
    expect(working).not.toContain("Thinking");
  });

  it("renders the header badge from agentPhase, never from statusText content", () => {
    const working = stripAnsi(
      renderHeader(100, {
        agentMode: "Build",
        bypassMode: false,
        bypassLevel: "none",
        isStreaming: true,
        spinnerIdx: 0,
        statusText: "Thinking",
        agentPhase: "working",
      }),
    );
    expect(working).toContain("Working");
    expect(working).not.toContain("Thinking");
  });

  it("surfaces waiting/compacting as distinct canonical labels", () => {
    const waiting = stripAnsi(
      renderWorkingStatus(80, {
        showHelp: false,
        isStreaming: true,
        spinnerIdx: 0,
        statusText: "",
        elapsedDisplay: "",
        primaryColor: "\x1b[36m",
        agentPhase: "waiting_approval",
      }),
    );
    expect(waiting).toContain("Waiting for permission");

    const compacting = stripAnsi(
      renderWorkingStatus(80, {
        showHelp: false,
        isStreaming: true,
        spinnerIdx: 0,
        statusText: "",
        elapsedDisplay: "",
        primaryColor: "\x1b[36m",
        agentPhase: "compacting",
      }),
    );
    expect(compacting).toContain("Compacting");
  });

  it("still shows the transient result text once the phase settles to done/idle", () => {
    const done = stripAnsi(
      renderWorkingStatus(80, {
        showHelp: false,
        isStreaming: false,
        spinnerIdx: 0,
        statusText: "✔ Done in 1.2s",
        elapsedDisplay: "",
        primaryColor: "\x1b[36m",
        agentPhase: "done",
      }),
    );
    expect(done).toContain("✔ Done in 1.2s");

    const idle = stripAnsi(
      renderWorkingStatus(80, {
        showHelp: false,
        isStreaming: false,
        spinnerIdx: 0,
        statusText: "",
        elapsedDisplay: "",
        primaryColor: "\x1b[36m",
        agentPhase: "idle",
      }),
    );
    expect(idle).toBe("");
  });

  it("keeps the canonical status on a single row at the 52-column mobile target", () => {
    for (const phase of ["thinking", "working", "waiting_approval", "compacting", "streaming"] as const) {
      const raw = renderWorkingStatus(52, {
        showHelp: false,
        isStreaming: true,
        spinnerIdx: 3,
        statusText: "",
        elapsedDisplay: "1.4s",
        primaryColor: "\x1b[36m",
        agentPhase: phase,
      });
      const stripped = stripAnsi(raw);
      // Exactly one status row, terminated by CRLF, and never wider than the
      // terminal minus the trailing pad column.
      const rows = stripped.trimEnd().split("\n");
      expect(rows.length).toBe(1);
      // Never overflows the 52-column row (cell-accurate, escapes excluded).
      expect(visibleWidth(raw)).toBeLessThanOrEqual(52);
    }
  });

  it("keeps the legacy text-based presentation when no canonical phase is supplied", () => {
    // Isolated callers/tests pass no agentPhase; the historical behavior is
    // preserved so the renderer remains usable on its own.
    const legacy = stripAnsi(
      renderWorkingStatus(80, {
        showHelp: false,
        isStreaming: true,
        spinnerIdx: 0,
        statusText: "Running command…",
        elapsedDisplay: "1.4s",
        primaryColor: "\x1b[36m",
      }),
    );
    expect(legacy).toContain("Running command…");
  });
});
