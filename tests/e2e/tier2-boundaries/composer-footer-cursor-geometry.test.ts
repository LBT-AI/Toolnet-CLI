import { describe, it, expect } from "bun:test";
import {
  computeLayoutGeometry,
  HEADER_ROWS,
  FOOTER_ROWS,
  PROMPT_PREFIX_CELLS,
  MIN_COLS,
  MIN_ROWS,
} from "../../../src/tui/layout";

/**
 * Vertical ledger regression (mobile SSH screenshot defect): the composer was
 * reserved once in the chrome budget and subtracted again from the transcript,
 * so the painted frame was shorter than the grid and the caret — positioned
 * from the raw terminal height — landed on a phantom row below the footer.
 *
 * The invariant now: every region is counted exactly once and
 *   header + chat + popup + status + composer + footer === terminal rows
 * with the caret derived from the SAME composer geometry.
 */

const SIZES: Array<[number, number]> = [
  [120, 40],
  [100, 30],
  [80, 24],
  [60, 20],
  // Narrow mobile-SSH-ish geometry (screenshot class)
  [52, 24],
  [40, 15],
];

function paintedRows(...regions: number[]): number {
  return regions.reduce((a, b) => a + b, 0);
}

describe("Composer/footer/caret vertical geometry — one ledger, one caret owner", () => {
  it("G1.1: ledger is exact at every target size (each region reserved exactly once)", () => {
    for (const [cols, rows] of SIZES) {
      for (const statusActive of [false, true]) {
        const geo = computeLayoutGeometry(cols, rows, 0, 2, 0, statusActive, 1, "xin ha");
        const painted = paintedRows(
          HEADER_ROWS,
          geo.chatRows,
          geo.popupRows,
          geo.statusRows,
          geo.inputRows,
          FOOTER_ROWS
        );
        expect(geo.statusRows).toBe(statusActive ? 1 : 0);
        expect(painted).toBe(geo.rows);
      }
    }
  });

  it("G1.2: footer occupies the final grid row — nothing may render below it", () => {
    for (const [cols, rows] of SIZES) {
      const geo = computeLayoutGeometry(cols, rows, 0, 2, 0, false, 1, "");
      expect(geo.footerRow).toBe(rows - 1);
    }
  });

  it("G1.3: one-line composer sits immediately above the footer (divider above, prompt below)", () => {
    for (const [cols, rows] of SIZES) {
      const geo = computeLayoutGeometry(cols, rows, 0, 2, 0, false, 1, "xin ha");
      expect(geo.inputRows).toBe(2); // divider + one prompt line
      expect(geo.composerRow).toBe(rows - 1 - geo.inputRows);
      expect(geo.composerRow + 1).toBe(geo.footerRow - 1);
    }
  });

  it("G1.4: caret is ON the composer prompt row, never on the footer or below it", () => {
    for (const [cols, rows] of SIZES) {
      const geo = computeLayoutGeometry(cols, rows, 0, 2, 6, false, 1, "xin ha");
      expect(geo.cursorRow).toBe(geo.footerRow - 1);
      expect(geo.cursorRow).toBeLessThan(geo.footerRow);
    }
  });

  it("G1.5: caret column follows the typed content — '> xin ha█' puts the caret after the a", () => {
    // "> " prefix (2 cells) + "xin ha" (6 cells) → caret on 0-based col 8
    // (the emit layer converts to the 1-based terminal CUP column 9).
    const geo = computeLayoutGeometry(80, 24, 0, 2, 6, false, 1, "xin ha");
    expect(geo.cursorCol).toBe(PROMPT_PREFIX_CELLS + 6);
    expect(geo.cursorRow).toBe(22);
  });

  it("G1.6: empty composer caret sits right after '> '", () => {
    const geo = computeLayoutGeometry(80, 24, 0, 2, 0, false, 1, "");
    expect(geo.cursorRow).toBe(geo.footerRow - 1);
    expect(geo.cursorCol).toBe(PROMPT_PREFIX_CELLS);
  });

  it("G1.7: multi-line caret maps onto the correct visible composer line", () => {
    const buf = "line one\nline two\nline three";
    // Caret at end of buffer → last line, after 10 more cells.
    const end = computeLayoutGeometry(80, 24, 0, 2, buf.length, false, 3, buf);
    expect(end.inputRows).toBe(4); // divider + 3 lines
    expect(end.cursorRow).toBe(end.footerRow - 1);
    expect(end.cursorCol).toBe(PROMPT_PREFIX_CELLS + "line three".length);

    // Caret at offset 13 ("line one\n" + 4) → line 1, col 4 ("line").
    const mid = computeLayoutGeometry(80, 24, 0, 2, 13, false, 3, buf);
    expect(mid.cursorRow).toBe(mid.footerRow - 2);
    expect(mid.cursorCol).toBe(PROMPT_PREFIX_CELLS + 4);
  });

  it("G1.8: over-long buffers clamp to the shared composer budget and keep the caret inside it", () => {
    const buf = ["l1", "l2", "l3", "l4", "l5", "l6", "l7"].join("\n");
    const geo = computeLayoutGeometry(80, 24, 0, 2, buf.length, false, 7, buf);
    expect(geo.inputRows).toBeLessThanOrEqual(6);
    expect(geo.cursorRow).toBe(geo.footerRow - 1);
    const painted = paintedRows(HEADER_ROWS, geo.chatRows, geo.popupRows, geo.statusRows, geo.inputRows, FOOTER_ROWS);
    expect(painted).toBe(geo.rows);
  });

  it("G1.9: status-active layout takes its row from the transcript, chrome stays bottom-anchored", () => {
    const idle = computeLayoutGeometry(60, 20, 0, 2, 0, false, 1, "");
    const active = computeLayoutGeometry(60, 20, 0, 2, 0, true, 1, "");
    expect(active.statusRows).toBe(1);
    // Bottom-anchored chrome does not move; the status row shrinks chatRows.
    expect(active.footerRow).toBe(idle.footerRow);
    expect(active.composerRow).toBe(idle.composerRow);
    expect(active.cursorRow).toBe(idle.cursorRow);
    expect(active.chatRows).toBe(idle.chatRows - 1);
    const painted = paintedRows(HEADER_ROWS, active.chatRows, active.popupRows, active.statusRows, active.inputRows, FOOTER_ROWS);
    expect(painted).toBe(active.rows);
  });

  it("G1.10: suggestion popup never shifts the caret below the footer and keeps the ledger exact", () => {
    for (const [cols, rows] of SIZES) {
      const geo = computeLayoutGeometry(cols, rows, 8, 2, 3, true, 1, "/co");
      const painted = paintedRows(HEADER_ROWS, geo.chatRows, geo.popupRows, geo.statusRows, geo.inputRows, FOOTER_ROWS);
      expect(painted).toBe(geo.rows);
      expect(geo.cursorRow).toBeLessThan(geo.footerRow);
      expect(geo.chatRows).toBeGreaterThanOrEqual(2);
    }
  });

  it("G1.11: resize preserves the composer/footer/caret relationship", () => {
    const seq: Array<[number, number]> = [[120, 40], [60, 20], [100, 30], [52, 24]];
    for (const [cols, rows] of seq) {
      const geo = computeLayoutGeometry(cols, rows, 0, 2, 6, false, 1, "xin ha");
      expect(geo.footerRow).toBe(rows - 1);
      expect(geo.cursorRow).toBe(geo.footerRow - 1);
      expect(geo.composerRow).toBe(rows - 1 - geo.inputRows);
      const painted = paintedRows(HEADER_ROWS, geo.chatRows, geo.popupRows, geo.statusRows, geo.inputRows, FOOTER_ROWS);
      expect(painted).toBe(rows);
    }
  });

  it("G1.12: CJK/emoji input counts terminal cells, not codepoints", () => {
    // "你好" = 4 cells for 2 codepoints; caret after it → 0-based col 2 + 4.
    const cjk = computeLayoutGeometry(80, 24, 0, 2, 2, false, 1, "你好");
    expect(cjk.cursorCol).toBe(PROMPT_PREFIX_CELLS + 4);

    // Emoji are double-width too.
    const emoji = computeLayoutGeometry(80, 24, 0, 2, 1, false, 1, "🚀");
    expect(emoji.cursorCol).toBe(PROMPT_PREFIX_CELLS + 2);
  });

  it("G1.13: screenshot regression — 'xin ha' on mobile SSH geometry leaves NO caret row below the footer", () => {
    for (const [cols, rows] of [[52, 24], [60, 20], [40, 15]]) {
      const geo = computeLayoutGeometry(cols, rows, 0, 2, 6, false, 1, "xin ha");
      // Conceptual bottom rows:
      //   row footerRow-1: "> xin ha█"
      //   row footerRow:   "ToolNet Gateway · alims-intl.llm · /root"
      // and NEVER a caret on its own row below the footer.
      expect(geo.cursorRow).toBe(geo.footerRow - 1);
      expect(geo.cursorCol).toBe(PROMPT_PREFIX_CELLS + "xin ha".length);
      expect(geo.footerRow).toBe(rows - 1);
    }
  });

  it("G1.14: minimum envelope stays coherent under the one-ledger invariant", () => {
    const geo = computeLayoutGeometry(10, 4, 0, 2, 0, false, 1, "");
    expect(geo.cols).toBe(MIN_COLS);
    expect(geo.rows).toBe(MIN_ROWS);
    const painted = paintedRows(HEADER_ROWS, geo.chatRows, geo.popupRows, geo.statusRows, geo.inputRows, FOOTER_ROWS);
    expect(painted).toBe(geo.rows);
    expect(geo.chatRows).toBeGreaterThanOrEqual(2);
    expect(geo.cursorRow).toBeLessThan(geo.rows);
  });
});
