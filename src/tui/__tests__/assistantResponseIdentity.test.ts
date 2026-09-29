/**
 * Phase 2.1 — Assistant stream fragmentation fix.
 *
 * One semantic assistant response must never fragment into orphan pieces
 * ("T" → tool → "ôi sẽ kiểm tra..."). The transcript keeps the engine's wire
 * order (assistant → tool → assistant), but every generation segment of the
 * SAME response shares a `responseKey`, the renderer shows pre-tool text
 * instead of dropping it, and synthesis content continues the same visual
 * turn. A real user message closes the key: the next assistant text opens a
 * genuinely new response.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { tuiState } from "../state";
import { buildTuiAgentCallbacks } from "../events/agentWiring";
import { renderChatMessages } from "../renderers/chatRenderer";
import { syncTranscriptPreservingReasoning } from "../events/agentWiring";
import { stripAnsi } from "../layout";

function assistantMsgs(): any[] {
  return tuiState.messages.filter((m: any) => m.role === "assistant");
}

function callbacks() {
  return buildTuiAgentCallbacks(tuiState.currentRunId);
}

beforeEach(() => {
  tuiState.clearMessages();
  tuiState.clearToolActivities();
  tuiState.startNewRun("sess_phase_2_1");
});

describe("Phase 2.1 — stable semantic assistant identity", () => {
  test("A: 'T' → tool → 'ôi sẽ kiểm tra...' leaves no orphan fragment", () => {
    const cb = callbacks();
    cb.onTextDelta("T");
    cb.onEvent({ type: "tool-call", callId: "cA1", name: "browser", input: {} });
    cb.onEvent({ type: "tool-result", callId: "cA1", result: { ok: true, stdout: "ok" } } as any);
    cb.onTextDelta("ôi sẽ kiểm tra...");
    cb.onEvent({ type: "agent-complete" });

    const msgs = assistantMsgs();
    // Engine wire order kept: two assistant segments, both under ONE responseKey.
    expect(msgs.length).toBe(2);
    expect(msgs[0].content).toBe("T");
    expect(msgs[0].tool_calls?.[0]?.id).toBe("cA1");
    expect(msgs[1].content).toBe("ôi sẽ kiểm tra...");
    expect(msgs[0].responseKey).toBe(msgs[1].responseKey);
    // The semantic turn is one identity — exactly one distinct responseKey.
    expect(new Set(msgs.map((m: any) => m.responseKey)).size).toBe(1);

    // Renderer shows BOTH the pre-tool text and the synthesis.
    const frame = stripAnsi(renderChatMessages(tuiState.messages as any, 80, "\x1b[36m").join("\n"));
    expect(frame).toContain("T");
    expect(frame).toContain("ôi sẽ kiểm tra...");
  });

  test("B: 'Tôi ' + 'đang ' → tool → 'kiểm tra...' keeps one identity and full text", () => {
    const cb = callbacks();
    cb.onTextDelta("Tôi ");
    cb.onTextDelta("đang ");
    cb.onEvent({ type: "tool-call", callId: "cB1", name: "browser", input: {} });
    cb.onEvent({ type: "tool-result", callId: "cB1", result: { ok: true } } as any);
    cb.onTextDelta("kiểm tra...");

    const msgs = assistantMsgs();
    expect(msgs.length).toBe(2);
    expect(msgs[0].content).toBe("Tôi đang ");
    expect(msgs[1].content).toBe("kiểm tra...");
    expect(msgs[0].responseKey).toBe(msgs[1].responseKey);
  });

  test("C: tool-only response creates no empty bubble", () => {
    const cb = callbacks();
    cb.onEvent({ type: "tool-call", callId: "cC1", name: "browser", input: {} });
    cb.onEvent({ type: "tool-result", callId: "cC1", result: { ok: true } } as any);
    cb.onTextDelta("Kết quả đây.");

    const msgs = assistantMsgs();
    // One tool-carrying segment (content "") + the synthesis segment.
    const toolSegment = msgs.find((m: any) => m.tool_calls?.length);
    expect(toolSegment).toBeDefined();
    expect(toolSegment.content).toBe("");
    expect(toolSegment.responseKey).toBe(msgs[msgs.length - 1].responseKey);

    // Rendering never paints an EMPTY assistant bubble for the tool segment:
    // it contributes only the tool-start row, no bare '✦' text block.
    const lines = renderChatMessages(tuiState.messages as any, 80, "\x1b[36m").map(stripAnsi);
    const assistantTextRows = lines.filter(
      (line) => line.includes("✦") && line.trim() !== "✦" && !line.includes("Kết quả đây")
    );
    expect(assistantTextRows).toHaveLength(0);
    expect(lines.join("\n")).toContain("Kết quả đây.");
  });

  test("D: multiple tool calls produce no extra fragment", () => {
    const cb = callbacks();
    cb.onTextDelta("Đang tra hai nguồn.");
    cb.onEvent({ type: "tool-call", callId: "cD1", name: "browser", input: {} });
    cb.onEvent({ type: "tool-call", callId: "cD2", name: "web_fetch", input: {} });
    cb.onEvent({ type: "tool-result", callId: "cD2", result: { ok: true } } as any);
    cb.onEvent({ type: "tool-result", callId: "cD1", result: { ok: true } } as any);
    cb.onTextDelta("Xong rồi.");

    const msgs = assistantMsgs();
    expect(msgs.length).toBe(2);
    expect(msgs[0].tool_calls?.length).toBe(2);
    expect(msgs[0].responseKey).toBe(msgs[1].responseKey);
    expect(new Set(msgs.map((m: any) => m.responseKey)).size).toBe(1);
  });

  test("E: tool failure mid-stream keeps text identity", () => {
    const cb = callbacks();
    cb.onTextDelta("Đang chạy kiểm tra...");
    cb.onEvent({ type: "tool-call", callId: "cE1", name: "bash", input: {} });
    cb.onEvent({ type: "tool-error", callId: "cE1", error: "boom" } as any);
    cb.onTextDelta("Công cụ lỗi, tôi thử cách khác.");

    const msgs = assistantMsgs();
    expect(msgs.length).toBe(2);
    expect(msgs[0].content).toBe("Đang chạy kiểm tra...");
    expect(msgs[1].content).toBe("Công cụ lỗi, tôi thử cách khác.");
    expect(msgs[0].responseKey).toBe(msgs[1].responseKey);

    const frame = stripAnsi(renderChatMessages(tuiState.messages as any, 80, "\x1b[36m").join("\n"));
    expect(frame).toContain("Đang chạy kiểm tra...");
    expect(frame).toContain("Công cụ lỗi, tôi thử cách khác.");
  });

  test("F: next user turn opens a NEW responseKey — no cross-turn merge", () => {
    const cb = callbacks();
    cb.onTextDelta("Trả lời turn 1");
    cb.onEvent({ type: "agent-complete" });
    const firstKey = assistantMsgs()[0].responseKey;

    // A real user message closes the streamed response identity.
    tuiState.appendMessage({ role: "user", content: "Câu hỏi tiếp theo" });
    // Phase 2.3: callbacks settle at their run's terminal event (late deltas
    // after cancel/error/complete are dropped), and production builds a fresh
    // set per run — so the next turn gets its own callbacks, exactly like
    // sendMessage does.
    const cb2 = callbacks();
    cb2.onTextDelta("Trả lời turn 2");
    cb2.onEvent({ type: "agent-complete" });

    const msgs = assistantMsgs();
    expect(msgs.length).toBe(2);
    expect(msgs[0].responseKey).toBe(firstKey);
    expect(msgs[1].responseKey).not.toBe(firstKey);
  });

  test("transcript adoption: same responseKey joins segments; different keys never merge (F hard boundary)", () => {
    // Engine shape for two turns: turn1 [assistant("A1", tools), tool, assistant("B1")],
    // turn2 [assistant("A2")]. The TUI holds its streamed view with keys.
    const current = [
      { role: "assistant", id: "a1", content: "A1", responseKey: "k1", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "assistant", id: "a2", content: "B1", responseKey: "k1" },
      { role: "assistant", id: "a3", content: "A2", responseKey: "k2" },
    ];
    const engine = [
      { role: "assistant", content: "A1", tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", name: "bash", content: "{}" },
      { role: "assistant", content: "B1" },
      { role: "assistant", content: "A2" },
    ];
    const merged = syncTranscriptPreservingReasoning(current, engine) as any[];
    const assistants = merged.filter((m) => m.role === "assistant");
    // Wire segmentation is preserved (assistant → tool → assistant stays
    // replayable); semantic continuation is expressed by responseKey, which
    // the renderer uses to group the segments into ONE visual turn.
    expect(assistants).toHaveLength(3);
    expect(assistants[0].content).toContain("A1");
    expect(assistants[0].tool_calls?.length).toBe(1); // engine's tool_calls joined, not duplicated
    expect(assistants[1].content).toContain("B1");
    expect(assistants[1].responseKey).toBe(assistants[0].responseKey);
    // HARD boundary: the k2 turn is never pulled into the k1 key.
    expect(assistants[2].responseKey).not.toBe(assistants[0].responseKey);
    expect(assistants[2].content).not.toContain("A1");
    expect(assistants[2].content).not.toContain("B1");
  });

  test("replaceMessages backfills responseKey per contiguous assistant block", () => {
    tuiState.replaceMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "one" } as any,
      { role: "assistant", content: "two" } as any,
      { role: "user", content: "again" },
      { role: "assistant", content: "three" } as any,
    ] as any);
    const msgs = tuiState.messages;
    expect(msgs[1].responseKey).toBe(msgs[2].responseKey);
    expect(msgs[4].responseKey).not.toBe(msgs[1].responseKey);
  });
});
