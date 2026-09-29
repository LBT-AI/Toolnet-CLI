/**
 * Phase 2.4 — Streaming + Live Activity ACCEPTANCE MATRIX.
 *
 * Closes Phase 2: one deterministic integration matrix re-driving the SAME
 * handlers the TUI uses (buildTuiAgentCallbacks) through state + renderers,
 * at three terminal sizes. 17 scenarios, numbered to match
 * docs/phase-2-4-streaming-acceptance.md. No real provider, no timers.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tuiState, SPINNER, type ActiveToolActivity } from "../state";
import { statusManager } from "../statusService";
import { buildTuiAgentCallbacks } from "../events/agentWiring";
import {
  renderChatMessages,
  renderToolActivities,
  renderActiveToolActivity,
  currentSpinnerFrame,
} from "../renderers/chatRenderer";
import { stripAnsi, visibleWidth } from "../layout";

const PRIMARY = "\x1b[36m";

function s(lines: string[]): string {
  return lines.map(stripAnsi).join("\n");
}

function stripAnsiSafe(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

function assistantMsgs(): any[] {
  return tuiState.messages.filter((m: any) => m.role === "assistant");
}

function callbacks() {
  return buildTuiAgentCallbacks(tuiState.currentRunId);
}

function makeActivity(overrides: Partial<ActiveToolActivity> = {}): ActiveToolActivity {
  return {
    callId: "acc-1",
    name: "web_fetch",
    args: { url: "https://example.com/feed" },
    category: "read",
    actionLabel: "Fetch",
    target: "https://example.com/feed",
    startedAt: 0,
    elapsedMs: 5000,
    status: "running",
    tail: [],
    ...overrides,
  };
}

beforeEach(() => {
  tuiState.clearMessages();
  tuiState.clearToolActivities();
  tuiState.startNewRun("sess_phase_2_4");
  tuiState.spinnerIdx = 0;
});

afterEach(() => {
  statusManager.stop();
});

describe("Phase 2.4 — acceptance matrix (streaming + live activity)", () => {
  test("1. 'T' fragment regression", () => {
    const cb = callbacks();
    cb.onTextDelta("T");
    cb.onEvent({ type: "tool-call", callId: "m1", name: "bash", input: {} });
    cb.onEvent({ type: "tool-result", callId: "m1", result: { ok: true } } as any);
    cb.onTextDelta("ôi sẽ kiểm tra ngay.");
    cb.onEvent({ type: "agent-complete" });

    const msgs = assistantMsgs();
    expect(msgs.length).toBe(2);
    expect(msgs[0].content).toBe("T"); // pre-tool prefix SURVIVES (was dropped pre-2.1)
    expect(msgs[1].content).toBe("ôi sẽ kiểm tra ngay.");
    expect(msgs[0].responseKey).toBe(msgs[1].responseKey); // ONE identity
    const frame = s(renderChatMessages(tuiState.messages as any, 80, PRIMARY));
    expect(frame).toContain("ôi sẽ kiểm tra ngay.");
  });

  test("2. text → tool → text", () => {
    const cb = callbacks();
    cb.onTextDelta("Đang kiểm tra. ");
    cb.onEvent({ type: "tool-call", callId: "m2", name: "bash", input: { command: "bun test" } });
    cb.onEvent({ type: "tool-result", callId: "m2", result: { ok: true, stdout: "done" } } as any);
    cb.onTextDelta("Xong rồi.");
    cb.onEvent({ type: "agent-complete" });

    const msgs = assistantMsgs();
    expect(msgs.length).toBe(2);
    expect(msgs[0].content + msgs[1].content).toBe("Đang kiểm tra. Xong rồi.");
    expect(new Set(msgs.map((m: any) => m.responseKey)).size).toBe(1);
    expect(tuiState.messages.filter((m: any) => m.role === "tool")).toHaveLength(1);
  });

  test("3. tool-only", () => {
    const cb = callbacks();
    cb.onEvent({ type: "tool-call", callId: "m3", name: "browser", input: {} });
    cb.onEvent({ type: "tool-result", callId: "m3", result: { ok: true } } as any);
    cb.onEvent({ type: "agent-complete" });

    const toolSegment = assistantMsgs().find((m: any) => m.tool_calls?.length);
    expect(toolSegment).toBeDefined();
    expect(toolSegment.content).toBe(""); // no orphan text invented
    // No empty assistant bubble painted.
    const lines = s(renderChatMessages(tuiState.messages as any, 80, PRIMARY)).split("\n");
    const emptyBubbles = lines.filter((l) => l.includes("✦") && l.replace(/[^\p{L}\p{N}]/gu, "").trim() === "✦");
    expect(emptyBubbles).toHaveLength(0);
  });

  test("4. multiple tools", () => {
    const cb = callbacks();
    cb.onTextDelta("Tra hai nguồn.");
    cb.onEvent({ type: "tool-call", callId: "m4a", name: "browser", input: {} });
    cb.onEvent({ type: "tool-call", callId: "m4b", name: "web_fetch", input: {} });
    cb.onEvent({ type: "tool-result", callId: "m4b", result: { ok: true } } as any);
    cb.onEvent({ type: "tool-result", callId: "m4a", result: { ok: true } } as any); // out of order
    cb.onTextDelta("Đủ rồi.");
    cb.onEvent({ type: "agent-complete" });

    const msgs = assistantMsgs();
    expect(msgs[0].tool_calls?.length).toBe(2);
    expect(new Set(msgs.map((m: any) => m.responseKey)).size).toBe(1);
    const toolIds = tuiState.messages
      .filter((m: any) => m.role === "tool")
      .map((m: any) => m.tool_call_id)
      .sort();
    expect(toolIds).toEqual(["m4a", "m4b"]); // each settled exactly once
  });

  test("5. silent Fetch spinner (no progress events, animated frame)", () => {
    const a = makeActivity({ elapsedMs: 8000, tail: [] });
    const rows = renderToolActivities([a], 80, 3).map(stripAnsiSafe);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]).toContain(currentSpinnerFrame(3)); // ANIMATED, not static ●
    expect(rows[0]).not.toContain("●");
    expect(rows[0]).toContain("Fetch https://example.com/feed");
    expect(rows[0]).toContain("8s");
  });

  test("6. silent Run spinner (shell command)", () => {
    const a = makeActivity({
      callId: "acc-run",
      name: "bash",
      args: { command: "bun test src/tui" },
      category: "shell",
      actionLabel: "Run",
      target: "bun test src/tui",
      elapsedMs: 16_000,
      tail: [],
    });
    const rows = renderToolActivities([a], 80, 5).map(stripAnsiSafe);
    expect(rows[0]).toContain(currentSpinnerFrame(5));
    expect(rows[0]).toContain("Run bun test src/tui");
    expect(rows[0]).toContain("16s");
  });

  test("7. tool progress tail (bounded, width-safe, no ms)", () => {
    const a = makeActivity({
      elapsedMs: 9400,
      tail: ["Resolving https://example.com", "GET /feed → 200", "Reading body…", "Decoding UTF-8"],
    });
    const rows = renderActiveToolActivity(a, 80).map(stripAnsiSafe);
    expect(rows[0]).toContain("9s");
    expect(rows[0]).not.toMatch(/\d+\.\d+s/);
    const tailRows = rows.slice(1);
    expect(tailRows).toHaveLength(3); // bounded tail (max 3 on wide cols)
    expect(tailRows[2]).toContain("Decoding UTF-8"); // NEWEST tail kept
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(80);
  });

  test("8. success cleanup — tool-result closes the activity; overlay vanishes; transcript stays clean", () => {
    const cb = callbacks();
    cb.onEvent({ type: "tool-call", callId: "m8", name: "web_fetch", input: { url: "https://example.com" } });
    cb.onEvent({ type: "tool-progress", callId: "m8", elapsedMs: 3000, tail: ["GET / → 200"] } as any);
    expect(tuiState.findToolActivity("m8")?.status).toBe("running");
    cb.onEvent({ type: "tool-result", callId: "m8", result: { ok: true } } as any);
    // Cleanup = the activity is REMOVED from the live map → overlay is empty.
    expect(tuiState.findToolActivity("m8")).toBeUndefined();
    expect(renderToolActivities(tuiState.getActiveToolActivities(), 80)).toHaveLength(0);
    // Transcript keeps the RESULT (role "tool"), never the ephemeral activity.
    const rows = tuiState.messages.filter((m: any) => m.role === "tool" && m.tool_call_id === "m8");
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(tuiState.messages);
    for (const frame of SPINNER) expect(serialized).not.toContain(frame);
    expect(serialized).not.toContain("elapsedMs\":");
  });

  test("9. error cleanup — errored activity leaves the live overlay; cancelled rows too", () => {
    const err = makeActivity({ callId: "m9e", status: "error" });
    const done = makeActivity({ callId: "m9d", status: "completed" });
    const cancelled = makeActivity({ callId: "m9c", status: "cancelled" });
    const running = makeActivity({ callId: "m9r" });
    const rows = renderToolActivities([err, done, cancelled, running], 80);
    expect(rows).toHaveLength(1); // ONLY the still-running one paints
    expect(s(rows)).not.toContain("m9e");
    expect(s(rows)).not.toContain("m9c");
  });

  test("10. cancel cleanup — cancelled event closes every activity and leaves ONE row per tool", () => {
    const cb = callbacks();
    cb.onEvent({ type: "tool-call", callId: "m10a", name: "bash", input: {} });
    cb.onEvent({ type: "tool-call", callId: "m10b", name: "web_fetch", input: {} });
    cb.onEvent({ type: "cancelled" });
    // Cleanup = ALL activities removed from the live map → overlay is empty.
    expect(tuiState.findToolActivity("m10a")).toBeUndefined();
    expect(tuiState.findToolActivity("m10b")).toBeUndefined();
    expect(renderToolActivities(tuiState.getActiveToolActivities(), 80)).toHaveLength(0);
    const rows = tuiState.messages.filter((m: any) => m.role === "tool");
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.cancelled).toBe(true);
    expect(tuiState.agentPhase).toBe("cancelled");
  });

  test("11. UTF-8 Vietnamese", () => {
    const cb = callbacks();
    const text = "Trả lời bằng tiếng Việt: có, không và cảm ơn bạn rất nhiều.";
    for (const d of ["Trả lời ", "bằng tiếng ", "Việt: có, ", "không và ", "cảm ơn bạn ", "rất nhiều."]) cb.onTextDelta(d);
    cb.onEvent({ type: "agent-complete" });
    expect(assistantMsgs()).toHaveLength(1);
    expect(assistantMsgs()[0].content).toBe(text);
    expect(assistantMsgs()[0].content).not.toContain("\uFFFD");
    expect(s(renderChatMessages(tuiState.messages as any, 80, PRIMARY))).toContain(text);
  });

  test("12. emoji / multi-byte split across deltas", () => {
    const cb = callbacks();
    // 🇻🇳 surrogate pair SPLIT across deltas; 👌 also multi-byte.
    for (const d of ["Xin chào ", "🇻", "🇳👌", " Việt"]) cb.onTextDelta(d);
    cb.onEvent({ type: "agent-complete" });
    const msgs = assistantMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Xin chào 🇻🇳👌 Việt");
    expect(msgs[0].content).not.toContain("\uFFFD");
    expect(s(renderChatMessages(tuiState.messages as any, 80, PRIMARY))).toContain("Xin chào 🇻🇳👌 Việt");
  });

  test("13. provider error mid-stream — content preserved, terminal ERROR, no fake DONE", () => {
    const cb = callbacks();
    cb.onTextDelta("Tôi sẽ phân tích ");
    cb.onEvent({ type: "error", error: "ECONNRESET from provider" } as any);
    cb.onTextDelta("tiếp."); // late in-flight chunk must be dropped
    const msgs = assistantMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Tôi sẽ phân tích ");
    expect(msgs[0].content).not.toContain("tiếp");
    expect(tuiState.agentPhase).toBe("error");
    expect(tuiState.agentPhase).not.toBe("done");
    expect(tuiState.activeAssistantDraft).toBeNull();
  });

  test("14. cancel mid-stream — NO late delta appended", () => {
    const cb = callbacks();
    cb.onTextDelta("Đang viết câu trả lời dài...");
    cb.onEvent({ type: "cancelled" });
    cb.onTextDelta("chunk-đến-muộn");
    const msgs = assistantMsgs();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Đang viết câu trả lời dài...");
    expect(msgs[0].content).not.toContain("muộn");
    expect(tuiState.agentPhase).toBe("cancelled");
  });

  const SIZES: Array<[number, number]> = [
    [52, 20],
    [80, 24],
    [120, 30],
  ];

  for (const [cols, rows20] of SIZES) {
    test(`${15 + SIZES.findIndex(([c]) => c === cols)}. frame ${cols}x${rows20} — streaming + live activity, no overflow, UTF-8 intact`, () => {
      const cb = callbacks();
      cb.onEvent({ type: "reasoning-start", turn: 0 } as any);
      cb.onEvent({ type: "reasoning-delta", text: "Đang suy nghĩ về cây đỏ.", turn: 0 } as any);
      cb.onTextDelta("Kết quả: Tiếng Việt 🇻🇳👌 hoàn chỉnh.");
      cb.onEvent({ type: "tool-call", callId: `m-${cols}`, name: "web_fetch", input: { url: "https://example.com/feed" } });
      cb.onEvent({ type: "tool-progress", callId: `m-${cols}`, elapsedMs: 7000, tail: ["GET /feed → 200"] } as any);

      // Chat transcript fits the width at this size.
      const chat = renderChatMessages(tuiState.messages as any, cols, PRIMARY);
      for (const line of chat) expect(visibleWidth(line)).toBeLessThanOrEqual(cols);
      const chatText = s(chat);
      expect(chatText).toContain("🇻🇳👌"); // emoji survives every size

      // Live activity overlay fits and animates at this size.
      const activity = tuiState.findToolActivity(`m-${cols}`)!;
      const overlay = renderToolActivities([activity], cols, 2).map(stripAnsiSafe);
      expect(overlay.length).toBeGreaterThanOrEqual(1);
      for (const row of overlay) expect(visibleWidth(row)).toBeLessThanOrEqual(cols);
      expect(overlay[0]).toContain(currentSpinnerFrame(2));
      expect(overlay[0]).toContain("7s");

      // Silent variant (empty tail) also paints and fits.
      const silent = renderActiveToolActivity({ ...activity, tail: [] }, cols, 4).map(stripAnsiSafe);
      expect(silent.length).toBeGreaterThanOrEqual(1);
      for (const row of silent) expect(visibleWidth(row)).toBeLessThanOrEqual(cols);
    });
  }
});
