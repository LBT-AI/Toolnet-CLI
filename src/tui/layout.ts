import { getSize, A } from "../term";

export const ANSI_REGEX = /\x1b\[[^m]*m/g;

export const HEADER_ROWS = 2;        // Header text + divider
export const WORKING_STATUS_ROWS = 2; // Divider + working status text
export const INPUT_ROWS = 2;         // Divider + input line
export const FOOTER_ROWS = 2;        // Divider + footer bar
export const RESERVED = HEADER_ROWS + WORKING_STATUS_ROWS + INPUT_ROWS + FOOTER_ROWS;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

export function truncate(s: string, maxLen: number): string {
  if (!s) return "";
  if (s.length <= maxLen) return s;
  if (maxLen <= 1) return s.slice(0, maxLen);
  return s.slice(0, maxLen - 1) + "…";
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

export function computeLayout(activeSuggestsCount = 0, inputPromptLen = 2, cursorPos = 0): LayoutInfo {
  const { cols, rows } = getSize();
  // Sidebar panel is only shown on very wide screens (>= 120 cols)
  const hasPanel = cols >= 120;
  const panelWidth = hasPanel ? 36 : 0;
  const chatCols = hasPanel ? cols - panelWidth : cols;
  const popupRows = activeSuggestsCount > 0 ? Math.min(activeSuggestsCount, 7) + 3 : 0;
  const chatRows = Math.max(1, rows - RESERVED - popupRows);
  const cursorRow = rows - FOOTER_ROWS; // Input prompt line
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
