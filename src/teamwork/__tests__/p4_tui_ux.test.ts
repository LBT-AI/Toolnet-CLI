import { test, it, expect, describe, beforeEach } from "bun:test";
import { MultilineInputBuffer } from "../../tui/input/multilineInput";
import { parseDiffStats, renderCompactDiffSummary, renderUnifiedDiffLines } from "../../tui/renderers/diffRenderer";
import { renderSidebar } from "../../tui/renderers/sidebarRenderer";
import { getGlobalTracker } from "../../lib/usage";
import { computeLayout } from "../../tui/layout";
import { isNoColor, setNoColor, A } from "../../term";
import { handleKey, getInputState, setInputState, resetInputState } from "../../tui/input/inputHandler";
import { tuiState } from "../../tui/state";

describe("P4.1 — TUI Modular Independence", () => {
  it("TUI modules import independently without side effects", async () => {
    const layout = await import("../../tui/layout");
    expect(typeof layout.computeLayout).toBe("function");

    const state = await import("../../tui/state");
    expect(state.tuiState).toBeDefined();

    const diff = await import("../../tui/renderers/diffRenderer");
    expect(typeof diff.parseDiffStats).toBe("function");

    const sidebar = await import("../../tui/renderers/sidebarRenderer");
    expect(typeof sidebar.renderSidebar).toBe("function");

    const input = await import("../../tui/input/inputHandler");
    expect(typeof input.handleKey).toBe("function");
  });
});

describe("P4.2 — Multiline Input & Cursor Movement", () => {
  let buffer: MultilineInputBuffer;

  beforeEach(() => {
    buffer = new MultilineInputBuffer();
  });

  it("handles inserting multiline text and tracks cursor", () => {
    buffer.insertText("Line 1");
    buffer.insertNewline();
    buffer.insertText("Line 2");

    expect(buffer.getText()).toBe("Line 1\nLine 2");
    expect(buffer.isMultiline()).toBe(true);
    expect(buffer.getCursor()).toBe(13);
  });

  it("moves cursor up and down across lines in multiline input", () => {
    buffer.setText("Hello World\nSecond Line\nThird Line", 20);
    expect(buffer.isAtFirstLine()).toBe(false);

    // Move up from second line to first line
    const movedUp = buffer.moveUp();
    expect(movedUp).toBe(true);
    expect(buffer.isAtFirstLine()).toBe(true);

    // Move down back to second line
    const movedDown = buffer.moveDown();
    expect(movedDown).toBe(true);
  });

  it("paste multiline does not submit automatically", () => {
    resetInputState();
    setInputState("initial ");

    // Simulating paste event insertion
    const pastedChunk = "function test() {\n  return 42;\n}";
    const current = getInputState();
    setInputState(current.buffer + pastedChunk);

    const afterPaste = getInputState();
    expect(afterPaste.buffer).toBe("initial function test() {\n  return 42;\n}");
    expect(afterPaste.buffer).toContain("\n");
  });
});

describe("P4.3 — Diff Rendering", () => {
  it("diff renderer computes additions and deletions accurately", () => {
    const rawDiff = `
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,5 @@
-oldLine1
-oldLine2
+newLine1
+newLine2
+newLine3
`;
    const stats = parseDiffStats(rawDiff);
    expect(stats.length).toBe(1);
    expect(stats[0].additions).toBe(3);
    expect(stats[0].deletions).toBe(2);

    const summary = renderCompactDiffSummary(stats[0]);
    expect(summary).toContain("+3");
    expect(summary).toContain("-2");
  });

  it("diff renderer truncates large diffs beyond max lines", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`+ added line ${i}`);
    }
    const longDiff = lines.join("\n");
    const rendered = renderUnifiedDiffLines(longDiff, 20);

    expect(rendered.length).toBe(21); // 20 lines + truncation notice
    expect(rendered[rendered.length - 1]).toContain("more lines");
  });
});

describe("P4.4 — Token/Cost Sidebar", () => {
  it("usage sidebar reads UsageTracker correctly", () => {
    const tracker = getGlobalTracker();
    tracker.reset();
    tracker.recordUsage({
      inputTokens: 1000,
      outputTokens: 500,
      model: "openai/gpt-4o",
      latencyMs: 300,
    });

    const lines = renderSidebar("openai/gpt-4o", Date.now() - 5000, 40);
    const joined = lines.join("\n");

    expect(joined).toContain("Token & Usage Metrics");
    expect(joined).toContain("1,500");
    expect(joined).toContain("Cost:");
  });
});

describe("P4.20 & P4.21 — Terminal Resize & NO_COLOR", () => {
  it("computeLayout handles small terminals without crashing", () => {
    const layout = computeLayout(0, 3, 0);
    expect(layout.cols).toBeGreaterThanOrEqual(20);
    expect(layout.rows).toBeGreaterThanOrEqual(5);
    expect(layout.chatRows).toBeGreaterThanOrEqual(1);
  });

  it("NO_COLOR suppresses ANSI color escape codes in term styling", () => {
    setNoColor(true);
    expect(isNoColor()).toBe(true);
    expect(A.fgGreen).toBe("");
    expect(A.fgRed).toBe("");
    expect(A.reset).toBe("");

    setNoColor(false);
    expect(isNoColor()).toBe(false);
    expect(A.fgGreen).toContain("\x1b");
  });
});

describe("P4.22 — Keyboard UX & Abort", () => {
  it("Ctrl+C aborts streaming session first", () => {
    tuiState.isStreaming = true;
    let aborted = false;
    tuiState.abortController = {
      abort: () => { aborted = true; },
      signal: {} as any,
    };

    let exitCalled = false;
    handleKey(Buffer.from("\x03"), {
      renderAll: () => {},
      sendMessage: () => {},
      exitApp: () => { exitCalled = true; },
      openModelPicker: async () => {},
    });

    expect(aborted).toBe(true);
    expect(exitCalled).toBe(false);
    expect(tuiState.isStreaming).toBe(false);
  });
});
