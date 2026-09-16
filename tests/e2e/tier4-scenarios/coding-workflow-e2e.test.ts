import { describe, it, expect } from "bun:test";
import { computeLayoutGeometry, COMPOSER_MAX_BUFFER_LINES } from "../../../src/tui/layout";
import { createChatViewport, resolveViewport, scrollUp, scrollDown, pinToTail } from "../../../src/tui/viewport";
import { createAsyncMutation } from "../../../src/tui/asyncMutation";
import { mapToolToAction } from "../../../src/tui/statusService";

/**
 * A coding turn as the frame math sees it: prompt grows across composer lines,
 * tool runs stream output into the transcript, the palette opens over it, the
 * transcript keeps following the tail, and the finished turn settles.
 */
describe("Tier 4 Scenario: Coding Workflow E2E", () => {
  it("T4.1: a long multi-line prompt keeps its lines through layout at every size", () => {
    const promptLines = ["fix the failing test in", "src/tui/layout.ts, then", "run the suite and report"];
    for (const [cols, rows] of [[120, 40], [100, 30], [80, 24], [60, 20]] as Array<[number, number]>) {
      const geo = computeLayoutGeometry(cols, rows, 0, 2, 12, false, promptLines.length);
      // The composer shows up to the cap; three prompt lines always fit.
      expect(geo.inputRows).toBe(Math.min(COMPOSER_MAX_BUFFER_LINES + 1, promptLines.length + 1));
      expect(geo.chatRows).toBeGreaterThanOrEqual(2);
    }
  });

  it("T4.2: tool activity during the turn maps to human phases without crashing on odd args", () => {
    expect(mapToolToAction("bash", { command: "bun test" })).toBeTypeOf("string");
    expect(mapToolToAction("edit", { path: "src/x.ts" })).toBeTypeOf("string");
    expect(mapToolToAction("grep", undefined)).toBeTypeOf("string");
    expect(mapToolToAction(null as any, null as any)).toBe("Working…");
  });

  it("T4.3: streaming output keeps the viewport pinned to the tail; user scroll wins until repinned", () => {
    const vp = createChatViewport();
    const viewportRows = 12;
    let lines = 0;

    // Simulated stream: chunks append lines, view follows the tail.
    for (let chunk = 0; chunk < 40; chunk++) {
      lines += 1 + (chunk % 3);
      const win = resolveViewport(vp, lines, viewportRows);
      expect(win.end).toBe(lines);
      expect(win.followTail).toBe(true);
    }

    // User scrolls up to inspect an earlier tool result…
    for (let i = 0; i < 5; i++) scrollUp(vp, lines, viewportRows);
    const scrolled = resolveViewport(vp, lines, viewportRows);
    expect(scrolled.followTail).toBe(false);
    expect(scrolled.end).toBeLessThan(lines);

    // …streaming continues (tail-follow stays off)…
    lines += 10;
    const during = resolveViewport(vp, lines, viewportRows);
    expect(during.followTail).toBe(false);

    // …and pinToTail (new submit / Ctrl+End) re-anchors.
    pinToTail(vp);
    const repinned = resolveViewport(vp, lines, viewportRows);
    expect(repinned.followTail).toBe(true);
    expect(repinned.end).toBe(lines);
  });

  it("T4.4: the full turn — prompt, tool runs, palette, finish — ends in a settled state", async () => {
    const geo = computeLayoutGeometry(100, 30, 0, 2, 0, true, 1);
    expect(geo.chatRows).toBeGreaterThan(2);

    // Tool execution as a consequential mutation.
    const toolRun = createAsyncMutation(async (tool: string) => {
      if (tool === "fail") throw new Error("tool failed");
      return `${tool} ok`;
    });

    const run1 = await toolRun.execute("read_file");
    expect(run1).toBe("read_file ok");
    expect(toolRun.state).toBe("success");

    // A failing tool leaves the error visible, not silently swallowed.
    const failed = toolRun.execute("fail");
    await failed.catch(() => undefined);
    expect(toolRun.state).toBe("error");
    expect(toolRun.error?.message).toBe("tool failed");

    // Palette geometry over the finished transcript stays bounded.
    const withPalette = computeLayoutGeometry(100, 30, 8, 2, 0, true, 1);
    expect(withPalette.popupRows).toBeGreaterThan(0);
    expect(withPalette.chatRows).toBeGreaterThanOrEqual(2);
  });
});
