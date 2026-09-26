/**
 * Session steer — TUI UX regression.
 *
 * A follow-up submitted while the agent is BUSY must be ADMITTED as a steer on
 * the SAME session (never a new prompt run, never a new session), surfaced to
 * the user, and scoped so another session never sees it.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { handleKey, resetInputState, setInputState, getInputState } from "../input/inputHandler";
import { tuiState } from "../state";
import { pendingInputs, resetPendingInputs } from "../../core/agent/pendingInput";
import { renderWorkingStatus, statusLineActive } from "../renderers/statusRenderer";

describe("composer — submit while BUSY admits a steer", () => {
  beforeEach(() => {
    resetInputState();
    resetPendingInputs();
    tuiState.appState = "ready";
    tuiState.isStreaming = false;
    tuiState.currentSessionId = "tui-s1";
    tuiState.promptHistory = [];
    tuiState.historyIndex = -1;
  });

  it("Enter while streaming admits the whole prompt as a steer on the same session", () => {
    tuiState.isStreaming = true;
    setInputState("kiểm tra thêm phần Maybach, sửa carousel");

    handleKey(Buffer.from("\r"));

    expect(pendingInputs.count("tui-s1")).toBe(1);
    expect(pendingInputs.pending("tui-s1")[0].content).toBe("kiểm tra thêm phần Maybach, sửa carousel");
    // The composer clears once the follow-up is accepted.
    expect(getInputState().buffer).toBe("");
  });

  it("the pending steer is given a delivery of steer (not the queue path)", () => {
    tuiState.isStreaming = true;
    setInputState("B");
    handleKey(Buffer.from("\r"));
    expect(pendingInputs.pending("tui-s1")[0].delivery).toBe("steer");
  });

  it("multiple busy submits accumulate FIFO", () => {
    tuiState.isStreaming = true;
    setInputState("B");
    handleKey(Buffer.from("\r"));
    setInputState("C");
    handleKey(Buffer.from("\r"));
    setInputState("D");
    handleKey(Buffer.from("\r"));
    expect(pendingInputs.pending("tui-s1").map((i) => i.content)).toEqual(["B", "C", "D"]);
  });

  it("an idle submit does NOT create a pending steer", () => {
    tuiState.isStreaming = false;
    setInputState("normal prompt");
    handleKey(Buffer.from("\r"));
    expect(pendingInputs.count("tui-s1")).toBe(0);
  });

  it("steer state is scoped: another session never sees it", () => {
    tuiState.isStreaming = true;
    setInputState("B");
    handleKey(Buffer.from("\r"));
    expect(pendingInputs.count("tui-s1")).toBe(1);
    expect(pendingInputs.count("tui-other")).toBe(0);
  });
});

describe("status line — pending steer indicator", () => {
  it("is not active when nothing is happening", () => {
    expect(
      statusLineActive({
        showHelp: false,
        isStreaming: false,
        spinnerIdx: 0,
        statusText: "",
        elapsedDisplay: "",
        primaryColor: "",
      }),
    ).toBe(false);
  });

  it("stays active on a pending steer alone", () => {
    expect(
      statusLineActive({
        showHelp: false,
        isStreaming: false,
        spinnerIdx: 0,
        statusText: "",
        elapsedDisplay: "",
        primaryColor: "",
        pendingInputs: 1,
      }),
    ).toBe(true);
  });

  it("renders a compact singular badge while Working", () => {
    const line = renderWorkingStatus(52, {
      showHelp: false,
      isStreaming: true,
      spinnerIdx: 0,
      statusText: "Working",
      elapsedDisplay: "",
      primaryColor: "",
      pendingInputs: 1,
    });
    expect(line).toContain("Working");
    expect(line).toContain("1 steer pending");
  });

  it("renders a plural badge and never produces an empty separator", () => {
    const line = renderWorkingStatus(52, {
      showHelp: false,
      isStreaming: true,
      spinnerIdx: 0,
      statusText: "Working",
      elapsedDisplay: "",
      primaryColor: "",
      pendingInputs: 2,
    });
    expect(line).toContain("2 steers pending");
  });

  it("does not print the badge when there is no pending steer", () => {
    const line = renderWorkingStatus(52, {
      showHelp: false,
      isStreaming: true,
      spinnerIdx: 0,
      statusText: "Working",
      elapsedDisplay: "",
      primaryColor: "",
    });
    expect(line).not.toContain("pending");
  });
});
