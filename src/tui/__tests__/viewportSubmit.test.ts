import { describe, it, expect, beforeEach } from "bun:test";
import { pinToTail, scrollUp, type LineMessageIds } from "../viewport";
import { tuiState } from "../state";
import { createChatViewport } from "../viewport";

describe("viewport submit pinning", () => {
  beforeEach(() => {
    tuiState.clearMessages();
    tuiState.chatViewport = createChatViewport();
  });

  it("re-arms follow mode only when a new prompt is submitted", () => {
    const lines: LineMessageIds = ["u1", "a1", "a1", "a2", "a2", "a2"];
    tuiState.chatLineMessageIds = [...lines];
    tuiState.chatRows = 3;

    scrollUp(tuiState.chatViewport, lines.length, tuiState.chatRows, lines);
    expect(tuiState.chatViewport.followTail).toBe(false);

    pinToTail(tuiState.chatViewport);
    expect(tuiState.chatViewport.followTail).toBe(true);
    expect(tuiState.chatViewport.topRow).toBe(0);
    expect(tuiState.chatViewport.anchorMessageId).toBeNull();
    expect(tuiState.chatViewport.anchorRowOffset).toBe(0);
  });
});
