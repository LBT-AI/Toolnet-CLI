import { describe, it, expect } from "bun:test";
import {
  createChatViewport,
  resolveViewport,
  scrollUp,
  scrollDown,
  pinToTail,
} from "../../../src/tui/viewport";

describe("Tier 2 Boundary & Corner Cases: Transcript Stress & Virtual Viewport", () => {
  it("B4.1: Deep transcript with 10,000 lines resolves bounded window without NaN or overflow", () => {
    const vp = createChatViewport();
    const viewportHeight = 24;
    const totalLines = 10_000;

    const window = resolveViewport(vp, totalLines, viewportHeight);
    expect(window.start).toBe(totalLines - viewportHeight);
    expect(window.end).toBe(totalLines);
    expect(window.followTail).toBe(true);
    expect(Number.isInteger(window.start)).toBe(true);
    expect(Number.isInteger(window.end)).toBe(true);
  });

  it("B4.2: Zero lines transcript resolves safely without negative or out-of-bounds start", () => {
    const vp = createChatViewport();
    const window = resolveViewport(vp, 0, 20);

    expect(window.start).toBe(0);
    expect(window.end).toBe(0);
    expect(window.followTail).toBe(true);
  });

  it("B4.3: High-frequency streaming: 200 consecutive token appends keep view pinned to tail", () => {
    const vp = createChatViewport();
    const viewportHeight = 18;

    let currentLines = 0;
    for (let chunk = 0; chunk < 200; chunk++) {
      currentLines += Math.floor(Math.random() * 3) + 1; // 1 to 3 lines per chunk
      const window = resolveViewport(vp, currentLines, viewportHeight);
      const expectedStart = Math.max(0, currentLines - viewportHeight);
      expect(window.start).toBe(expectedStart);
      expect(window.end).toBe(currentLines);
    }
  });

  it("B4.4: Rapid alternating scroll oscillations maintain valid clamped row indices", () => {
    const vp = createChatViewport();
    const viewportHeight = 15;
    const totalLines = 200;

    resolveViewport(vp, totalLines, viewportHeight);

    // Rapid oscillations
    for (let i = 0; i < 50; i++) {
      scrollUp(vp, totalLines, viewportHeight);
      const w1 = resolveViewport(vp, totalLines, viewportHeight);
      expect(w1.start).toBeGreaterThanOrEqual(0);
      expect(w1.end).toBeLessThanOrEqual(totalLines);

      scrollDown(vp, totalLines, viewportHeight);
      const w2 = resolveViewport(vp, totalLines, viewportHeight);
      expect(w2.start).toBeGreaterThanOrEqual(0);
      expect(w2.end).toBeLessThanOrEqual(totalLines);
    }
  });

  it("B4.5: Extreme tool output truncation (50,000 lines) computes exact omitted line count", () => {
    function computeTruncationSummary(lineCount: number, visibleLines = 4): string {
      if (lineCount <= visibleLines) return "";
      const omitted = lineCount - visibleLines;
      return `… (${omitted} more lines)`;
    }

    expect(computeTruncationSummary(50_000, 4)).toBe("… (49996 more lines)");
    expect(computeTruncationSummary(10, 4)).toBe("… (6 more lines)");
    expect(computeTruncationSummary(4, 4)).toBe("");
  });
});
