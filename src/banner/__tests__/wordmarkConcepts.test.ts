import { describe, it, expect } from "bun:test";
import { renderWordmark, WORDMARK_CONCEPTS, wordmarkMetrics, wordmarkPlainLines, b2Geometry } from "../wordmarkConcepts";
import { B2_TIMELINE, renderB2Banner, bannerLineWidths } from "../b2Banner";
import { stripAnsi, visibleWidth } from "../../tui/layout";

describe("final B2 Twin Portal banner", () => {
  it("exposes only the selected B2 concept", () => {
    expect(WORDMARK_CONCEPTS.map((concept) => concept.id)).toEqual(["B2"]);
    expect(WORDMARK_CONCEPTS[0].name).toBe("TWIN PORTAL");
  });

  it("renders a recognisable custom symbol and custom TOOLNET lettering", () => {
    const lines = wordmarkPlainLines("B2", 120);
    const text = lines.join("\n");
    expect(text).not.toContain("█");
    expect(text).toContain("◇");
    expect(text).toContain("╭");
    expect(text).toContain("AI CODING CLI");
    expect(text).not.toContain("terminal-native intelligence");
    expect(lines.length).toBe(7);
  });

  it("keeps every static and animation frame within the requested width", () => {
    for (const cols of [40, 50, 60, 80, 120]) {
      for (const elapsed of [0, 180, 400, 600, 760, 1050, 1200]) {
        for (const noColor of [false, true]) {
          const lines = renderB2Banner(cols, elapsed, noColor);
          expect(lines.length).toBeGreaterThan(0);
          expect(lines.every((line) => visibleWidth(line) <= cols)).toBe(true);
          expect(bannerLineWidths(cols, elapsed, noColor)).toEqual(lines.map(visibleWidth));
        }
      }
    }
  });

  it("uses compact four-row geometry below 80 columns", () => {
    for (const cols of [40, 50, 60]) {
      const lines = renderWordmark("B2", { cols, noColor: true });
      expect(lines.length).toBe(4);
      expect(lines.some((line) => stripAnsi(line).includes("◇"))).toBe(true);
      expect(lines.every((line) => visibleWidth(line) <= cols)).toBe(true);
      expect(b2Geometry(cols).compact).toBe(true);
    }
  });

  it("uses the seven-row desktop lockup at 80 and 120 columns", () => {
    for (const cols of [80, 120]) {
      const lines = renderWordmark("B2", { cols, noColor: true });
      expect(lines.length).toBe(7);
      expect(wordmarkMetrics(lines).height).toBe(7);
      expect(lines.every((line) => visibleWidth(line) <= cols)).toBe(true);
      expect(b2Geometry(cols).compact).toBe(false);
    }
  });

  it("keeps ANSI cell-neutral and preserves geometry in NO_COLOR", () => {
    const colored = renderWordmark("B2", { cols: 80, noColor: false });
    const plain = renderWordmark("B2", { cols: 80, noColor: true });
    expect(colored.some((line) => line.includes("\x1b["))).toBe(true);
    expect(colored.map(visibleWidth)).toEqual(plain.map(visibleWidth));
    expect(stripAnsi(plain.join("\n"))).toContain("◇");
  });

  it("uses the requested elapsed-time timeline", () => {
    expect(B2_TIMELINE).toEqual({ core: 180, portal: 400, connections: 600, pulse: 760, wordmark: 1050, final: 1200 });
  });
});


describe("B2 preview geometry", () => {
  it("keeps all requested final metrics bounded", () => {
    for (const cols of [40, 50, 60, 80, 120]) {
      const metrics = b2Geometry(cols);
      expect(metrics.width).toBeLessThanOrEqual(cols);
      expect(metrics.height).toBeGreaterThanOrEqual(4);
      expect(metrics.height).toBeLessThanOrEqual(7);
    }
  });
});
