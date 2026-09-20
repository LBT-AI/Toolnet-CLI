import { describe, it, expect } from "bun:test";
import { calculateLayoutContract } from "../harness/contractLoaders";
import { VirtualTerminal } from "../harness/virtualTerminal";

describe("Tier 1 Feature Coverage: Responsive Layout & Dynamic Breakpoints", () => {
  it("F14.1: Wide breakpoint (>=120 cols) displays sidebar panel with 36 col reservation", () => {
    const layout = calculateLayoutContract(140, 40);
    expect(layout.breakpoint).toBe("wide");
    expect(layout.hasPanel).toBe(true);
    expect(layout.panelWidth).toBe(36);
    expect(layout.chatCols).toBe(140 - 36);
  });

  it("F14.2: Normal breakpoint (80-119 cols) collapses sidebar panel and gives full width to chat", () => {
    const layout = calculateLayoutContract(100, 30);
    expect(layout.breakpoint).toBe("normal");
    expect(layout.hasPanel).toBe(false);
    expect(layout.panelWidth).toBe(0);
    expect(layout.chatCols).toBe(100);
  });

  it("F14.3: Small breakpoint (60-79 cols, e.g. 60x20) collapses panel and maintains positive chat rows", () => {
    const layout = calculateLayoutContract(60, 20);
    expect(layout.breakpoint).toBe("small");
    expect(layout.hasPanel).toBe(false);
    expect(layout.chatCols).toBe(60);
    expect(layout.chatRows).toBeGreaterThan(0);
    expect(layout.inputRows).toBeGreaterThanOrEqual(2);
  });

  it("F14.4: Narrow breakpoint (<60 cols) clamps to minimum safe dimensions without throwing", () => {
    const layout = calculateLayoutContract(45, 18);
    expect(layout.breakpoint).toBe("narrow");
    expect(layout.hasPanel).toBe(false);
    expect(layout.chatCols).toBe(45);
    expect(layout.chatRows).toBeGreaterThan(0);
  });

  it("F15.1: Dynamic input row sizing allocates rows based on multiline input buffer lines", () => {
    const singleLine = calculateLayoutContract(80, 24, 1);
    const multiLine = calculateLayoutContract(80, 24, 4);
    expect(multiLine.inputRows).toBeGreaterThan(singleLine.inputRows);
    expect(singleLine.inputRows).toBe(2);
    expect(multiLine.inputRows).toBe(5);
  });

  it("F16.1: Prompt squeeze protection guarantees minimum prompt row allocation on small screens", () => {
    // Under tight height (e.g. 15 rows), prompt must retain at least 2 rows
    const layout = calculateLayoutContract(60, 15, 1, 0);
    expect(layout.inputRows).toBeGreaterThanOrEqual(2);
    expect(layout.chatRows).toBeGreaterThanOrEqual(2);
    // Caret rides the composer prompt line, directly above the footer.
    expect(layout.cursorRow).toBe(15 - 2);
  });

  it("F18.1: VirtualTerminal emulates resize and recalculates responsive layout cleanly", () => {
    const vt = new VirtualTerminal(120, 30);
    vt.activate();
    try {
      let layout = calculateLayoutContract(vt.getDimensions().cols, vt.getDimensions().rows);
      expect(layout.breakpoint).toBe("wide");
      expect(layout.hasPanel).toBe(true);

      vt.resize(70, 22);
      layout = calculateLayoutContract(vt.getDimensions().cols, vt.getDimensions().rows);
      expect(layout.breakpoint).toBe("small");
      expect(layout.hasPanel).toBe(false);
    } finally {
      vt.restore();
    }
  });
});
