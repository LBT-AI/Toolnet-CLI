import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tuiState } from "../state";

describe("coalesced TUI chrome renders", () => {
  beforeEach(() => {
    tuiState.clearMessages();
    tuiState.activeAssistantDraft = null;
    tuiState.activeToolActivity = null;
    tuiState.activeReasoningDraft = null;
  });

  afterEach(() => {
    tuiState.clearMessages();
    tuiState.activeAssistantDraft = null;
    tuiState.activeToolActivity = null;
    tuiState.activeReasoningDraft = null;
  });

  test("coalesces spinner, status, and tool progress updates", async () => {
    let callbackCount = 0;
    tuiState.renderCallback = () => {
      callbackCount += 1;
    };

    tuiState.requestChromeRender();
    tuiState.requestChromeRender();
    tuiState.statusText = "Working";
    tuiState.requestChromeRender();
    tuiState.activeToolActivity = {
      callId: "progress",
      name: "bash",
      args: {},
      category: "shell",
      actionLabel: "Run",
      target: "pwd",
      startedAt: Date.now(),
      elapsedMs: 1000,
      status: "running",
      tail: ["progress"],
    };
    tuiState.requestChromeRender();

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(callbackCount).toBe(1);
  });
});
