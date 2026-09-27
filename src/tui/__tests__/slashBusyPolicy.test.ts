/**
 * Slash-command busy policy + submit integrity.
 *
 * A command that mutates model/session/runtime must NOT slip through the
 * composer while the agent is busy, and the composer must survive the refusal.
 * Local read-only commands stay available. Exactly one physical Enter maps to
 * exactly one dispatch, and executed commands enter prompt history verbatim.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tuiState } from "../state";
import { handleKey, getInputState, setInputState, resetInputState } from "../input/inputHandler";
import { messageQueue } from "../../lib/messageQueue";

function cb(sent: string[]) {
  return { renderAll: () => {}, sendMessage: (t: string) => sent.push(t) };
}

describe("slash command busy policy", () => {
  beforeEach(() => {
    resetInputState();
    tuiState.appState = "ready";
    tuiState.isStreaming = false;
    tuiState.messages = [];
    tuiState.promptHistory = [];
    tuiState.historyIndex = -1;
    messageQueue.setIsProcessing(false);
  });

  afterEach(() => {
    tuiState.isStreaming = false;
    messageQueue.setIsProcessing(false);
    tuiState.promptHistory = [];
    resetInputState();
  });

  it("refuses an unsafe command while busy and preserves the composer", () => {
    const sent: string[] = [];
    tuiState.isStreaming = true;
    setInputState("/model");
    handleKey(Buffer.from("0d", "hex"), cb(sent));

    expect(sent).toEqual([]);
    expect(getInputState().buffer).toBe("/model");
    expect(tuiState.statusText).toContain("unavailable while the agent");
  });

  it("allows a local read-only command while busy", () => {
    const sent: string[] = [];
    tuiState.isStreaming = true;
    setInputState("/help");
    handleKey(Buffer.from("0d", "hex"), cb(sent));

    expect(sent).toEqual(["/help"]);
    expect(getInputState().buffer).toBe("");
  });

  it("records an executed slash command in history so Up recalls it", () => {
    const sent: string[] = [];
    setInputState("/mcp list");
    handleKey(Buffer.from("0d", "hex"), cb(sent));

    expect(sent).toEqual(["/mcp list"]);
    expect(tuiState.promptHistory.at(-1)).toBe("/mcp list");
  });

  it("maps one Enter on an invalid command to exactly one dispatch", () => {
    const sent: string[] = [];
    setInputState("/mpc");
    handleKey(Buffer.from("0d", "hex"), cb(sent));
    expect(sent).toEqual(["/mpc"]);
  });

  it("does not record a refused command in history", () => {
    const sent: string[] = [];
    tuiState.isStreaming = true;
    setInputState("/compact");
    handleKey(Buffer.from("0d", "hex"), cb(sent));
    expect(sent).toEqual([]);
    expect(tuiState.promptHistory).toEqual([]);
  });
});
