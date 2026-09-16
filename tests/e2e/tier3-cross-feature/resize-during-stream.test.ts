import { describe, it, expect } from "bun:test";
import { computeLayoutGeometry, MIN_COLS, MIN_ROWS, COMPOSER_MAX_BUFFER_LINES } from "../../../src/tui/layout";
import { renderWithErrorBoundary, renderFallbackFrame } from "../../../src/tui/renderers/errorBoundary";
import { tuiState } from "../../../src/tui/state";
import { getPermissionInterruptManager } from "../../../src/tui/permissions/permissionModal";
import stripAnsi from "strip-ansi";

/**
 * Deterministic geometry sweep: resize events land as (cols, rows) pairs and
 * the frame math must stay coherent for every size, including below the clamp
 * floor, mid-stream with popups open, and while an approval modal is queued.
 */
const SIZES: Array<[number, number]> = [
  [120, 40],
  [100, 30],
  [80, 24],
  [60, 20],
  [40, 15], // exactly the clamp floor
  [20, 5], // below the floor: clamped, never negative
];

describe("Tier 3 Cross-Feature: Resize During Stream & Active Modal", () => {
  it("T3.9: geometry stays non-negative and coherent across a full resize sweep", () => {
    for (const [cols, rows] of SIZES) {
      const geo = computeLayoutGeometry(cols, rows, 0, 2, 0, false, 1);
      expect(geo.cols).toBeGreaterThanOrEqual(MIN_COLS);
      expect(geo.rows).toBeGreaterThanOrEqual(MIN_ROWS);
      expect(geo.chatCols).toBeGreaterThan(0);
      expect(geo.chatRows).toBeGreaterThanOrEqual(2);
      expect(geo.inputRows).toBeGreaterThanOrEqual(2);
      expect(geo.cursorRow).toBeLessThan(geo.rows);
      expect(geo.cursorCol).toBeLessThan(geo.cols);
      expect(geo.chatCols + geo.panelWidth).toBe(geo.cols);
    }
  });

  it("T3.10: streaming with a command palette open survives a resize storm", () => {
    for (const [cols, rows] of SIZES) {
      // Palette open + long multi-line prompt mid-stream.
      const geo = computeLayoutGeometry(cols, rows, 12, 2, 8, true, 7);
      expect(geo.popupRows).toBeGreaterThan(0);
      expect(geo.popupRows).toBeLessThan(geo.rows);
      expect(geo.chatRows).toBeGreaterThanOrEqual(2);
      expect(geo.inputRows).toBeLessThanOrEqual(COMPOSER_MAX_BUFFER_LINES + 1);
      // Composer is never squeezed away by the palette or the status row.
      expect(geo.chatRows + geo.popupRows + geo.inputRows).toBeLessThanOrEqual(geo.rows);
    }
  });

  it("T3.11: falling below the clamp floor clamps instead of producing negative geometry", () => {
    const geo = computeLayoutGeometry(10, 4, 0, 2, 0, false, 1);
    expect(geo.cols).toBe(MIN_COLS);
    expect(geo.rows).toBe(MIN_ROWS);
  });

  it("T3.12: a render fault during resize paints the actionable fallback frame at every size", () => {
    const boom = () => {
      throw new Error("render pass faulted mid-resize");
    };
    for (const [cols, rows] of SIZES) {
      const res = renderWithErrorBoundary(boom, cols, rows);
      expect(res.hasError).toBe(true);
      const plain = stripAnsi(res.frame);
      expect(plain).toContain("Render Fault");
      expect(plain).toContain("Ctrl+L");
      // The frame must fit the actual terminal size — no 200-column overflow.
      for (const line of plain.split("\n")) {
        expect(line.length).toBeLessThanOrEqual(Math.max(MIN_COLS, cols));
      }
    }
  });

  it("T3.13: fallback frame is identical for repeated faults at the same size (deterministic repaint)", () => {
    const err = new Error("deterministic fault");
    const a = renderFallbackFrame(err, 80, 24);
    const b = renderFallbackFrame(err, 80, 24);
    expect(a).toBe(b);
  });

  it("T3.14: resize under an active approval modal keeps the queue and dialog intact", () => {
    const manager = getPermissionInterruptManager();
    const before = tuiState.pendingConfirmation;
    const countBefore = manager.pendingCount;

    // Geometry recomputation must not touch modal state.
    for (const [cols, rows] of SIZES) {
      computeLayoutGeometry(cols, rows, 0, 2, 0, false, 1);
    }

    expect(tuiState.pendingConfirmation).toBe(before);
    expect(manager.pendingCount).toBe(countBefore);
  });
});
