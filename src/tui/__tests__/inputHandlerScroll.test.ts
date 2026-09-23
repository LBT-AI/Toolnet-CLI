import { describe, it, expect, beforeEach } from "bun:test";
import { handleKey, resetInputState, setInputState, getInputState } from "../input/inputHandler";
import { tuiState } from "../state";
import { createChatViewport } from "../viewport";

describe("TUI arrow-key history routing", () => {
  beforeEach(() => {
    resetInputState();
    tuiState.clearMessages();
    tuiState.chatViewport = createChatViewport();
    tuiState.chatRows = 5;
    tuiState.chatLineMessageIds = ["user", "assistant", "assistant", "assistant", "tool", "tool", "tool", "assistant-final"];
    tuiState.promptHistory = [];
    tuiState.historyIndex = -1;
    tuiState.savedInput = "";
  });

  it("Up enters chat history even when prompt history is populated", () => {
    tuiState.promptHistory = ["previous prompt"];
    handleKey(Buffer.from("\x1b[A"));

    expect(tuiState.chatViewport.followTail).toBe(false);
    expect(tuiState.chatViewport.anchorMessageId).toBe("assistant");
    expect(tuiState.chatViewport.anchorRowOffset).toBe(1);
    expect(getInputState().buffer).toBe("");
  });

  it("Ctrl+P recalls prompt history without detaching chat", () => {
    tuiState.promptHistory = ["first prompt", "second prompt"];
    setInputState("draft");

    handleKey(Buffer.from("\x10"));

    expect(getInputState().buffer).toBe("second prompt");
    expect(tuiState.chatViewport.followTail).toBe(true);
    expect(tuiState.chatViewport.anchorMessageId).toBeNull();
  });

  it("Down in chat history moves toward the bottom without reclaiming follow-tail early", () => {
    tuiState.chatViewport = createChatViewport();
    tuiState.chatViewport.followTail = false;
    tuiState.chatViewport.topRow = 2;
    tuiState.chatViewport.anchorMessageId = "assistant";
    tuiState.chatViewport.anchorRowOffset = 2;
    tuiState.chatRows = 3;
    tuiState.chatLineMessageIds = [
      "user",
      "assistant",
      "assistant",
      "assistant",
      "tool",
      "tool",
      "tool",
      "assistant-final",
      "assistant-final",
      "assistant-final",
    ];

    const maxTop = tuiState.chatLineMessageIds.length - tuiState.chatRows;
    handleKey(Buffer.from("\x1b[B"));
    expect(tuiState.chatViewport.followTail).toBe(false);
    expect(tuiState.chatViewport.topRow).toBe(4);

    handleKey(Buffer.from("\x1b[B"));
    expect(tuiState.chatViewport.followTail).toBe(false);
    expect(tuiState.chatViewport.topRow).toBe(5);

    handleKey(Buffer.from("\x1b[B"));
    expect(tuiState.chatViewport.followTail).toBe(false);
    expect(tuiState.chatViewport.topRow).toBe(6);

    handleKey(Buffer.from("\x1b[B"));
    expect(tuiState.chatViewport.followTail).toBe(true);
    expect(tuiState.chatViewport.topRow).toBe(0);
    expect(tuiState.chatViewport.anchorMessageId).toBeNull();
  });
});
