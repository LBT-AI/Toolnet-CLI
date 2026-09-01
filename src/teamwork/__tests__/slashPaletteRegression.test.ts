import { test, it, expect, describe, beforeEach, afterEach } from "bun:test";
import { tuiState } from "../../tui/state";
import { handleKey, getInputState, setInputState, resetInputState, getSuggestions } from "../../tui/input/inputHandler";

describe("Slash Command Palette Enter & Navigation Regression Tests", () => {
  beforeEach(() => {
    resetInputState();
    tuiState.pendingConfirmation = null;
    tuiState.showHelp = false;
    tuiState.showModelPicker = false;
    tuiState.showKeyManager = false;
    tuiState.showSkillsPicker = false;
    tuiState.showQueueManager = false;
    tuiState.showSessionPicker = false;
    tuiState.messages = [];
    tuiState.cmdSuggestIdx = 0;
  });

  afterEach(() => {
    resetInputState();
    tuiState.messages = [];
    tuiState.closeKeyManager();
  });

  it("1. '/' + Enter executes first command directly and does not submit raw '/'", () => {
    setInputState("/");
    const suggests = getSuggestions(getInputState().buffer);
    expect(suggests.length).toBeGreaterThan(0);
    const expectedFirstCmd = suggests[0].name;

    const sentMessages: string[] = [];
    handleKey(Buffer.from("0d", "hex"), {
      renderAll: () => {},
      sendMessage: (text: string) => { sentMessages.push(text); },
    });

    // Enter executed the first highlighted command
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toBe(expectedFirstCmd);

    // Input buffer is cleared and suggestions palette is closed
    expect(getInputState().buffer).toBe("");
    expect(tuiState.inputBuffer).toBe("");
    expect(tuiState.cmdSuggestIdx).toBe(0);

    // No raw '/' was submitted
    expect(sentMessages).not.toContain("/");
    expect(tuiState.messages.some((m) => m.content.includes("Unknown command: /"))).toBe(false);
  });

  it("2. '/' + Down arrow + Enter executes the highlighted second command", () => {
    setInputState("/");
    const suggests = getSuggestions(getInputState().buffer);
    expect(suggests.length).toBeGreaterThan(1);
    const expectedSecondCmd = suggests[1].name;

    // Press Down arrow (1b5b42)
    handleKey(Buffer.from("1b5b42", "hex"));
    expect(tuiState.cmdSuggestIdx).toBe(1);

    const sentMessages: string[] = [];
    handleKey(Buffer.from("0d", "hex"), {
      renderAll: () => {},
      sendMessage: (text: string) => { sentMessages.push(text); },
    });

    // Enter executed the 2nd command
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toBe(expectedSecondCmd);
    expect(getInputState().buffer).toBe("");
  });

  it("3. '/' + Tab autocompletes highlighted command into input without executing", () => {
    setInputState("/");
    const suggests = getSuggestions(getInputState().buffer);
    const firstCmd = suggests[0].name;

    const sentMessages: string[] = [];
    // Press Tab (09)
    handleKey(Buffer.from("09", "hex"), {
      renderAll: () => {},
      sendMessage: (text: string) => { sentMessages.push(text); },
    });

    // Tab does NOT execute
    expect(sentMessages.length).toBe(0);
    // Buffer is autocompleted with command and trailing space
    expect(getInputState().buffer).toBe(firstCmd + " ");
    expect(tuiState.inputBuffer).toBe(firstCmd + " ");
  });

  it("4. '/' + Esc closes palette and clears input", () => {
    setInputState("/");
    expect(getSuggestions(getInputState().buffer).length).toBeGreaterThan(0);

    // Press Esc (1b)
    handleKey(Buffer.from("1b", "hex"));

    // Palette closed and input cleared
    expect(getInputState().buffer).toBe("");
    expect(tuiState.inputBuffer).toBe("");
    expect(tuiState.cmdSuggestIdx).toBe(0);
  });

  it("5. Executing slash commands via palette triggers the appropriate handlers", async () => {
    const { sendMessage } = await import("../../tui/events/agentWiring");

    // A. /key opens Key Manager modal
    tuiState.showKeyManager = false;
    setInputState("/key");
    handleKey(Buffer.from("0d", "hex"), {
      renderAll: () => {},
      sendMessage: (cmd) => sendMessage(cmd),
    });
    expect(tuiState.showKeyManager).toBe(true);

    // B. /model opens Model Picker modal
    tuiState.closeKeyManager();
    tuiState.showModelPicker = false;
    setInputState("/model");
    handleKey(Buffer.from("0d", "hex"), {
      renderAll: () => {},
      sendMessage: (cmd) => sendMessage(cmd),
    });
    expect(tuiState.showModelPicker).toBe(true);
  });

  it("6. Enter is never executed twice (no fallthrough / duplicate execution)", () => {
    setInputState("/help");
    let executionCount = 0;

    handleKey(Buffer.from("0d", "hex"), {
      renderAll: () => {},
      sendMessage: () => { executionCount++; },
    });

    expect(executionCount).toBe(1);
    expect(getInputState().buffer).toBe("");
  });
});
