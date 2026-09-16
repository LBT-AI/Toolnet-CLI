import { describe, it, expect, beforeEach } from "bun:test";
import { tuiState } from "../state";
import { renderReasoningPanel } from "../renderers/reasoningPanel";
import { renderChatMessages } from "../renderers/chatRenderer";
import { renderWorkingStatus } from "../renderers/statusRenderer";
import { syncTranscriptPreservingReasoning } from "../events/agentWiring";
import { stripAnsi, visibleWidth } from "../layout";

describe("Live Reasoning Hotfix — UX and Stream Lifecycle", () => {
  beforeEach(() => {
    tuiState.messages = [];
    tuiState.activeReasoningDraft = null;
    tuiState.reasoningText = "";
    tuiState.reasoningCollapsed = false;
    tuiState.reasoningTokens = 0;
    tuiState.reasoningElapsed = "";
    tuiState.agentPhase = "idle";
    tuiState.startNewRun("sess_test_123");
  });

  it("1. first reasoning chunk becomes visible before tool call", () => {
    tuiState.messages.push({ role: "user", content: "Refactor database module" });

    // Provider emits reasoning chunk #1
    const accepted = tuiState.appendReasoningDelta("Inspecting db schema files...", {
      sessionId: tuiState.currentSessionId,
      runId: tuiState.currentRunId,
      turnId: 0,
    });
    expect(accepted).toBe(true);

    // Active draft exists immediately
    expect(tuiState.activeReasoningDraft).not.toBeNull();
    expect(tuiState.activeReasoningDraft!.text).toBe("Inspecting db schema files...");
    expect(tuiState.activeReasoningDraft!.streaming).toBe(true);

    // Active draft is visible in rendered reasoning panel with "Thinking"
    const lines = renderReasoningPanel(80, {
      text: tuiState.activeReasoningDraft!.text,
      elapsed: "1.2s",
      effort: "auto",
      collapsed: false,
      tokens: 0,
      streaming: true,
    });
    const rendered = stripAnsi(lines.join(""));
    expect(rendered).toContain("Thinking");
    expect(rendered).toContain("1.2s");
    expect(rendered).toContain("Inspecting db schema files...");

    // No tool call has run yet
    expect(tuiState.messages.some((m) => m.role === "tool" || Boolean(m.tool_calls))).toBe(false);
  });

  it("2. multiple reasoning chunks append incrementally", () => {
    tuiState.appendReasoningDelta("Step 1: explore.", {
      sessionId: tuiState.currentSessionId,
      runId: tuiState.currentRunId,
      turnId: 0,
    });
    expect(tuiState.activeReasoningDraft!.text).toBe("Step 1: explore.");

    tuiState.appendReasoningDelta(" Step 2: identify bottleneck.", {
      sessionId: tuiState.currentSessionId,
      runId: tuiState.currentRunId,
      turnId: 0,
    });
    expect(tuiState.activeReasoningDraft!.text).toBe("Step 1: explore. Step 2: identify bottleneck.");

    tuiState.appendReasoningDelta(" Step 3: plan edits.", {
      sessionId: tuiState.currentSessionId,
      runId: tuiState.currentRunId,
      turnId: 0,
    });
    expect(tuiState.activeReasoningDraft!.text).toBe(
      "Step 1: explore. Step 2: identify bottleneck. Step 3: plan edits."
    );
  });

  it("3. reasoning → tool → reasoning produces two correctly ordered blocks", () => {
    tuiState.messages.push({ role: "user", content: "Fix the bug" });

    // Turn 0: Reasoning block 1
    tuiState.appendReasoningDelta("Checking directory layout...", {
      sessionId: tuiState.currentSessionId,
      runId: tuiState.currentRunId,
      turnId: 0,
    });

    // Tool call 1 arrives -> finalizes reasoning block 1
    tuiState.finalizeActiveReasoning("tool-call");
    tuiState.messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_1", type: "function", function: { name: "list_dir", arguments: "{}" } }],
    });
    tuiState.messages.push({
      role: "tool",
      tool_call_id: "call_1",
      name: "list_dir",
      content: JSON.stringify({ stdout: "index.ts\npackage.json", exitCode: 0 }),
    });

    // Turn 1: Reasoning block 2 arrives
    tuiState.currentTurnId = 1;
    tuiState.appendReasoningDelta("Now inspecting package.json...", {
      sessionId: tuiState.currentSessionId,
      runId: tuiState.currentRunId,
      turnId: 1,
    });

    // Tool call 2 arrives -> finalizes reasoning block 2
    tuiState.finalizeActiveReasoning("tool-call");
    tuiState.messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"package.json"}' } }],
    });
    tuiState.messages.push({
      role: "tool",
      tool_call_id: "call_2",
      name: "read_file",
      content: JSON.stringify({ stdout: '{"name": "toolnet"}', exitCode: 0 }),
    });

    // Turn 2: Final answer
    tuiState.messages.push({ role: "assistant", content: "Identified toolnet configuration." });

    // Render entire conversation
    const chatLines = renderChatMessages(tuiState.messages, 80, "\x1b[36m");
    const fullTranscript = stripAnsi(chatLines.join("\n"));

    // Verify ordering: Reasoning 1 -> list_dir -> Reasoning 2 -> read_file -> Final answer
    const posReasoning1 = fullTranscript.indexOf("Checking directory layout...");
    const posTool1 = fullTranscript.search(/list_?dir/i);
    const posReasoning2 = fullTranscript.indexOf("Now inspecting package.json...");
    const posTool2 = fullTranscript.search(/read(_file)?/i);
    const posFinal = fullTranscript.indexOf("Identified toolnet configuration.");

    expect(posReasoning1).toBeGreaterThan(-1);
    expect(posTool1).toBeGreaterThan(posReasoning1);
    expect(posReasoning2).toBeGreaterThan(posTool1);
    expect(posTool2).toBeGreaterThan(posReasoning2);
    expect(posFinal).toBeGreaterThan(posTool2);

    // Verify the two reasoning blocks are distinct
    const reasoningBlocks = tuiState.messages.filter((m) => m.role === "reasoning");
    expect(reasoningBlocks.length).toBe(2);
    expect(reasoningBlocks[0].content).toBe("Checking directory layout...");
    expect(reasoningBlocks[1].content).toBe("Now inspecting package.json...");
  });

  it("4. reasoning does not wait for final response", () => {
    tuiState.messages.push({ role: "user", content: "Explain quantum computing" });

    tuiState.appendReasoningDelta("Breaking down qubits and superposition...", {
      sessionId: tuiState.currentSessionId,
      runId: tuiState.currentRunId,
      turnId: 0,
    });

    // No assistant message exists yet
    expect(tuiState.messages.some((m) => m.role === "assistant")).toBe(false);

    // Active reasoning draft is already available and non-empty
    expect(tuiState.activeReasoningDraft?.text).toBe("Breaking down qubits and superposition...");
    expect(tuiState.activeReasoningDraft?.streaming).toBe(true);
  });

  it("5. delayed-first-reasoning still shows Thinking elapsed state without fabricating text", () => {
    tuiState.agentPhase = "thinking";
    tuiState.isStreaming = true;

    // Status bar displays live Thinking indicator with elapsed duration
    const statusBar = renderWorkingStatus(80, {
      showHelp: false,
      isStreaming: true,
      spinnerIdx: 2,
      statusText: "Thinking…",
      elapsedDisplay: "3.2s",
      primaryColor: "\x1b[36m",
    });
    const strippedStatus = stripAnsi(statusBar);
    expect(strippedStatus).toContain("Thinking…");
    expect(strippedStatus).toContain("3.2s");

    // Reasoning panel produces zero lines when text is empty (never fabricates text)
    const panelLines = renderReasoningPanel(80, {
      text: "",
      elapsed: "3.2s",
      effort: "auto",
      collapsed: false,
      tokens: 0,
      streaming: true,
    });
    expect(panelLines.length).toBe(0);
  });

  it("6. non-reasoning provider shows status only and does not fabricate reasoning", () => {
    tuiState.messages.push({ role: "user", content: "Hi" });
    tuiState.agentPhase = "streaming";

    // Non-reasoning provider emits assistant response directly
    tuiState.messages.push({ role: "assistant", content: "Hello! How can I help?" });

    const chatLines = renderChatMessages(tuiState.messages, 80, "\x1b[36m");
    const fullTranscript = stripAnsi(chatLines.join("\n"));

    expect(fullTranscript).toContain("Hello! How can I help?");
    expect(fullTranscript).not.toContain("Thinking");
    expect(fullTranscript).not.toContain("Thought");
    expect(tuiState.activeReasoningDraft).toBeNull();
    expect(tuiState.messages.some((m) => m.role === "reasoning")).toBe(false);
  });

  it("7. stale-session reasoning is rejected", () => {
    const currentSession = tuiState.currentSessionId;
    const currentRun = tuiState.currentRunId;

    // Delta from another session
    const acceptedStaleSession = tuiState.appendReasoningDelta("Stale chunk from other session", {
      sessionId: "sess_different_999",
      runId: currentRun,
      turnId: 0,
    });
    expect(acceptedStaleSession).toBe(false);
    expect(tuiState.activeReasoningDraft).toBeNull();

    // Delta from an older run
    const acceptedStaleRun = tuiState.appendReasoningDelta("Stale chunk from older run", {
      sessionId: currentSession,
      runId: "run_stale_111",
      turnId: 0,
    });
    expect(acceptedStaleRun).toBe(false);
    expect(tuiState.activeReasoningDraft).toBeNull();
  });

  it("8. cancellation finalizes active reasoning state", () => {
    tuiState.appendReasoningDelta("Thinking about long problem...", {
      sessionId: tuiState.currentSessionId,
      runId: tuiState.currentRunId,
      turnId: 0,
    });
    expect(tuiState.activeReasoningDraft?.streaming).toBe(true);

    // Abort signal triggers cancellation
    const finalized = tuiState.finalizeActiveReasoning("cancelled");
    expect(finalized).not.toBeNull();
    expect(finalized!.streaming).toBe(false);
    expect(finalized!.endedAt).toBeDefined();
    expect(finalized!.durationMs).toBeGreaterThanOrEqual(0);

    // Active draft is cleared, message is recorded
    expect(tuiState.activeReasoningDraft).toBeNull();
    const reasoningMsg = tuiState.messages.find((m) => m.role === "reasoning");
    expect(reasoningMsg).toBeDefined();
    expect(reasoningMsg!.content).toBe("Thinking about long problem...");
  });

  it("9. resize during reasoning does not lose text and maintains safe width", () => {
    tuiState.appendReasoningDelta(
      "Detailed architectural analysis: examining boundary interfaces and event dispatchers.",
      {
        sessionId: tuiState.currentSessionId,
        runId: tuiState.currentRunId,
        turnId: 0,
      }
    );

    const sizes = [120, 80, 60, 40];
    for (const cols of sizes) {
      const lines = renderReasoningPanel(cols, {
        text: tuiState.activeReasoningDraft!.text,
        elapsed: "1.8s",
        effort: "high",
        collapsed: false,
        tokens: 350,
        streaming: true,
      });

      expect(lines.length).toBeGreaterThan(0);
      const joined = stripAnsi(lines.join(""));
      expect(joined).toContain("Thinking");
      expect(joined).toContain("1.8s");
      expect(joined).toContain("Detailed architectural analysis");

      // Verify no line overflows terminal width
      for (const line of lines) {
        expect(visibleWidth(stripAnsi(line).replace(/\r\n/g, ""))).toBeLessThanOrEqual(cols);
      }
    }
  });

  it("10. coalescing of adjacent reasoning start/delta/end micro-cycles", () => {
    // Provider emits start -> delta -> end micro-cycles per token
    tuiState.appendReasoningDelta("Token1 ", {
      sessionId: tuiState.currentSessionId,
      runId: tuiState.currentRunId,
      turnId: 0,
    });
    // Micro-end arrives (end timestamp noted, but block kept open within turn)
    if (tuiState.activeReasoningDraft) {
      tuiState.activeReasoningDraft.endedAt = Date.now();
    }

    // Micro-start and delta for token 2
    tuiState.appendReasoningDelta("Token2 ", {
      sessionId: tuiState.currentSessionId,
      runId: tuiState.currentRunId,
      turnId: 0,
    });
    if (tuiState.activeReasoningDraft) {
      tuiState.activeReasoningDraft.endedAt = Date.now();
    }

    // Micro-start and delta for token 3
    tuiState.appendReasoningDelta("Token3", {
      sessionId: tuiState.currentSessionId,
      runId: tuiState.currentRunId,
      turnId: 0,
    });

    // They must coalesce into ONE block with combined text
    expect(tuiState.activeReasoningDraft!.text).toBe("Token1 Token2 Token3");
    expect(tuiState.messages.filter((m) => m.role === "reasoning").length).toBe(0);

    // Finalize on semantic boundary (e.g. tool call)
    tuiState.finalizeActiveReasoning("tool-call");
    expect(tuiState.messages.filter((m) => m.role === "reasoning").length).toBe(1);
    expect(tuiState.messages[0].content).toBe("Token1 Token2 Token3");
  });

  it("11. syncTranscriptPreservingReasoning retains reasoning blocks across turns", () => {
    const currentMsgs = [
      { role: "user", content: "Run tests" },
      { role: "reasoning", content: "Thinking turn 1", reasoning: { text: "Thinking turn 1", durationMs: 1200 } },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "test_runner", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", name: "test_runner", content: '{"ok":true}' },
      { role: "reasoning", content: "Thinking turn 2", reasoning: { text: "Thinking turn 2", durationMs: 800 } },
      { role: "assistant", content: "All tests passed." },
    ];

    const engineMsgs = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "Run tests" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "test_runner", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", name: "test_runner", content: '{"ok":true}' },
      { role: "assistant", content: "All tests passed." },
    ];

    const synced = syncTranscriptPreservingReasoning(currentMsgs, engineMsgs);

    expect(synced.length).toBe(6);
    expect(synced[0].role).toBe("user");
    expect(synced[1].role).toBe("reasoning");
    expect(synced[1].content).toBe("Thinking turn 1");
    expect(synced[2].role).toBe("assistant");
    expect(synced[2].tool_calls).toBeDefined();
    expect(synced[3].role).toBe("tool");
    expect(synced[4].role).toBe("reasoning");
    expect(synced[4].content).toBe("Thinking turn 2");
    expect(synced[5].role).toBe("assistant");
    expect(synced[5].content).toBe("All tests passed.");
  });
});
