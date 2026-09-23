import { describe, it, expect, beforeEach } from "bun:test";
import { tuiState } from "../state";
import {
  createChatViewport,
  resolveViewport,
  scrollDown,
  scrollUp,
  type ChatViewportState,
  type LineMessageIds,
} from "../viewport";
import { renderChatFrame, renderChatMessagesWithMetadata } from "../renderers/chatRenderer";
import { computeLayoutGeometry } from "../layout";
import type { Msg } from "../types";

function idsFor(lines: LineMessageIds, id: string): number[] {
  return lines.flatMap((lineId, index) => lineId === id ? [index] : []);
}

describe("Stable message-anchored TUI viewport", () => {
  beforeEach(() => {
    tuiState.clearMessages();
    tuiState.activeAssistantDraft = null;
    tuiState.activeToolActivity = null;
    tuiState.activeReasoningDraft = null;
  });

  it("keeps the same message and intra-message row when wrapping changes", () => {
    const viewport = createChatViewport();
    let lines: LineMessageIds = [
      "user",
      "assistant",
      "assistant",
      "assistant",
      "tool",
      "tool",
      "tool",
      "tool",
      "assistant-final",
      "assistant-final",
      "assistant-final",
    ];
    const viewportRows = 3;
    resolveViewport(viewport, lines.length, viewportRows);
    scrollUp(viewport, lines.length, viewportRows, lines);

    expect(viewport.anchorMessageId).toBe("tool");
    expect(viewport.anchorRowOffset).toBe(3);

    // The preceding assistant message reflows from 3 rows to 4 rows. The
    // numeric top row changes, but the same intra-message tool row stays visible.
    lines = [
      "user",
      "assistant",
      "assistant",
      "assistant",
      "assistant",
      "tool",
      "tool",
      "tool",
      "tool",
      "assistant-final",
      "assistant-final",
      "assistant-final",
    ];
    const next = resolveViewport(viewport, lines.length, viewportRows, lines);
    expect(next.start).toBe(8);
    expect(viewport.anchorMessageId).toBe("tool");
    expect(viewport.anchorRowOffset).toBe(3);
  });

  it("keeps a detached anchor while stream growth and resize reflow content", () => {
    const viewport: ChatViewportState = {
      ...createChatViewport(),
      followTail: false,
      anchorMessageId: "assistant",
      anchorRowOffset: 1,
      topRow: 3,
    };
    let lines: LineMessageIds = ["user", "assistant", "assistant", "assistant", "tool", "tool", "tool"];
    expect(resolveViewport(viewport, lines.length, 3, lines).start).toBe(2);

    lines = ["user", "assistant", "assistant", "assistant", "assistant", "tool", "tool", "tool", "tool", "tool"];
    expect(resolveViewport(viewport, lines.length, 3, lines).start).toBe(2);
    expect(viewport.anchorMessageId).toBe("assistant");
    expect(viewport.anchorRowOffset).toBe(1);
  });

  it("moves a detached viewport down one row while preserving the new anchor", () => {
    const viewport: ChatViewportState = {
      ...createChatViewport(),
      followTail: false,
      topRow: 2,
      anchorMessageId: "assistant",
      anchorRowOffset: 2,
    };
    const lines: LineMessageIds = [
      "user",
      "assistant",
      "assistant",
      "assistant",
      "tool",
      "tool",
      "tool",
      "assistant-final",
    ];
    const before = resolveViewport(viewport, lines.length, 3, lines);

    scrollDown(viewport, lines.length, 3, lines);

    expect(before.start).toBe(3);
    expect(viewport.topRow).toBe(4);
    expect(viewport.followTail).toBe(false);
    expect(viewport.anchorMessageId).toBe("tool");
    expect(viewport.anchorRowOffset).toBe(0);
    expect(resolveViewport(viewport, lines.length, 3, lines).start).toBe(4);
  });

  it("re-arms follow-tail only after a down-scroll reaches the bottom", () => {
    const viewport: ChatViewportState = {
      ...createChatViewport(),
      followTail: false,
      topRow: 4,
      anchorMessageId: "tool",
      anchorRowOffset: 1,
    };
    const lines: LineMessageIds = [
      "user",
      "assistant",
      "assistant",
      "assistant",
      "tool",
      "tool",
      "tool",
      "assistant-final",
    ];

    scrollDown(viewport, lines.length, 3, lines);

    expect(viewport.followTail).toBe(true);
    expect(viewport.topRow).toBe(0);
    expect(viewport.anchorMessageId).toBeNull();
    expect(viewport.anchorRowOffset).toBe(0);
  });

  it("only follows the tail when the bottom is visible", () => {
    const viewport = createChatViewport();
    const lines: LineMessageIds = ["user", "assistant", "assistant", "assistant", "tool", "tool"];
    resolveViewport(viewport, lines.length, 3, lines);
    expect(viewport.followTail).toBe(true);

    scrollUp(viewport, lines.length, 3, lines);
    expect(viewport.followTail).toBe(false);
    const before = resolveViewport(viewport, lines.length, 3, lines);
    expect(before.followTail).toBe(false);

    // Appending more rows must not re-pin a detached viewport.
    const grown = [...lines, "tool", "tool", "tool"];
    const after = resolveViewport(viewport, grown.length, 3, grown);
    expect(after.followTail).toBe(false);
    expect(viewport.followTail).toBe(false);
  });

  it("preserves a stable anchor when transcript replacement keeps message IDs", () => {
    const original = tuiState.replaceMessages([
      { role: "user", id: "u1", content: "Question" },
      { role: "assistant", id: "a1", content: "First answer row" },
      { role: "assistant", id: "a1", content: "Second answer row" },
      { role: "assistant", id: "a1", content: "Third answer row" },
      { role: "tool", id: "t1", content: "Result" },
    ] as Msg[]);
    expect(original.every((message) => typeof message.id === "string" && message.id)).toBe(true);

    const lines: LineMessageIds = ["u1", "a1", "a1", "a1", "t1", "t1"];
    resolveViewport(tuiState.chatViewport, lines.length, 3, lines);
    scrollUp(tuiState.chatViewport, lines.length, 3, lines);
    expect(tuiState.chatViewport.followTail).toBe(false);
    expect(tuiState.chatViewport.anchorMessageId).toBe("a1");
    expect(tuiState.chatViewport.anchorRowOffset).toBe(1);

    const replacement = tuiState.replaceMessages([
      { role: "user", id: "u1", content: "Question" },
      { role: "assistant", id: "a1", content: "Reflowed first answer row" },
      { role: "assistant", id: "a1", content: "Reflowed second answer row" },
      { role: "assistant", id: "a1", content: "Reflowed third answer row" },
      { role: "tool", id: "t1", content: "Result" },
    ] as Msg[]);
    expect(replacement.map((message) => message.id)).toEqual(["u1", "a1", "a1", "a1", "t1"]);
    expect(tuiState.chatViewport.followTail).toBe(false);
    expect(tuiState.chatViewport.anchorMessageId).toBe("a1");
    expect(tuiState.chatViewport.anchorRowOffset).toBe(1);
  });

  it("resets to follow-tail when transcript replacement drops the active anchor", () => {
    const original = tuiState.replaceMessages([
      { role: "user", id: "u1", content: "Question" },
      { role: "assistant", id: "a1", content: "First answer row" },
      { role: "assistant", id: "a1", content: "Second answer row" },
    ] as Msg[]);
    const lines: LineMessageIds = ["u1", "a1", "a1"];
    resolveViewport(tuiState.chatViewport, lines.length, 2, lines);
    scrollUp(tuiState.chatViewport, lines.length, 2, lines);
    expect(tuiState.chatViewport.followTail).toBe(false);
    expect(tuiState.chatViewport.anchorMessageId).toBe("u1");
    expect(tuiState.chatViewport.anchorRowOffset).toBe(0);

    const replacement = tuiState.replaceMessages([
      { role: "user", id: "u2", content: "Question" },
      { role: "assistant", id: "replacement", content: "Replacement" },
    ] as Msg[]);
    expect(replacement.map((message) => message.id)).toEqual(["u2", "replacement"]);
    expect(tuiState.chatViewport.followTail).toBe(true);
    expect(tuiState.chatViewport.topRow).toBe(0);
    expect(tuiState.chatViewport.anchorMessageId).toBeNull();
    expect(tuiState.chatViewport.anchorRowOffset).toBe(0);
  });

  it("maps every rendered chat row to its transcript message ID", () => {
    const messages = [
      { role: "user", id: "u1", content: "Question" },
      { role: "assistant", id: "a1", content: "Answer" },
      { role: "system", id: "s1", content: "Mode" },
      {
        role: "assistant",
        id: "tc1",
        content: "",
        tool_calls: [{ id: "call1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", id: "tr1", tool_call_id: "call1", name: "read_file", content: JSON.stringify({ exitCode: 0, stdout: "ok" }) },
      { role: "reasoning", id: "r1", content: "Thinking", reasoning: { text: "Thinking", durationMs: 10, collapsed: false, tokens: 0, streaming: false } as any },
    ] as Msg[];

    const rendered = renderChatMessagesWithMetadata(messages, 80, "\x1b[36m");
    expect(rendered.messageIds).toHaveLength(rendered.lines.length);
    for (const id of ["u1", "a1", "s1", "tr1", "r1"]) {
      expect(idsFor(rendered.messageIds, id).length).toBeGreaterThan(0);
    }
  });

  it("keeps live tool activity outside transcript height and mapping", () => {
    tuiState.activeToolActivity = {
      callId: "live-call",
      name: "bash",
      args: {},
      category: "shell",
      actionLabel: "Run",
      target: "pwd",
      startedAt: Date.now(),
      elapsedMs: 1000,
      status: "running",
    };
    try {
      const messages = [
        {
          role: "assistant",
          id: "live-msg",
          content: "",
          tool_calls: [{ id: "live-call", type: "function", function: { name: "bash", arguments: "pwd" } }],
        },
      ] as Msg[];
      const baseline = renderChatFrame(messages, 80, "\x1b[36m");
      tuiState.activeToolActivity = { ...tuiState.activeToolActivity, elapsedMs: 5000, tail: ["progress"] };
      const progressed = renderChatFrame(messages, 80, "\x1b[36m");

      expect(progressed.chat.lines).toEqual(baseline.chat.lines);
      expect(progressed.chat.messageIds).toEqual(baseline.chat.messageIds);
      expect(progressed.activityLines.length).toBeGreaterThan(0);
    } finally {
      tuiState.activeToolActivity = null;
    }
  });

  it("keeps a detached anchor at 52x20 while status and progress update", () => {
    const layout = computeLayoutGeometry(52, 20, 0, 2, 0, true, 1, "");
    const messages = [
      { role: "user", id: "u52", content: "Question" },
      { role: "assistant", id: "a52", content: "First row\nSecond row\nThird row\nFourth row\nFifth row" },
      { role: "tool", id: "t52", content: "Result" },
    ] as Msg[];
    const baseline = renderChatFrame(messages, layout.chatCols, "\x1b[36m");
    tuiState.chatLineMessageIds = baseline.chat.messageIds;
    resolveViewport(tuiState.chatViewport, baseline.chat.lines.length, layout.chatRows, baseline.chat.messageIds);
    scrollUp(tuiState.chatViewport, baseline.chat.lines.length, layout.chatRows, baseline.chat.messageIds);
    const before = {
      followTail: tuiState.chatViewport.followTail,
      anchorMessageId: tuiState.chatViewport.anchorMessageId,
      anchorRowOffset: tuiState.chatViewport.anchorRowOffset,
      topRow: tuiState.chatViewport.topRow,
    };

    tuiState.activeToolActivity = {
      callId: "live-52",
      name: "bash",
      args: {},
      category: "shell",
      actionLabel: "Run",
      target: "pwd",
      startedAt: Date.now(),
      elapsedMs: 1000,
      status: "running",
      tail: ["one", "two"],
    };
    const progressed = renderChatFrame(messages, layout.chatCols, "\x1b[36m");
    const after = resolveViewport(tuiState.chatViewport, progressed.chat.lines.length, layout.chatRows, progressed.chat.messageIds);

    expect(progressed.chat.lines).toEqual(baseline.chat.lines);
    expect(progressed.chat.messageIds).toEqual(baseline.chat.messageIds);
    expect(after.start).toBe(before.topRow);
    expect(tuiState.chatViewport.followTail).toBe(before.followTail);
    expect(tuiState.chatViewport.anchorMessageId).toBe(before.anchorMessageId);
    expect(tuiState.chatViewport.anchorRowOffset).toBe(before.anchorRowOffset);
  });
});
