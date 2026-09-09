import { getSize, A } from "../term";
import stripAnsiPackage from "strip-ansi";
import stringWidth from "string-width";

export const ANSI_REGEX = /\x1b\[[^m]*m/g;

export const HEADER_ROWS = 2;        // Header text + divider
export const INPUT_AREA_ROWS = 2;    // Input divider + input line
export const FOOTER_ROWS = 1;        // Bottom footer line
export const RESERVED = HEADER_ROWS + INPUT_AREA_ROWS + FOOTER_ROWS; // 5

export function stripAnsi(text: string): string {
  return stripAnsiPackage(text);
}

/** Width occupied by a string in terminal cells, excluding ANSI sequences. */
export function visibleWidth(value: string): number {
  if (!value) return 0;
  return stringWidth(stripAnsi(value));
}

/** Pad a string to an exact visible terminal-cell width. */
export function padVisible(value: string, width: number): string {
  const current = visibleWidth(value);
  if (current >= width) return value;
  return value + " ".repeat(width - current);
}

/**
 * Truncate to terminal cells without slicing through a Unicode code point or
 * ANSI escape sequence. The ellipsis itself occupies one cell.
 */
export function truncateVisible(value: string, width: number): string {
  if (!value || width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  if (width === 1) return "…";

  let out = "";
  let cells = 0;
  let i = 0;
  while (i < value.length && cells < width - 1) {
    if (value.charCodeAt(i) === 0x1b) {
      const match = value.slice(i).match(/^\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/);
      if (match) {
        out += match[0];
        i += match[0].length;
        continue;
      }
    }

    const codePoint = String.fromCodePoint(value.codePointAt(i)!);
    const codePointWidth = stringWidth(codePoint);
    if (cells + codePointWidth > width - 1) break;
    out += codePoint;
    cells += codePointWidth;
    i += codePoint.length;
  }

  // Reset protects the rest of the frame when the source was colored.
  return out + "…" + (visibleWidth(value) > width ? "\x1b[0m" : "");
}

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

export interface LayoutInfo {
  cols: number;
  rows: number;
  hasPanel: boolean;
  panelWidth: number;
  chatCols: number;
  chatRows: number;
  popupRows: number;
  cursorRow: number;
  cursorCol: number;
}

export function computeLayout(activeSuggestsCount = 0, inputPromptLen = 2, cursorPos = 0, statusActive = false): LayoutInfo {
  const { cols, rows } = getSize();
  // Sidebar panel is only shown on very wide screens (>= 120 cols)
  const hasPanel = cols >= 120;
  const panelWidth = hasPanel ? 36 : 0;
  const chatCols = hasPanel ? cols - panelWidth : cols;
  const popupRows = activeSuggestsCount > 0 ? Math.min(activeSuggestsCount, 7) + 3 : 0;
  const statusRows = statusActive ? 1 : 0;
  const chatRows = Math.max(1, rows - RESERVED - statusRows - popupRows);
  const cursorRow = rows - FOOTER_ROWS; // Input prompt line (footer line is the last row)
  const cursorCol = Math.min(inputPromptLen + 1 + cursorPos, cols - 1);

  return {
    cols,
    rows,
    hasPanel,
    panelWidth,
    chatCols,
    chatRows,
    popupRows,
    cursorRow,
    cursorCol,
  };
}
