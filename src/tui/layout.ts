import { getSize, A } from "../term";
import stringWidth from "string-width";
import {
  stripAnsi,
  visibleWidth,
  padVisible,
  truncateVisible,
  tailByCells,
} from "../lib/text";

// Canonical cell-math lives in `src/lib/text` so non-TUI code never imports
// from `src/tui`; these re-exports keep the renderers' import paths stable.
export { stripAnsi, visibleWidth, padVisible, truncateVisible, tailByCells };

export const ANSI_REGEX = /\x1b\[[^m]*m/g;

export const HEADER_ROWS = 2;        // Header text + divider
export const INPUT_AREA_ROWS = 2;    // Input divider + input line
export const FOOTER_ROWS = 1;        // Bottom footer line
export const RESERVED = HEADER_ROWS + INPUT_AREA_ROWS + FOOTER_ROWS; // 5



/**
 * Truncate a string to `maxLen` terminal cells. Kept as the existing public
 * alias used by the other renderers.
 */
export function truncate(s: string, maxLen: number): string {
  return truncateVisible(s, maxLen);
}

/** Wrap on words where possible, then break long tokens by terminal cells. */
export function wrapVisible(value: string, width: number): string[] {
  if (width <= 0) return [value];
  if (!value) return [""];

  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/ +/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (visibleWidth(candidate) <= width) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      let remainder = word;
      while (visibleWidth(remainder) > width) {
        // Consume an exact cell-safe prefix so a path is never silently
        // altered while it is being wrapped.
        const prefixWidth = Math.max(1, width);
        let prefix = "";
        let cells = 0;
        for (const cp of Array.from(remainder)) {
          const w = stringWidth(cp);
          if (cells + w > prefixWidth) break;
          prefix += cp;
          cells += w;
        }
        if (!prefix) break;
        lines.push(prefix);
        remainder = remainder.slice(prefix.length);
      }
      line = remainder;
    }
    if (line || lines.length === 0) lines.push(line);
  }
  return lines.length ? lines : [""];
}

export function fillLine(text: string, width: number, fg = A.fgText, bg = A.bgSurface): string {
  const pad = Math.max(0, width - visibleWidth(text));
  return bg + fg + text + " ".repeat(pad) + A.reset;
}

/** Backward-compatible name for terminal-cell-aware wrapping. */
export function wrapText(text: string, width: number): string[] {
  return wrapVisible(text, width);
}

export type TerminalBreakpoint = "wide" | "normal" | "small" | "narrow";

export interface LayoutInfo {
  cols: number;
  rows: number;
  breakpoint: TerminalBreakpoint;
  hasPanel: boolean;
  panelWidth: number;
  chatCols: number;
  chatRows: number;
  /** Terminal rows the prompt composer occupies, including its divider. */
  inputRows: number;
  popupRows: number;
  cursorRow: number;
  cursorCol: number;
}

/** Smallest geometry the frame math stays coherent at. */
export const MIN_COLS = 40;
export const MIN_ROWS = 15;

/**
 * The composer shows at most this many buffer lines; longer drafts scroll
 * inside the composer (statusRenderer trims from the top) instead of eating
 * the transcript. +1 covers the divider line that opens the input area.
 */
export const COMPOSER_MAX_BUFFER_LINES = 5;

function breakpointFor(cols: number): TerminalBreakpoint {
  if (cols >= 120) return "wide";
  if (cols >= 80) return "normal";
  if (cols >= 60) return "small";
  return "narrow";
}

export function computeLayout(
  activeSuggestsCount = 0,
  inputPromptLen = 2,
  cursorPos = 0,
  statusActive = false,
  /** How many lines the composer buffer currently wraps to. */
  inputLineCount = 1,
): LayoutInfo {
  const { cols, rows } = getSize();
  return computeLayoutGeometry(cols, rows, activeSuggestsCount, inputPromptLen, cursorPos, statusActive, inputLineCount);
}

/**
 * Pure geometry math over explicit dimensions — no terminal access. `computeLayout`
 * clamps the live terminal size into the minimum envelope and delegates here so
 * tests and headless tools can evaluate the same layout the frame renders.
 */
export function computeLayoutGeometry(
  rawCols: number,
  rawRows: number,
  activeSuggestsCount = 0,
  inputPromptLen = 2,
  cursorPos = 0,
  statusActive = false,
  inputLineCount = 1,
): LayoutInfo {
  const cols = Math.max(MIN_COLS, rawCols);
  const rows = Math.max(MIN_ROWS, rawRows);
  const breakpoint = breakpointFor(cols);
  // Sidebar panel is only shown on wide screens; a narrow viewport keeps the
  // prompt at full width so decorative chrome can never squeeze it out.
  const hasPanel = breakpoint === "wide";
  const panelWidth = hasPanel ? 36 : 0;
  const chatCols = cols - panelWidth;
  const statusRows = statusActive ? 1 : 0;
  const inputRows =
    Math.min(
      COMPOSER_MAX_BUFFER_LINES + 1,
      Math.max(2, inputLineCount + 1),
    );
  // Command palette: a large sheet anchored above the composer — roughly
  // 65-75% of the content viewport (never a tiny centered popup).
  const contentRows = Math.max(6, rows - RESERVED - statusRows);
  const popupRows =
    activeSuggestsCount > 0
      ? Math.max(6, Math.min(contentRows - 1, Math.floor(contentRows * 0.72)))
      : 0;
  // Prompt squeeze protection: the composer keeps inputRows even on the
  // smallest layout; the transcript absorbs the remainder and never drops
  // below two rows so at least a couple of context lines stay readable.
  const chatRows = Math.max(2, contentRows - popupRows - inputRows);
  const cursorRow = rows - FOOTER_ROWS; // Input prompt line (footer line is the last row)
  const cursorCol = Math.min(inputPromptLen + 1 + cursorPos, cols - 1);

  return {
    cols,
    rows,
    breakpoint,
    hasPanel,
    panelWidth,
    chatCols,
    chatRows,
    inputRows,
    popupRows,
    cursorRow,
    cursorCol,
  };
}
