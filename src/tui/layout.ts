import { getSize, A } from "../term";

export const ANSI_REGEX = /\x1b\[[^m]*m/g;

export const HEADER_ROWS = 2;        // Header text + divider
export const INPUT_AREA_ROWS = 2;    // Input divider + input line
export const FOOTER_ROWS = 1;        // Bottom footer line
export const RESERVED = HEADER_ROWS + INPUT_AREA_ROWS + FOOTER_ROWS; // 5

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/**
 * Truncates a string to `maxLen` VISIBLE characters. ANSI escape sequences are
 * preserved intact (never broken), and an ellipsis is appended when truncated.
 * Plain strings behave identically to a raw slice-based truncate.
 */
export function truncate(s: string, maxLen: number): string {
  if (!s) return "";
  if (stripAnsi(s).length <= maxLen) return s;
  if (maxLen <= 1) return stripAnsi(s).slice(0, maxLen);
  return truncateKeepingEscapes(s, maxLen - 1) + "…";
}

function truncateKeepingEscapes(s: string, maxVisible: number): string {
  let out = "";
  let visible = 0;
  let i = 0;
  while (i < s.length && visible < maxVisible) {
    if (s.charCodeAt(i) === 0x1b && i + 1 < s.length && s[i + 1] === "[") {
      let j = i + 2;
      while (j < s.length && !(0x40 <= s.charCodeAt(j) && s.charCodeAt(j) <= 0x7b)) j++;
      out += s.slice(i, j + 1);
      i = j + 1;
    } else {
      out += s[i];
      visible += 1;
      i += 1;
    }
  }
  return out;
}

export function fillLine(text: string, width: number, fg = A.fgText, bg = A.bgSurface): string {
  const stripped = stripAnsi(text);
  const pad = Math.max(0, width - stripped.length);
  return bg + fg + text + " ".repeat(pad) + A.reset;
}

export function wrapText(text: string, width: number): string[] {
  if (!text) return [""];
  if (width <= 0) return [text];
  const lines: string[] = [];
  const paragraphs = text.split("\n");
  for (const para of paragraphs) {
    if (para === "") {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of para.split(" ")) {
      if (current === "") {
        current = word;
      } else if (current.length + 1 + word.length <= width) {
        current += " " + word;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [""];
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
  const cursorRow = rows - FOOTER_ROWS - 1; // Input prompt line (footer line is the last row)
  const cursorCol = Math.min(inputPromptLen + 1 + cursorPos, cols - 1) + 1;

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
