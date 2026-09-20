import { describe, it, expect } from "bun:test";
import { calculateLayoutContract } from "../harness/contractLoaders";
import { VirtualTerminal } from "../harness/virtualTerminal";

describe("Tier 2 Boundary & Corner Cases: Small Terminals & 60x20 Geometry", () => {
  it("B1.1: 60x20 terminal geometry calculates non-negative, usable chat and prompt rows", () => {
    const layout = calculateLayoutContract(60, 20);
    expect(layout.cols).toBe(60);
    expect(layout.rows).toBe(20);
    expect(layout.breakpoint).toBe("small");
    expect(layout.hasPanel).toBe(false);
    expect(layout.panelWidth).toBe(0);
    expect(layout.chatCols).toBe(60);
    expect(layout.chatRows).toBeGreaterThanOrEqual(4);
    expect(layout.inputRows).toBeGreaterThanOrEqual(2);
    expect(layout.cursorRow).toBeLessThan(20);
    expect(layout.cursorCol).toBeLessThan(60);
  });

  it("B1.2: 40x15 minimum boundary clamp prevents negative dimensions or layout collapse", () => {
    const layout = calculateLayoutContract(40, 15);
    expect(layout.cols).toBe(40);
    expect(layout.rows).toBe(15);
    expect(layout.breakpoint).toBe("narrow");
    expect(layout.chatRows).toBeGreaterThan(0);
    expect(layout.inputRows).toBeGreaterThan(0);
    // Caret sits on the composer's prompt line, one row above the footer.
    expect(layout.cursorRow).toBe(13);
  });

  it("B1.3: Sub-minimal screen (25x8) is safely clamped to 40x15 minimum floor", () => {
    const layout = calculateLayoutContract(25, 8);
    expect(layout.cols).toBe(40);
    expect(layout.rows).toBe(15);
    expect(layout.chatRows).toBeGreaterThanOrEqual(2);
    expect(layout.inputRows).toBeGreaterThanOrEqual(2);
  });

  it("B1.4: Prompt squeeze protection on 60x20 with 3-line input preserves chat area", () => {
    // 3 lines of input in 60x20 terminal
    const layout = calculateLayoutContract(60, 20, 3);
    expect(layout.inputRows).toBe(4); // 1 border + 3 lines
    expect(layout.chatRows).toBeGreaterThanOrEqual(2);
    // Last composer line is the row directly above the footer.
    expect(layout.cursorRow).toBe(18);
  });

  it("B1.5: Cursor coordinates remain strictly within terminal bounds across all small geometries", () => {
    const testGeometries = [
      { cols: 60, rows: 20 },
      { cols: 50, rows: 18 },
      { cols: 40, rows: 15 },
      { cols: 65, rows: 22 },
    ];

    for (const geo of testGeometries) {
      const layout = calculateLayoutContract(geo.cols, geo.rows, 2);
      expect(layout.cursorRow).toBeGreaterThanOrEqual(0);
      expect(layout.cursorRow).toBeLessThan(layout.rows);
      expect(layout.cursorCol).toBeGreaterThanOrEqual(0);
      expect(layout.cursorCol).toBeLessThan(layout.cols);
    }
  });

  it("B1.6: VirtualTerminal resize transition from wide (140x40) to 60x20 maintains layout validity", () => {
    const vt = new VirtualTerminal(140, 40);
    vt.activate();
    try {
      const wide = calculateLayoutContract(vt.getDimensions().cols, vt.getDimensions().rows);
      expect(wide.breakpoint).toBe("wide");
      expect(wide.hasPanel).toBe(true);

      vt.resize(60, 20);
      const small = calculateLayoutContract(vt.getDimensions().cols, vt.getDimensions().rows);
      expect(small.breakpoint).toBe("small");
      expect(small.hasPanel).toBe(false);
      expect(small.chatCols).toBe(60);
      expect(small.chatRows).toBeGreaterThan(0);
    } finally {
      vt.restore();
    }
  });
});
