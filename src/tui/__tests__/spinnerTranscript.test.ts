import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SPINNER, tuiState } from "../state";
import { renderHeader } from "../renderers/headerRenderer";
import { renderWorkingStatus } from "../renderers/statusRenderer";
import { syncTranscriptPreservingReasoning } from "../events/agentWiring";

const SPINNER_GLYPHS = new Set(SPINNER);

function assistantContents(messages: readonly { role: string; content?: string }[]): string[] {
  return messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.content ?? "");
}

describe("spinner transcript isolation", () => {
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

  test("keeps spinner glyphs in transient chrome instead of assistant messages", () => {
    const header = renderHeader(80, {
      agentMode: "Build",
      bypassMode: false,
      bypassLevel: "none",
      isStreaming: true,
      spinnerIdx: 0,
      statusText: "Thinking",
    });
    const status = renderWorkingStatus(80, {
      showHelp: false,
      isStreaming: true,
      spinnerIdx: 1,
      statusText: "Working",
      elapsedDisplay: "1.0s",
      primaryColor: "\x1b[36m",
    });

    expect(header).toContain(SPINNER[0]);
    expect(status).toContain(SPINNER[1]);
    expect(tuiState.messages.map((message) => message.content)).toEqual([]);

    tuiState.appendMessage({ role: "assistant", content: "Tool results are ready." });
    const persisted = syncTranscriptPreservingReasoning(tuiState.messages, tuiState.messages);
    const contents = assistantContents(persisted);

    expect(contents).toEqual(["Tool results are ready."]);
    for (const content of contents) {
      expect(SPINNER_GLYPHS.has(content.trim())).toBe(false);
      expect(content).not.toMatch(/^(?:\/|\|-|\\)$/);
    }
  });

  test("adopts tool results before the final assistant synthesis", () => {
    const current = [
      { role: "user", content: "Inspect the file" },
      { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", name: "read_file", content: JSON.stringify({ stdout: "ok", exitCode: 0 }) },
    ];
    const engine = [
      current[0],
      current[1],
      current[2],
      { role: "assistant", content: "Final synthesis after tool completion." },
    ];

    const transcript = syncTranscriptPreservingReasoning(current, engine as any);
    const contents = assistantContents(transcript);

    expect(transcript.some((message) => message.role === "tool" && message.tool_call_id === "call-1")).toBe(true);
    expect(contents.at(-1)).toBe("Final synthesis after tool completion.");
    expect(contents.some((content) => SPINNER_GLYPHS.has(content.trim()))).toBe(false);
    expect(contents.some((content) => /^(?:\/|\|-|\\)$/.test(content))).toBe(false);
  });
});
