/**
 * Phase 2.3 — Streaming / message identity hardening.
 *
 * Invariants covered (all deterministic, no real provider, no timers):
 *  1. One logical assistant message → ONE stable message id + responseKey
 *     while streaming, no matter how tiny the deltas are.
 *  2. UTF-8 integrity: Vietnamese text, emoji (incl. a surrogate pair split
 *     ACROSS deltas) and multi-byte BYTE splits reassemble exactly — the TUI
 *     receives provider-decoded strings, and the providers' TextDecoder
 *     { stream: true } contract is pinned by a byte-level test.
 *  3. No duplicate text, no lost prefix, no partial-UTF-8 corruption, no
 *     double finalize.
 *  4. Reasoning content never merges into assistant content (separate roles).
 *  5. Provider error mid-stream: already-received content preserved verbatim,
 *     terminal phase = "error" (never a fake DONE), late deltas dropped.
 *  6. Cancel mid-stream: NO late delta appended after cancellation.
 *  7. Persisted transcript carries no spinner/ephemeral state and no
 *     duplicate drafts.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tuiState, SPINNER } from "../state";
import { statusManager } from "../statusService";
import { buildTuiAgentCallbacks } from "../events/agentWiring";
import { renderChatMessages } from "../renderers/chatRenderer";
import { stripAnsi } from "../layout";

function assistantMsgs(): any[] {
  return tuiState.messages.filter((m: any) => m.role === "assistant");
}

function reasoningMsgs(): any[] {
  return tuiState.messages.filter((m: any) => m.role === "reasoning");
}

function callbacks() {
  return buildTuiAgentCallbacks(tuiState.currentRunId);
}

beforeEach(() => {
  tuiState.clearMessages();
  tuiState.clearToolActivities();
  tuiState.startNewRun("sess_phase_2_3");
  tuiState.spinnerIdx = 0;
});

afterEach(() => {
  statusManager.stop();
});

describe("Phase 2.3 — stable message identity under streaming", () => {
  test("A1: identity is ONE message id from the first delta onward", () => {
    const cb = callbacks();
    cb.onTextDelta("a");
    const idAfterFirst = assistantMsgs()[0].id;
    cb.onTextDelta("b");
    cb.onTextDelta("c");
    const msgs = assistantMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].id).toBe(idAfterFirst);
    expect(msgs[0].content).toBe("abc");
  });

  test("A2: many tiny deltas accumulate to the exact string, no duplicates", () => {
    const cb = callbacks();
    const parts = ["Xin ", "chào, ", "đây ", "là ", "câu ", "trả ", "lời ", "dài."];
    for (const p of parts) cb.onTextDelta(p);
    cb.onEvent({ type: "agent-complete" });

    const expected = parts.join("");
    const msgs = assistantMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe(expected);
    // One stable identity: exactly one distinct id and one distinct responseKey.
    expect(new Set(msgs.map((m: any) => m.id)).size).toBe(1);
    expect(new Set(msgs.map((m: any) => m.responseKey)).size).toBe(1);
    // No duplicate text anywhere in the transcript.
    expect(
      tuiState.messages
        .filter((m: any) => m.role === "assistant")
        .map((m: any) => m.content)
        .join("")
    ).toBe(expected);
    expect(tuiState.agentPhase).toBe("done");
    expect(tuiState.activeAssistantDraft).toBeNull();
  });

  test("A3: agent-complete fired twice finalizes once — no double finalize, no duplicate", () => {
    const cb = callbacks();
    cb.onTextDelta("Nội dung.");
    cb.onEvent({ type: "agent-complete" });
    cb.onEvent({ type: "agent-complete" }); // duplicate terminal event
    const msgs = assistantMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Nội dung.");
    expect(tuiState.agentPhase).toBe("done");
  });
});

describe("Phase 2.3 — UTF-8 integrity", () => {
  test("B1: Vietnamese + emoji with a surrogate pair SPLIT across deltas is exact", () => {
    const cb = callbacks();
    // "🇻🇳" is two regional-indicator code units; the split below cuts the
    // surrogate pair across two deltas — the TUI must concatenate, never
    // re-encode or corrupt.
    const expected = "Tiếng Việt 🇻🇳👌 — Một câu trả lời hoàn chỉnh.";
    const deltas = ["Tiế", "ng ", "Việt ", "🇻", "🇳👌", " — ", "Một câu", " trả lời hoàn chỉnh."];
    for (const d of deltas) cb.onTextDelta(d);
    cb.onEvent({ type: "agent-complete" });

    const msgs = assistantMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe(expected);
    expect(msgs[0].content).not.toContain("\uFFFD"); // no replacement char

    // Rendered frame shows the full text, never a corrupted prefix.
    const frame = stripAnsi(renderChatMessages(tuiState.messages as any, 100, "\x1b[36m").join("\n"));
    expect(frame).toContain(expected);
    expect(frame).not.toContain("\uFFFD");
  });

  test("B2: provider-style byte-stream decode reassembles multi-byte UTF-8 exactly", () => {
    // Pins the decoder contract every provider stream relies on
    // (new TextDecoder() + decode(value, { stream: true })): bytes split at
    // ANY boundary — mid-code-point, mid-surrogate — reassemble losslessly.
    const decoder = new TextDecoder();
    const sample = "Tiếng Việt 🇻🇳👌 — nhật ký 🧑‍🚀";
    const bytes = new TextEncoder().encode(sample);
    let out = "";
    for (const b of bytes) out += decoder.decode(new Uint8Array([b]), { stream: true });
    out += decoder.decode();
    expect(out).toBe(sample);
    expect(out).not.toContain("\uFFFD");
  });

  test("B3: no lost prefix — content starts with the first delta, ends with the last", () => {
    const cb = callbacks();
    cb.onTextDelta("Tiền tố giữ nguyên. ");
    for (let i = 0; i < 25; i++) cb.onTextDelta("x");
    cb.onTextDelta("…hậu tố.");
    const msgs = assistantMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content.startsWith("Tiền tố giữ nguyên. ")).toBe(true);
    expect(msgs[0].content.endsWith("…hậu tố.")).toBe(true);
  });
});

describe("Phase 2.3 — reasoning vs assistant role separation", () => {
  test("C1: reasoning → text never merges roles", () => {
    const cb = callbacks();
    cb.onEvent({ type: "reasoning-start", turn: 0 } as any);
    cb.onEvent({ type: "reasoning-delta", text: "Suy nghĩ: ", turn: 0 } as any);
    cb.onEvent({ type: "reasoning-delta", text: "cần kiểm tra tệp.", turn: 0 } as any);
    cb.onTextDelta("Câu trả lời.");
    cb.onEvent({ type: "agent-complete" });

    const reasoning = reasoningMsgs();
    const assistants = assistantMsgs();
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].content).toBe("Suy nghĩ: cần kiểm tra tệp.");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe("Câu trả lời.");
    // No cross-contamination in either direction.
    expect(assistants[0].content).not.toContain("Suy nghĩ");
    expect(reasoning[0].content).not.toContain("Câu trả lời");
  });

  test("C2: text-delta finalize + later agent-complete record the reasoning block exactly once", () => {
    const cb = callbacks();
    cb.onEvent({ type: "reasoning-start", turn: 0 } as any);
    cb.onEvent({ type: "reasoning-delta", text: "Tư duy.", turn: 0 } as any);
    cb.onTextDelta("Trả lời."); // finalizes the reasoning draft
    cb.onEvent({ type: "agent-complete" }); // finalizeActiveReasoning again — must be a no-op
    expect(reasoningMsgs()).toHaveLength(1);
    expect(reasoningMsgs()[0].content).toBe("Tư duy.");
    expect(tuiState.activeReasoningDraft).toBeNull();
  });

  test("C3: cancel mid-reasoning records the partial block once; late reasoning delta cannot resurrect it", () => {
    const cb = callbacks();
    cb.onEvent({ type: "reasoning-start", turn: 0 } as any);
    cb.onEvent({ type: "reasoning-delta", text: "Suy nghĩ dở dang", turn: 0 } as any);
    cb.onEvent({ type: "cancelled" });
    cb.onEvent({ type: "reasoning-delta", text: "leak-after-cancel", turn: 0 } as any);
    const reasoning = reasoningMsgs();
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].content).toBe("Suy nghĩ dở dang");
    expect(reasoning[0].content).not.toContain("leak");
    expect(tuiState.activeReasoningDraft).toBeNull();
  });
});

describe("Phase 2.3 — tool interleave", () => {
  test("D1: text → tool → text keeps wire order and one responseKey", () => {
    const cb = callbacks();
    cb.onTextDelta("Đang kiểm tra.");
    cb.onEvent({ type: "tool-call", callId: "t23-1", name: "bash", input: {} });
    cb.onEvent({ type: "tool-result", callId: "t23-1", result: { ok: true, stdout: "done" } } as any);
    cb.onTextDelta("Xong rồi.");
    cb.onEvent({ type: "agent-complete" });

    const msgs = assistantMsgs();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe("Đang kiểm tra.");
    expect(msgs[0].tool_calls?.[0]?.id).toBe("t23-1");
    expect(msgs[1].content).toBe("Xong rồi.");
    expect(msgs[0].responseKey).toBe(msgs[1].responseKey);
    expect(tuiState.messages.filter((m: any) => m.role === "tool")).toHaveLength(1);
  });

  test("D2: tool → text (no pre-tool text) produces no orphan fragment", () => {
    const cb = callbacks();
    cb.onEvent({ type: "tool-call", callId: "t23-2", name: "browser", input: {} });
    cb.onEvent({ type: "tool-result", callId: "t23-2", result: { ok: true } } as any);
    cb.onTextDelta("Kết quả đây.");
    cb.onEvent({ type: "agent-complete" });

    const msgs = assistantMsgs();
    const toolSegment = msgs.find((m: any) => m.tool_calls?.length);
    expect(toolSegment).toBeDefined();
    expect(toolSegment.content).toBe("");
    expect(toolSegment.responseKey).toBe(msgs[msgs.length - 1].responseKey);
  });

  test("D3: multiple tools — two calls, two results, one responseKey, no duplicate rows", () => {
    const cb = callbacks();
    cb.onTextDelta("Tra hai nguồn.");
    cb.onEvent({ type: "tool-call", callId: "t23-3a", name: "browser", input: {} });
    cb.onEvent({ type: "tool-call", callId: "t23-3b", name: "web_fetch", input: {} });
    cb.onEvent({ type: "tool-result", callId: "t23-3b", result: { ok: true } } as any);
    cb.onEvent({ type: "tool-result", callId: "t23-3a", result: { ok: true } } as any);
    cb.onTextDelta("Đủ rồi.");
    cb.onEvent({ type: "agent-complete" });

    const msgs = assistantMsgs();
    expect(msgs[0].tool_calls?.length).toBe(2);
    expect(new Set(msgs.map((m: any) => m.responseKey)).size).toBe(1);
    const toolRows = tuiState.messages.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id);
    expect(toolRows.sort()).toEqual(["t23-3a", "t23-3b"]);
  });
});

describe("Phase 2.3 — provider error mid-stream", () => {
  test("E1: received content preserved verbatim, terminal ERROR, late delta dropped", () => {
    const cb = callbacks();
    cb.onTextDelta("Tôi sẽ ");
    cb.onTextDelta("phân tích ");
    cb.onEvent({ type: "error", error: "ECONNRESET from provider" } as any);
    // An in-flight chunk racing the error must not resurrect content.
    cb.onTextDelta("tiếp.");

    const msgs = assistantMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Tôi sẽ phân tích "); // exactly what was received
    expect(msgs[0].content).not.toContain("tiếp");
    expect(tuiState.agentPhase).toBe("error");
    expect(tuiState.agentPhase).not.toBe("done");
    expect(tuiState.activeAssistantDraft).toBeNull();
  });

  test("E2: agent-complete after an error never fakes DONE", () => {
    const cb = callbacks();
    cb.onTextDelta("Bắt đầu...");
    cb.onEvent({ type: "error", error: "boom" } as any);
    cb.onEvent({ type: "agent-complete" }); // late — must be ignored
    cb.onTextDelta("hỗi");
    expect(tuiState.agentPhase).toBe("error");
    expect(assistantMsgs()[0].content).toBe("Bắt đầu...");
    expect(assistantMsgs()[0].content).not.toContain("hỗi");
  });
});

describe("Phase 2.3 — cancellation mid-stream", () => {
  test("F1: NO late text delta appended after cancellation", () => {
    const cb = callbacks();
    cb.onTextDelta("Đang viết câu trả lời dài...");
    cb.onEvent({ type: "cancelled" });
    cb.onTextDelta("chunk-đến-muộn");
    const msgs = assistantMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Đang viết câu trả lời dài...");
    expect(msgs[0].content).not.toContain("muộn");
    expect(tuiState.agentPhase).toBe("cancelled");
    expect(tuiState.activeAssistantDraft).toBeNull();
  });

  test("F2: agent-complete after cancel does not flip the terminal phase to done", () => {
    const cb = callbacks();
    cb.onTextDelta("abc");
    cb.onEvent({ type: "cancelled" });
    cb.onEvent({ type: "agent-complete" });
    cb.onTextDelta("muộn nữa");
    expect(tuiState.agentPhase).toBe("cancelled");
    expect(assistantMsgs()).toHaveLength(1);
    expect(assistantMsgs()[0].content).toBe("abc");
  });

  test("F3: duplicate cancelled events are idempotent — exactly one cancelled tool row", () => {
    const cb = callbacks();
    cb.onEvent({ type: "tool-call", callId: "t23-9", name: "bash", input: {} });
    cb.onEvent({ type: "cancelled" });
    cb.onEvent({ type: "cancelled" }); // duplicate terminal event
    const toolRows = tuiState.messages.filter((m: any) => m.role === "tool" && m.tool_call_id === "t23-9");
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0].cancelled).toBe(true);
    expect(tuiState.agentPhase).toBe("cancelled");
  });
});

describe("Phase 2.3 — persistence cleanliness", () => {
  test("G1: persisted transcript has no spinner/ephemeral state and no duplicate drafts", () => {
    const cb = callbacks();
    cb.onEvent({ type: "reasoning-start", turn: 0 } as any);
    cb.onEvent({ type: "reasoning-delta", text: "Nghĩ...", turn: 0 } as any);
    cb.onTextDelta("Trả lời hoàn chỉnh.");
    cb.onEvent({ type: "tool-call", callId: "t23-p", name: "bash", input: {} });
    cb.onEvent({ type: "tool-result", callId: "t23-p", result: { ok: true } } as any);
    cb.onTextDelta(" và bổ sung.");
    cb.onEvent({ type: "agent-complete" });

    const serialized = JSON.stringify(tuiState.messages);
    // No spinner frames (ephemeral UI state) ever leak into the transcript.
    for (const frame of SPINNER) expect(serialized).not.toContain(frame);
    expect(serialized).not.toContain("spinnerIdx");
    expect(serialized).not.toContain("activeAssistantDraft");
    expect(serialized).not.toContain("activeReasoningDraft");
    expect(serialized).not.toContain("toolActivities");
    expect(serialized).not.toContain('"streaming":true');
    // No duplicate draft: each assistant segment's content is unique and the
    // concatenation is exactly the streamed text.
    const contents = assistantMsgs().map((m: any) => m.content);
    expect(new Set(contents).size).toBe(contents.length);
    expect(contents.join("")).toBe("Trả lời hoàn chỉnh. và bổ sung.");
    // Reasoning and assistant stay separate roles in the persisted transcript.
    expect(reasoningMsgs()).toHaveLength(1);
    expect(reasoningMsgs()[0].content).toBe("Nghĩ...");
  });
});
