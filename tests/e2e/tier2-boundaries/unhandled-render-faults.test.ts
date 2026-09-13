import { describe, it, expect } from "bun:test";
import { visibleWidth, padVisible, truncateVisible } from "../harness/contractLoaders";
import { renderWithErrorBoundary } from "../tier1-features/error-boundary.test";

describe("Tier 2 Boundary & Corner Cases: Unhandled Render Faults & Character Integrity", () => {
  it("B5.1: Multi-cell Unicode characters (emojis and CJK) calculate visual width accurately", () => {
    // Emojis typically occupy 2 cells
    const rocket = "🚀";
    expect(visibleWidth(rocket)).toBe(2);

    // CJK characters occupy 2 cells
    const cjk = "代码工具";
    expect(visibleWidth(cjk)).toBe(8);

    // Mixed ascii, emoji, and CJK
    const mixed = "ToolNet 🚀 智能终端";
    // "ToolNet " (8) + "🚀" (2) + " " (1) + "智能终端" (8) = 19
    expect(visibleWidth(mixed)).toBe(19);
  });

  it("B5.2: Malformed or unclosed ANSI escape sequences do not crash visibleWidth or truncateVisible", () => {
    const brokenAnsi1 = "\x1b[31mRed text without close";
    expect(visibleWidth(brokenAnsi1)).toBe(22);

    const brokenAnsi2 = "Text with \x1b[999; malformed escape";
    expect(() => visibleWidth(brokenAnsi2)).not.toThrow();
    expect(() => truncateVisible(brokenAnsi2, 10)).not.toThrow();
  });

  it("B5.3: Negative or zero width constraints in formatting functions clamp safely without exceptions", () => {
    expect(truncateVisible("Hello", 0)).toBe("");
    expect(truncateVisible("Hello", -5)).toBe("");
    expect(padVisible("Hello", 0)).toBe("Hello");
    expect(padVisible("Hello", -10)).toBe("Hello");
  });

  it("B5.4: Null and undefined string edge cases return empty or safe strings", () => {
    expect(visibleWidth(null as any)).toBe(0);
    expect(visibleWidth(undefined as any)).toBe(0);
    expect(truncateVisible(null as any, 10)).toBe("");
    expect(truncateVisible(undefined as any, 10)).toBe("");
  });

  it("B5.5: Corrupted state rendering fault is trapped by error boundary without bubbling up", () => {
    const corruptStateRender = () => {
      const state: any = null;
      return state.messages.map((m: any) => m.text).join("\n");
    };

    const res = renderWithErrorBoundary(corruptStateRender);
    expect(res.hasError).toBe(true);
    expect(res.frame).toContain("⚠️ ToolNet TUI Render Fault Caught");
  });
});
