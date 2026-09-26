/**
 * Run output viewer / pager regression suite.
 *
 * A long command run (e.g. `vpsoci`, 378 lines) must not dump its buffer into
 * the main transcript. The chat shows a one-line summary and the full buffer is
 * paged on demand. These tests pin: window math, auto-follow, pause-on-scroll,
 * resume-at-bottom, 52x20 rendering stability, and transcript de-spam.
 */
import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { tuiState, runOutputWindow, type RunOutputViewerState } from "../../tui/state";

// The viewer owns the keyboard while open; leaving it set would swallow keys in
// whatever test file runs next in the same process. Reset after every test.
afterEach(() => {
  tuiState.runOutputViewer = null;
  tuiState.showQueueManager = false;
});
import {
  renderRunOutputViewerBox,
  runOutputViewerPageSize,
} from "../../tui/renderers/runOutputViewerRenderer";
import { renderChatMessages, RUN_OUTPUT_INLINE_MAX_LINES } from "../../tui/renderers/chatRenderer";

const PAGE = 12;
const makeViewer = (overrides: Partial<RunOutputViewerState> = {}): RunOutputViewerState => ({
  callId: "c1",
  title: "Run vpsoci",
  lines: Array.from({ length: 378 }, (_, i) => `line ${i + 1}`),
  offset: 0,
  followTail: true,
  running: true,
  ...overrides,
});

describe("run output window math", () => {
  test("followTail shows the newest lines", () => {
    const w = runOutputWindow(makeViewer(), PAGE);
    expect(w).toEqual({ start: 378 - PAGE, end: 378 });
  });

  test("a fixed offset is clamped to the buffer", () => {
    expect(runOutputWindow(makeViewer({ followTail: false, offset: 0 }), PAGE)).toEqual({ start: 0, end: PAGE });
    expect(runOutputWindow(makeViewer({ followTail: false, offset: 99999 }), PAGE)).toEqual({ start: 378 - PAGE, end: 378 });
  });

  test("buffer shorter than a page does not underflow", () => {
    const small = makeViewer({ lines: ["a", "b"], followTail: false, offset: 0 });
    expect(runOutputWindow(small, PAGE)).toEqual({ start: 0, end: 2 });
  });
});

describe("run output viewer state", () => {
  let stdoutSpy: any;

  beforeEach(() => {
    tuiState.runOutputViewer = null;
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => stdoutSpy.mockRestore());

  test("opens following the tail and closes other modals", () => {
    tuiState.showQueueManager = true;
    tuiState.openRunOutputViewer({ callId: "c1", title: "Run vpsoci", lines: makeViewer().lines, running: true });
    expect(tuiState.showQueueManager).toBe(false);
    expect(tuiState.runOutputViewer?.followTail).toBe(true);
    expect(tuiState.getRunOutputWindow(PAGE)).toEqual({ start: 378 - PAGE, end: 378 });
  });

  test("scrolling up pauses follow; returning to bottom resumes it", () => {
    tuiState.openRunOutputViewer({ callId: "c1", title: "Run vpsoci", lines: makeViewer().lines, running: true });
    tuiState.scrollRunOutputViewer(-1, PAGE);
    expect(tuiState.runOutputViewer?.followTail).toBe(false);
    const w1 = tuiState.getRunOutputWindow(PAGE);
    expect(w1.end).toBe(377);

    tuiState.scrollRunOutputViewer(1, PAGE);
    expect(tuiState.runOutputViewer?.followTail).toBe(true);
    expect(tuiState.getRunOutputWindow(PAGE).end).toBe(378);
  });

  test("page up/down move by a page", () => {
    tuiState.openRunOutputViewer({ callId: "c1", title: "t", lines: makeViewer().lines, running: true });
    tuiState.pageRunOutputViewer(-1, PAGE);
    expect(tuiState.getRunOutputWindow(PAGE)).toEqual({ start: 378 - 2 * PAGE + 1, end: 378 - PAGE + 1 });
  });

  test("top and bottom jumps", () => {
    tuiState.openRunOutputViewer({ callId: "c1", title: "t", lines: makeViewer().lines, running: true });
    tuiState.runOutputViewerToTop();
    expect(tuiState.getRunOutputWindow(PAGE)).toEqual({ start: 0, end: PAGE });
    expect(tuiState.runOutputViewer?.followTail).toBe(false);
    tuiState.runOutputViewerToBottom();
    expect(tuiState.getRunOutputWindow(PAGE)).toEqual({ start: 378 - PAGE, end: 378 });
    expect(tuiState.runOutputViewer?.followTail).toBe(true);
  });

  test("streamed lines are appended and followed", () => {
    tuiState.openRunOutputViewer({ callId: "c1", title: "t", lines: makeViewer({ lines: ["a"] }).lines, running: true });
    tuiState.appendRunOutputLines(["b", "c"]);
    expect(tuiState.runOutputViewer?.lines).toEqual(["a", "b", "c"]);
    expect(tuiState.getRunOutputWindow(PAGE)).toEqual({ start: 0, end: 3 });
  });
});

describe("run output viewer render (52x20)", () => {
  test("shows the range and follow state, and is byte-stable across renders", () => {
    const viewer = makeViewer();
    const rows = renderRunOutputViewerBox(52, 20, viewer);
    const joined = rows.join("");
    expect(joined).toContain(`(367-378 of 378 lines`);
    expect(joined).toContain("following");
    // No jitter: same state → identical frame.
    expect(renderRunOutputViewerBox(52, 20, viewer).join("")).toBe(joined);
  });

  test("paused state is labelled and top range is correct", () => {
    const viewer = makeViewer({ followTail: false, offset: 0 });
    const joined = renderRunOutputViewerBox(52, 20, viewer).join("");
    expect(joined).toContain("(1-12 of 378 lines");
    expect(joined).toContain("paused");
  });

  test("page size matches what the box shows", () => {
    expect(runOutputViewerPageSize(20)).toBe(12);
    const rows = renderRunOutputViewerBox(52, 20, makeViewer({ followTail: false, offset: 0 }));
    // borders top+bottom + 12 body + footer
    expect(rows.length).toBe(2 + 12 + 1);
  });

  test("a freshly-finished command shows no follow label", () => {
    const joined = renderRunOutputViewerBox(52, 20, makeViewer({ running: false })).join("");
    expect(joined).not.toContain("following");
    expect(joined).not.toContain("paused");
  });
});

describe("transcript de-spam", () => {
  test("long tool output becomes ONE summary row with a Ctrl+O hint", () => {
    const stdout = Array.from({ length: 378 }, (_, i) => `line ${i + 1}`).join("\n");
    const messages = [
      { id: "t1", role: "tool", tool_call_id: "c1", name: "shell", content: JSON.stringify({ stdout, exitCode: 0 }) },
    ] as any;
    const rows = renderChatMessages(messages, 52, "");
    const joined = rows.join("\n");
    expect(joined).toContain(`${378} lines · Ctrl+O to view`);
    // 378 line rows would be absurd; the transcript must stay small.
    expect(rows.length).toBeLessThan(20);
  });

  test("short output keeps its inline tail (no viewer hint)", () => {
    const stdout = "one\ntwo\nthree";
    expect(stdout.split("\n").length).toBeLessThanOrEqual(RUN_OUTPUT_INLINE_MAX_LINES);
    const messages = [
      { id: "t2", role: "tool", tool_call_id: "c2", name: "shell", content: JSON.stringify({ stdout, exitCode: 0 }) },
    ] as any;
    const joined = renderChatMessages(messages, 52, "").join("\n");
    expect(joined).not.toContain("Ctrl+O to view");
    expect(joined).toContain("three");
  });

  test("raw ANSI in stored output never reaches the transcript", () => {
    const stdout = "\u001b[31mError\u001b[0m: boom";
    const messages = [
      { id: "t3", role: "tool", tool_call_id: "c3", name: "shell", content: JSON.stringify({ stdout, exitCode: 1 }) },
    ] as any;
    const joined = renderChatMessages(messages, 52, "").join("\n");
    expect(joined).not.toContain("\u001b[31m");
    expect(joined).toContain("boom");
  });
});
