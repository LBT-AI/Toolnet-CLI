import { renderB2Banner, b2BannerMetrics, B2_TIMELINE } from "./b2Banner";
import { isNoColor } from "../term";
import { visibleWidth } from "../tui/layout";

export type WordmarkConceptId = "B2";

export interface WordmarkRenderOptions {
  cols: number;
  noColor?: boolean;
}

export interface WordmarkConcept {
  id: WordmarkConceptId;
  name: string;
  rationale: string;
  render(options: WordmarkRenderOptions): string[];
}

export const B2_PALETTE = {
  cyan: "#38BDF8",
  blue: "#60A5FA",
  violet: "#A78BFA",
  muted: "#94A3B8",
} as const;

export const B2_CONCEPT: WordmarkConcept = {
  id: "B2",
  name: "TWIN PORTAL",
  rationale: "Twin network portals converge on a central AI core, paired with a custom angular ToolNet wordmark.",
  render({ cols, noColor = isNoColor() }) {
    return renderB2Banner(Math.max(1, cols), B2_TIMELINE.final, noColor);
  },
};

export const WORDMARK_CONCEPTS: readonly WordmarkConcept[] = [B2_CONCEPT];

export function getWordmarkConcept(id: WordmarkConceptId): WordmarkConcept {
  if (id !== "B2") throw new Error(`Unknown wordmark concept: ${id}`);
  return B2_CONCEPT;
}

export function renderWordmark(id: WordmarkConceptId, options: WordmarkRenderOptions): string[] {
  return getWordmarkConcept(id).render(options);
}

export function wordmarkMetrics(lines: string[]): { width: number; height: number } {
  return {
    width: lines.reduce((max, line) => Math.max(max, visibleWidth(line.trim())), 0),
    height: lines.length,
  };
}

export function wordmarkPlainLines(id: WordmarkConceptId, cols: number): string[] {
  return renderWordmark(id, { cols, noColor: true }).map((line) => line.trimEnd());
}

export function b2Geometry(cols: number): { width: number; height: number; compact: boolean } {
  const metrics = b2BannerMetrics(cols);
  return { ...metrics, compact: cols < 80 };
}
