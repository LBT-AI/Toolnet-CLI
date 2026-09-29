import { expect, test, describe } from "bun:test";
import { TuiState } from "../state";
import { buildTuiAgentCallbacks } from "../events/agentWiring";

describe("Assistant Tool Interleave Fragmentation", () => {
  test("reproduces the fragment bug across a tool call", () => {
    // 1. start clean TUI state/session/run
    const { tuiState: globalTuiState } = require("../state");
    globalTuiState.clearMessages();
    globalTuiState.clearToolActivities();
    const runId = globalTuiState.startNewRun("sess_test_1");
    
    const callbacks = buildTuiAgentCallbacks(runId);
    
    // 2. emit text delta
    callbacks.onTextDelta("T");
    
    // 3. emit tool call
    callbacks.onEvent({
      type: "tool-call",
      callId: "call-browser-1",
      name: "browser",
      input: { action: "navigate", url: "https://example.com" }
    });
    
    // 4. emit tool result
    callbacks.onEvent({
      type: "tool-result",
      callId: "call-browser-1",
      result: { ok: true, exitCode: 0, stdout: "ok" }
    } as any);
    
    // 5. emit text delta
    callbacks.onTextDelta("ôi sẽ kiểm tra xem...");
    
    // 6. emit agent-complete
    callbacks.onEvent({ type: "agent-complete" });
    
    const msgs = globalTuiState.messages;
    const assistantMsgs = msgs.filter((m: any) => m.role === "assistant");
    
    // BUG REPRODUCTION: The current logic creates two assistant fragments!
    // Expected ideal behavior would be 1 assistant message, but current is >= 2.
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(2);
    
    const msg1 = assistantMsgs[0];
    const msg2 = assistantMsgs[assistantMsgs.length - 1];
    
    // Evidence of the fragmented identity
    expect(msg1.content).toBe("T");
    expect(msg1.tool_calls?.[0]?.id).toBe("call-browser-1");
    expect(msg2.content).toBe("ôi sẽ kiểm tra xem...");
  });

  test("zero-text tool call control case", () => {
    const { tuiState: globalTuiState } = require("../state");
    globalTuiState.clearMessages();
    globalTuiState.clearToolActivities();
    const runId = globalTuiState.startNewRun("sess_test_2");
    
    const callbacks = buildTuiAgentCallbacks(runId);
    
    callbacks.onEvent({
      type: "tool-call",
      callId: "call-browser-2",
      name: "browser",
      input: { action: "navigate" }
    });
    
    const msgs = globalTuiState.messages;
    const assistantMsgs = msgs.filter((m: any) => m.role === "assistant");
    
    expect(assistantMsgs.length).toBe(1);
    expect(assistantMsgs[0].content).toBe("");
    expect(assistantMsgs[0].tool_calls?.[0]?.id).toBe("call-browser-2");
  });

  test("multi-chunk variant", () => {
    const { tuiState: globalTuiState } = require("../state");
    globalTuiState.clearMessages();
    globalTuiState.clearToolActivities();
    const runId = globalTuiState.startNewRun("sess_test_3");
    
    const callbacks = buildTuiAgentCallbacks(runId);
    
    callbacks.onTextDelta("T");
    callbacks.onTextDelta("ôi ");
    callbacks.onTextDelta("sẽ ");
    
    callbacks.onEvent({
      type: "tool-call",
      callId: "call-browser-3",
      name: "browser",
      input: { action: "navigate" }
    });
    
    callbacks.onTextDelta("kiểm tra...");
    
    const msgs = globalTuiState.messages;
    const assistantMsgs = msgs.filter((m: any) => m.role === "assistant");
    
    expect(assistantMsgs.length).toBeGreaterThanOrEqual(2);
    expect(assistantMsgs[0].content).toBe("Tôi sẽ ");
    expect(assistantMsgs[assistantMsgs.length - 1].content).toBe("kiểm tra...");
  });

  test("multiple tool call control", () => {
    const { tuiState: globalTuiState } = require("../state");
    globalTuiState.clearMessages();
    globalTuiState.clearToolActivities();
    const runId = globalTuiState.startNewRun("sess_test_4");
    
    const callbacks = buildTuiAgentCallbacks(runId);
    
    callbacks.onTextDelta("Tôi đang kiểm tra");
    
    callbacks.onEvent({ type: "tool-call", callId: "c_A", name: "browser", input: {} });
    callbacks.onEvent({ type: "tool-call", callId: "c_B", name: "browser", input: {} });
    
    callbacks.onEvent({ type: "tool-result", callId: "c_B", result: { ok: true } } as any);
    callbacks.onEvent({ type: "tool-result", callId: "c_A", result: { ok: true } } as any);
    
    const msgs = globalTuiState.messages;
    const assistantMsgs = msgs.filter((m: any) => m.role === "assistant");
    
    // A single assistant message should hold both tools, NOT fragment further.
    // However, since currentTurnId doesn't advance until after the tools complete
    // AND a new delta arrives, the tools should attach to the existing message.
    expect(assistantMsgs[0].tool_calls?.length).toBe(2);
  });
});
