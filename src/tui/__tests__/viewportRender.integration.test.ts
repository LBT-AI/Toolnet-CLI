import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { buildFrame } from "../app";
import { tuiState } from "../state";
import { createChatViewport, pinToTail, resolveViewport, scrollUp, type LineMessageIds } from "../viewport";
import { computeLayoutGeometry } from "../layout";
import { handleKey, resetInputState } from "../input/inputHandler";
import { messageQueue } from "../../lib/messageQueue";
import type { Msg } from "../types";

/**
 * Frame-level viewport regression — drives the REAL `buildFrame()` byte stream
 * (the exact string flushed to the terminal) and replays it through a minimal
 * VT row tracker, so assertions are about what is actually painted, not about
 * an intermediate model.
 *
 * Root causes locked here:
 *  1. The live tool-activity overlay used to be interleaved in the linear paint
 *     stream with a trailing CRLF, so the composer divider, footer and status
 *     row landed at a row that depended on how many progress lines were shown —
 *     the whole bottom chrome shook while a tool ran. It is now an absolute
 *     overlay that never advances the linear cursor.
 *  2. Finishing a turn must not pin the viewport to the bottom while the user is
 *     reading history.
 *  3. A detached anchor must survive reflow (never degrade to a raw row).
 */

// ── Minimal VT row tracker ─────────────────────────────────────────────────
function paint(frame: string, cols: number, rows: number): string[] {
  const grid: string[][] = Array.from({ length: rows }, () => new Array(cols).fill(" "));
  let row = 0;
  let col = 0;
  let i = 0;

  while (i < frame.length) {
    const ch = frame[i];
    if (ch === "\x1b") {
      if (frame[i + 1] !== "[") {
        i += 2;
        continue;
      }
      let j = i + 2;
      let params = "";
      while (j < frame.length && !(frame[j] >= "@" && frame[j] <= "~")) {
        params += frame[j];
        j += 1;
      }
      const final = frame[j];
      j += 1;
      if (final === "H") {
        const [rr, cc] = params.split(";");
        const r = rr ? parseInt(rr, 10) : 1;
        const c = cc ? parseInt(cc, 10) : 1;
        row = Math.max(0, Math.min(rows - 1, r - 1));
        col = Math.max(0, Math.min(cols - 1, c - 1));
      } else if (final === "J") {
        const p = params === "" ? 0 : parseInt(params, 10);
        if (p === 0) {
          for (let c = col; c < cols; c++) grid[row][c] = " ";
          for (let r = row + 1; r < rows; r++) grid[r] = new Array(cols).fill(" ");
        } else if (p === 2 || p === 3) {
          for (let r = 0; r < rows; r++) grid[r] = new Array(cols).fill(" ");
          row = 0;
          col = 0;
        }
      } else if (final === "K") {
        const p = params === "" ? 0 : parseInt(params, 10);
        if (p === 0) for (let c = col; c < cols; c++) grid[row][c] = " ";
        else if (p === 2) grid[row] = new Array(cols).fill(" ");
        else if (p === 1) for (let c = 0; c <= col; c++) grid[row][c] = " ";
      }
      i = j;
      continue;
    }
    if (ch === "\r") {
      col = 0;
      i += 1;
      continue;
    }
    if (ch === "\n") {
      // A frame never issues a bare LF at the bottom row (that would scroll the
      // alt screen); the ledger guarantees the footer is last with no newline.
      if (row < rows - 1) row += 1;
      i += 1;
      continue;
    }
    const cp = frame.codePointAt(i)!;
    if (col < cols) grid[row][col] = String.fromCodePoint(cp);
    col += 1;
    i += cp > 0xffff ? 2 : 1;
  }

  return grid.map((r) => r.join("").replace(/\s+$/, ""));
}

function rowsMatching(lines: string[], predicate: (line: string) => boolean): number[] {
  return lines.flatMap((line, index) => (predicate(line) ? [index] : []));
}

function composerDividerRow(lines: string[], cols: number): number {
  // The last full-width rule is the composer divider (the header rule is the
  // first). Rules are pure box-drawing dashes.
  const hits = rowsMatching(lines, (line) => line.replace(/─/g, "").trim() === "" && line.includes("─"));
  return hits[hits.length - 1] ?? -1;
}

function footerRow(lines: string[]): number {
  const hits = rowsMatching(lines, (line) => line.includes(" · "));
  return hits[hits.length - 1] ?? -1;
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const SIZE_52x20 = { cols: 52, rows: 20 };
const SIZE_80x24 = { cols: 80, rows: 24 };

function setSize(size: { cols: number; rows: number }): void {
  (process.stdout as any).columns = size.cols;
  (process.stdout as any).rows = size.rows;
}

function transcript(count: number): Msg[] {
  const messages: Msg[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({ role: "user", id: `u${i}`, content: `Question ${i}` } as Msg);
    messages.push({ role: "assistant", id: `a${i}`, content: `Answer ${i} first row\nAnswer ${i} second row` } as Msg);
  }
  return messages;
}

function expectedLayout(cols: number, rows: number, statusActive: boolean) {
  return computeLayoutGeometry(cols, rows, 0, 2, tuiState.cursorPos, statusActive, 1, "");
}

function frameLines(): string[] {
  const statusActive = tuiState.showHelp || tuiState.isStreaming || Boolean(tuiState.statusText) || messageQueue.size() > 0;
  const layout = expectedLayout((process.stdout as any).columns, (process.stdout as any).rows, statusActive);
  return paint(buildFrame(), layout.cols, layout.rows);
}

/** Chat rows that can never be covered by the tool-activity overlay. */
function safeChatRange(composerRow: number, activityLines: number): [number, number] {
  const start = 2; // header occupies rows 0..1
  const end = Math.max(start, composerRow - activityLines); // exclusive
  return [start, end];
}

describe("TUI frame viewport — scroll & chrome stability", () => {
  beforeEach(() => {
    resetInputState();
    tuiState.clearMessages();
    tuiState.chatViewport = createChatViewport();
    tuiState.activeAssistantDraft = null;
    tuiState.activeToolActivity = null;
    tuiState.activeReasoningDraft = null;
    tuiState.reasoningText = "";
    tuiState.reasoningCollapsed = false;
    tuiState.isStreaming = false;
    tuiState.statusText = "";
    tuiState.elapsedDisplay = "";
    tuiState.spinnerIdx = 0;
    tuiState.inputBuffer = "";
    tuiState.cursorPos = 0;
    setSize(SIZE_52x20);
  });

  afterEach(() => {
    tuiState.activeToolActivity = null;
    tuiState.isStreaming = false;
    tuiState.statusText = "";
    tuiState.clearMessages();
    setSize(SIZE_80x24);
  });

  it("keeps the composer divider and footer at their ledger rows while tool progress updates (52x20)", () => {
    tuiState.replaceMessages(transcript(8));
    tuiState.isStreaming = true;
    tuiState.statusText = "Running command…";
    tuiState.activeToolActivity = {
      callId: "c1", name: "bash", args: {}, category: "shell", actionLabel: "Running",
      target: "bun test", startedAt: Date.now(), elapsedMs: 0, status: "running", tail: [],
    };

    const layout = expectedLayout(52, 20, true);

    const tails: string[][] = [[], ["progress one"], ["line one", "line two", "line three"]];
    const dividerRows: number[] = [];
    const footerRows: number[] = [];

    for (const tail of tails) {
      tuiState.activeToolActivity.tail = tail;
      tuiState.spinnerIdx = (tuiState.spinnerIdx + 1) % 10;
      tuiState.activeToolActivity.elapsedMs += 250;
      const lines = frameLines();
      dividerRows.push(composerDividerRow(lines, layout.cols));
      footerRows.push(footerRow(lines));
    }

    // The bug: adding a progress line shifted these rows by one.
    expect(new Set(dividerRows).size).toBe(1);
    expect(new Set(footerRows).size).toBe(1);
    expect(dividerRows[0]).toBe(layout.composerRow);
    expect(footerRows[0]).toBe(layout.footerRow);
  });

  it("never paints the activity overlay on the composer row or below (52x20)", () => {
    tuiState.replaceMessages(transcript(8));
    tuiState.isStreaming = true;
    tuiState.statusText = "Running command…";
    tuiState.activeToolActivity = {
      callId: "c1", name: "bash", args: {}, category: "shell", actionLabel: "Running",
      target: "bun test", startedAt: Date.now(), elapsedMs: 1000, status: "running",
      tail: ["line one", "line two", "line three"],
    };

    const layout = expectedLayout(52, 20, true);
    const lines = frameLines();

    expect(composerDividerRow(lines, layout.cols)).toBe(layout.composerRow);
    expect(footerRow(lines)).toBe(layout.footerRow);
    // Nothing below the composer divider except the composer prompt + footer.
    for (let r = layout.composerRow + 1; r < layout.rows; r++) {
      expect(lines[r] ?? "").not.toContain("Running");
    }
  });

  it("follows the tail when the user is at the bottom and new output arrives", () => {
    tuiState.replaceMessages(transcript(8));
    tuiState.isStreaming = true;
    tuiState.statusText = "Streaming response…";

    frameLines();
    expect(tuiState.chatViewport.followTail).toBe(true);

    // New streamed content at the bottom.
    const before = expectedLayout(52, 20, true);
    tuiState.appendMessage({ role: "assistant", id: "a-new", content: "Freshly streamed tail line" } as Msg);
    const lines = frameLines();

    expect(tuiState.chatViewport.followTail).toBe(true);
    const visible = lines.slice(2, 2 + before.chatRows).join("\n");
    expect(visible).toContain("Freshly streamed tail line");
  });

  it("scroll up enters history mode and spinner/progress/streaming never move the window", () => {
    tuiState.replaceMessages(transcript(10));
    tuiState.isStreaming = true;
    tuiState.statusText = "Streaming response…";
    tuiState.activeToolActivity = {
      callId: "c1", name: "bash", args: {}, category: "shell", actionLabel: "Running",
      target: "bun test", startedAt: Date.now(), elapsedMs: 0, status: "running", tail: [],
    };

    frameLines(); // populate chatRows + chatLineMessageIds

    // Scroll up a few rows into history.
    for (let i = 0; i < 4; i++) handleKey(Buffer.from("\x1b[A"), { renderAll: () => {} });
    expect(tuiState.chatViewport.followTail).toBe(false);

    const layout = expectedLayout(52, 20, true);
    const [safeStart, safeEnd] = safeChatRange(layout.composerRow, 3);
    const baselineViewport = { ...tuiState.chatViewport };
    const baselineLines = frameLines();
    const baselineChat = baselineLines.slice(safeStart, safeEnd);

    for (let tick = 0; tick < 12; tick++) {
      tuiState.spinnerIdx = (tuiState.spinnerIdx + 1) % 10;
      tuiState.statusText = `Working step ${tick}`;
      tuiState.activeToolActivity.elapsedMs += 200;
      tuiState.activeToolActivity.tail = tick % 2 === 0 ? ["progress"] : ["progress", "more"];
      // Continuous streaming output arriving BELOW the anchor.
      tuiState.appendMessage({ role: "assistant", id: `stream-${tick}`, content: `Streamed chunk ${tick}` } as Msg);

      const lines = frameLines();
      expect(tuiState.chatViewport.followTail).toBe(false);
      expect(tuiState.chatViewport.topRow).toBe(baselineViewport.topRow);
      expect(tuiState.chatViewport.anchorMessageId).toBe(baselineViewport.anchorMessageId);
      expect(tuiState.chatViewport.anchorRowOffset).toBe(baselineViewport.anchorRowOffset);
      // Rows the user is reading are byte-identical across every background update.
      expect(lines.slice(safeStart, safeEnd)).toEqual(baselineChat);
    }
  });

  it("scroll down moves toward the bottom and reaching the bottom edge resumes follow", () => {
    tuiState.replaceMessages(transcript(10));
    frameLines();
    for (let i = 0; i < 4; i++) handleKey(Buffer.from("\x1b[A"), { renderAll: () => {} });
    const topBefore = tuiState.chatViewport.topRow;
    expect(tuiState.chatViewport.followTail).toBe(false);

    handleKey(Buffer.from("\x1b[B"), { renderAll: () => {} });
    expect(tuiState.chatViewport.followTail).toBe(false);
    expect(tuiState.chatViewport.topRow).toBe(topBefore + 1);

    // Keep scrolling down until the bottom edge is reached.
    for (let i = 0; i < 200 && !tuiState.chatViewport.followTail; i++) {
      handleKey(Buffer.from("\x1b[B"), { renderAll: () => {} });
      frameLines();
    }
    expect(tuiState.chatViewport.followTail).toBe(true);
    expect(tuiState.chatViewport.anchorMessageId).toBeNull();
  });

  it("submitting a new prompt re-arms follow even from history mode", () => {
    tuiState.replaceMessages(transcript(10));
    frameLines();
    for (let i = 0; i < 4; i++) handleKey(Buffer.from("\x1b[A"), { renderAll: () => {} });
    expect(tuiState.chatViewport.followTail).toBe(false);

    // This is exactly what sendMessage() does on submit.
    pinToTail(tuiState.chatViewport);
    expect(tuiState.chatViewport.followTail).toBe(true);
    expect(tuiState.chatViewport.topRow).toBe(0);
    expect(tuiState.chatViewport.anchorMessageId).toBeNull();
  });

  it("keeps the message anchor when the terminal is resized while reading history", () => {
    tuiState.replaceMessages(transcript(10));
    frameLines();
    for (let i = 0; i < 5; i++) handleKey(Buffer.from("\x1b[A"), { renderAll: () => {} });

    const anchor = tuiState.chatViewport.anchorMessageId;
    const offset = tuiState.chatViewport.anchorRowOffset;
    expect(anchor).not.toBeNull();
    expect(tuiState.chatViewport.followTail).toBe(false);

    // Resize (mobile path): reflow must keep the same message/row in view.
    setSize(SIZE_80x24);
    const lines = frameLines();
    const layout = expectedLayout(80, 24, false);

    expect(tuiState.chatViewport.anchorMessageId).toBe(anchor);
    expect(tuiState.chatViewport.anchorRowOffset).toBe(offset);
    expect(tuiState.chatViewport.followTail).toBe(false);

    const windowIds = tuiState.chatLineMessageIds.slice(
      tuiState.chatViewport.topRow,
      tuiState.chatViewport.topRow + layout.chatRows,
    ) as LineMessageIds;
    expect(windowIds).toContain(anchor);
    // And the frame still has exactly one composer divider + footer.
    expect(composerDividerRow(lines, layout.cols)).toBe(layout.composerRow);
    expect(footerRow(lines)).toBe(layout.footerRow);
  });

  it("anchors to the nearest real message when the scrolled row carries no message id", () => {
    // A row with no owner id is a separator/reasoning row. The old code degraded
    // the anchor to a RAW row there, so the next reflow jumped the viewport.
    const viewport = createChatViewport();
    const viewportRows = 3;
    const lines: LineMessageIds = ["u1", "a1", "a1", null, null, "a2", "a2", "a2"];
    resolveViewport(viewport, lines.length, viewportRows, lines);

    scrollUp(viewport, lines.length, viewportRows, lines); // top row lands on a null-id row
    expect(viewport.followTail).toBe(false);
    expect(viewport.anchorMessageId).not.toBeNull();
    expect(viewport.anchorMessageId).toBe("a2");
    expect(viewport.topRow).toBe(4);

    // A message above the anchor reflows (gains a row): the anchor row must
    // follow the message, not stay at the stale raw row 4.
    const reflowed: LineMessageIds = ["u1", "a1", "a1", "a1", null, null, "a2", "a2", "a2"];
    resolveViewport(viewport, reflowed.length, viewportRows, reflowed);
    expect(viewport.anchorMessageId).toBe("a2");
    expect(viewport.topRow).toBe(6);
  });
});
