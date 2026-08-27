import { getSize, A } from "../term";

export const ANSI_REGEX = /\x1b\[[^m]*m/g;

export const HEADER_ROWS = 1;
export const STATUS_ROWS = 1;
export const INPUT_ROWS = 2; // border + input line
export const RESERVED = HEADER_ROWS + STATUS_ROWS + INPUT_ROWS;

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

export function computeLayout(activeSuggestsCount = 0, inputPromptLen = 3, cursorPos = 0): LayoutInfo {
  const { cols, rows } = getSize();
  const hasPanel = cols > 100;
  const panelWidth = hasPanel ? 40 : 0;
  const chatCols = hasPanel ? cols - panelWidth : cols;
  const popupRows = activeSuggestsCount > 0 ? Math.min(activeSuggestsCount, 8) + 1 : 0;
  const chatRows = Math.max(1, rows - RESERVED - popupRows);
  const cursorRow = rows - INPUT_ROWS + 1;
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
