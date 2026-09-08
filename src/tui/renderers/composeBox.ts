import { A, T } from "../../term";
import { stripAnsi, truncate } from "../layout";

export interface BoxOptions {
  title?: string;
  body: string[];
  footer?: string;
  width?: number;
  accent?: string;
  borderColor?: string;
}

const LEFT = 1;
const RIGHT = 1;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** How many terminal rows a box with this body will occupy. */
export function boxHeight(bodyLen: number, hasFooter: boolean): number {
  return 1 + bodyLen + (hasFooter ? 1 : 0) + 1;
}

export function computeBoxGeometry(
  cols: number,
  rows: number,
  bodyLen: number,
  hasFooter: boolean,
  width?: number
): { boxW: number; startCol: number; startRow: number } {
  const isTiny = cols < 60;
  const target = width ?? (isTiny ? 46 : 58);
  const boxW = Math.max(22, Math.min(target, cols - 2));
  // The box may live ONLY in the content viewport: header (2) + input row,
  // its divider, and the footer are reserved at the bottom too.
  const maxViewport = Math.max(3, rows - 5);
  const boxH = Math.min(boxHeight(bodyLen, hasFooter), maxViewport);
  const centered = Math.floor((rows - boxH) / 2);
  // Row 3 (1-indexed) is the first row below the header brand + divider, so
  // the box can never overwrite the header chrome. The upper bound keeps the
  // box bottom strictly above the input divider (row `rows - 3`).
  const startRow = clamp(centered, 3, Math.max(3, rows - boxH - 2));
  const startCol = Math.max(1, Math.floor((cols - boxW) / 2));
  return { boxW, startCol, startRow };
}

/**
 * Single design-system primitive for every ToolNet modal/overlay:
 * rounded corners, dim border, short title, responsive width.
 *
 * Returns `T.goto(row, col) + line` pairs so the caller paints them with
 * absolute positioning on top of the base frame. `body` rows are raw strings
 * (ANSI-aware truncation to the inner width is applied internally).
 */
export function composeBox(
  cols: number,
  rows: number,
  opts: BoxOptions
): string[] {
  const { title = "", footer = "" } = opts;
  let body = opts.body.slice();
  const hasFooter = Boolean(footer);
  // Hard fit: body must never push the box past the content viewport. The
  // viewport holds `maxViewport` rows: 1 top border + body + (footer?) +
  // 1 bottom border. Reserve 1 body row for the "…" marker we append, so the
  // finished box is exactly `maxViewport` tall at most.
  const maxViewport = Math.max(3, rows - 5);
  const fitRows = Math.max(1, maxViewport - (hasFooter ? 3 : 2));
  if (body.length > fitRows) {
    body = body.slice(0, Math.max(1, fitRows - 1));
    body.push(A.fgMuted + "…" + A.reset);
  }
  const { boxW, startCol, startRow } = computeBoxGeometry(cols, rows, body.length, hasFooter, opts.width);
  const inner = boxW - 2;
  const contentMax = Math.max(4, inner - LEFT - RIGHT);
  const border = opts.borderColor ?? A.fgBorder;
  const accent = opts.accent ?? A.fgCyan;

  const out: string[] = [];

  // Top border with inline title: ╭─ Title ─────────────────╮
  if (title) {
    const t = truncate(title, Math.max(4, inner - 4));
    const tLen = stripAnsi(t).length;
    const fill = Math.max(1, inner - tLen - 2);
    const top = "╭─" + accent + A.bold + t + A.reset + " " + border + "─".repeat(fill) + "╮";
    out.push(T.goto(startRow, startCol) + top);
  } else {
    out.push(T.goto(startRow, startCol) + border + "╭" + "─".repeat(inner) + "╮" + A.reset);
  }

  for (let i = 0; i < body.length; i++) {
    const row = body[i];
    const visible = stripAnsi(row);
    const tooLong = visible.length > contentMax;
    const content = tooLong ? truncate(row, contentMax) : row;
    const pad = " ".repeat(Math.max(0, contentMax - stripAnsi(content).length));
    out.push(
      T.goto(startRow + 1 + i, startCol) +
      border + "│" + A.reset + " " +
      content + pad + " " +
      border + "│" + A.reset
    );
  }

  if (hasFooter) {
    const visible = stripAnsi(footer);
    const fContent = visible.length > contentMax ? truncate(footer, contentMax) : footer;
    const pad = " ".repeat(Math.max(0, contentMax - stripAnsi(fContent).length));
    out.push(
      T.goto(startRow + body.length + 1, startCol) +
      border + "│" + A.reset + " " +
      A.fgMuted + fContent + A.reset + pad + " " +
      border + "│" + A.reset
    );
  }

  out.push(
    T.goto(startRow + body.length + 1 + (hasFooter ? 1 : 0), startCol) +
    border + "╰" + "─".repeat(inner) + "╯" + A.reset
  );

  return out;
}

/** Prompt-line helper for secret/key inputs: `> •••cursor•••`. */
export function maskLine(line: string, cursor: number, max: number): string {
  const maskedFull = "•".repeat(cursor) + "█" + "•".repeat(Math.max(0, line.length - cursor));
  if (maskedFull.length <= max) return maskedFull;
  const half = Math.floor(max / 2);
  const start = Math.max(0, Math.min(cursor - half, maskedFull.length - max));
  return (start > 0 ? "…" : "") + maskedFull.slice(start, start + max - (start > 0 ? 1 : 0));
}