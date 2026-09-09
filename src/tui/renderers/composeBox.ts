import { A, T } from "../../term";
import { padVisible, truncateVisible, visibleWidth } from "../layout";
import type { ModalAnimationRenderState } from "../animations/modalAnimation";
import { easeOutCubic } from "../animations/modalAnimation";

export interface BoxOptions {
  title?: string;
  body: string[];
  footer?: string;
  width?: number;
  accent?: string;
  borderColor?: string;
  /** Optional elapsed-time animation state; geometry remains final-size. */
  animation?: ModalAnimationRenderState | null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** How many terminal rows a box with this body will occupy. */
export function boxHeight(bodyLen: number, hasFooter: boolean): number {
  return 1 + bodyLen + (hasFooter ? 1 : 0) + 1;
}

/**
 * Calculate a box entirely inside the content viewport. Columns are 1-based
 * terminal coordinates; `boxW` is the complete width including both borders.
 */
export function computeBoxGeometry(
  cols: number,
  rows: number,
  bodyLen: number,
  hasFooter: boolean,
  width?: number
): { boxW: number; startCol: number; startRow: number } {
  const target = width ?? (cols < 60 ? 46 : 58);
  const availableWidth = Math.max(1, cols - 2);
  const minWidth = width === undefined
    ? Math.min(22, availableWidth)
    : Math.min(Math.max(1, width), availableWidth);
  const boxW = clamp(target, minWidth, availableWidth);
  const maxViewport = Math.max(3, rows - 5);
  const boxH = Math.min(boxHeight(bodyLen, hasFooter), maxViewport);
  const contentTop = 3;
  const contentBottom = Math.max(contentTop, rows - 3);
  const availableHeight = contentBottom - contentTop + 1;
  const startRow = contentTop + Math.max(0, Math.floor((availableHeight - boxH) / 2));
  const startCol = Math.max(1, Math.floor((cols - boxW) / 2) + 1);
  return { boxW, startCol, startRow };
}

/** Build a plain top border whose total width is `innerWidth + 2`. */
export function topBorder(title: string, innerWidth: number): string {
  const safeInner = Math.max(1, innerWidth);
  const prefix = title ? `─ ${title} ` : "";
  const remaining = safeInner - visibleWidth(prefix);
  if (!title || remaining <= 0) {
    return `╭${"─".repeat(safeInner)}╮`;
  }
  return `╭${prefix}${"─".repeat(remaining)}╮`;
}

/** Build a plain body line whose total width is `innerWidth + 2`. */
export function bodyLine(content: string, innerWidth: number): string {
  const safeInner = Math.max(1, innerWidth);
  return `│${padVisible(content, safeInner)}│`;
}

/** Build a plain bottom border whose total width is `innerWidth + 2`. */
export function bottomBorder(innerWidth: number): string {
  const safeInner = Math.max(1, innerWidth);
  return `╰${"─".repeat(safeInner)}╯`;
}

function styledTopBorder(
  title: string,
  innerWidth: number,
  accent: string,
  border: string
): string {
  const safeTitle = truncateVisible(title, Math.max(1, innerWidth - 4));
  const prefix = safeTitle ? `─ ${safeTitle} ` : "";
  const remaining = innerWidth - visibleWidth(prefix);
  if (!safeTitle || remaining <= 0) {
    return border + `╭${"─".repeat(innerWidth)}╮` + A.reset;
  }
  return border + "╭─ " + accent + A.bold + safeTitle + A.reset + border +
    ` ${"─".repeat(remaining)}╮` + A.reset;
}

function styledBodyLine(content: string, innerWidth: number, border: string): string {
  const contentWidth = Math.max(1, innerWidth - 2);
  const safeContent = truncateVisible(content, contentWidth);
  const padded = padVisible(` ${safeContent} `, innerWidth);
  return border + "│" + A.reset + padded + border + "│" + A.reset;
}

function styledFooterLine(content: string, innerWidth: number, border: string): string {
  const contentWidth = Math.max(1, innerWidth - 2);
  const safeContent = truncateVisible(content, contentWidth);
  const padded = padVisible(` ${A.fgMuted}${safeContent}${A.reset} `, innerWidth);
  return border + "│" + A.reset + padded + border + "│" + A.reset;
}

/**
 * Keep the title visible while the horizontal rule grows from the center.
 * Masking is performed on the already-sized plain cell sequence, so it cannot
 * change the modal width or introduce terminal cursor movement.
 */
function animatedTopBorder(
  title: string,
  innerWidth: number,
  accent: string,
  border: string,
  animation: ModalAnimationRenderState
): string {
  const safeTitle = truncateVisible(title, Math.max(1, innerWidth - 4));
  const prefix = safeTitle ? `─ ${safeTitle} ` : "";
  const remaining = Math.max(0, innerWidth - visibleWidth(prefix));
  const finalLine = `╭${prefix}${"─".repeat(remaining)}╮`;
  const cells = Array.from(finalLine);
  const titleStart = safeTitle ? 3 : 0;
  const titleEnd = safeTitle ? titleStart + Array.from(safeTitle).length : 0;
  const progress = animation.animation.phase === "closing"
    ? 1 - easeOutCubic(animation.progress)
    : easeOutCubic(animation.progress);
  const radius = Math.ceil((innerWidth + 2) * progress / 2);
  const center = Math.floor((innerWidth + 1) / 2);

  for (let i = 0; i < cells.length; i++) {
    const isTitle = Boolean(safeTitle) && i >= titleStart && i < titleEnd;
    const isVisible = isTitle || Math.abs(i - center) <= radius;
    if (!isVisible && cells[i] !== "╭" && cells[i] !== "╮") cells[i] = " ";
  }

  // The corners are shown only once the sweep reaches their side, avoiding
  // detached corner glyphs during the opening/closing motion.
  if (progress < 0.98) {
    if (Math.abs(0 - center) > radius) cells[0] = " ";
    if (Math.abs((cells.length - 1) - center) > radius) cells[cells.length - 1] = " ";
  }

  const sweep = animation.sweepProgress ?? progress;
  const styled: string[] = [];
  for (let i = 0; i < cells.length; i++) {
    const isTitle = Boolean(safeTitle) && i >= titleStart && i < titleEnd;
    const isVisible = isTitle || Math.abs(i - center) <= radius;
    if (!isVisible) {
      styled.push(" ");
    } else if (isTitle) {
      styled.push(accent + A.bold + cells[i] + A.reset);
    } else {
      const distanceFromCenter = Math.abs(i - center) / Math.max(1, center);
      styled.push((distanceFromCenter <= sweep ? A.fgCyan : A.fgBlue) + cells[i] + A.reset);
    }
  }
  return styled.join("");
}

function animatedBottomBorder(
  innerWidth: number,
  border: string,
  animation: ModalAnimationRenderState,
): string {
  const progress = animation.animation.phase === "closing"
    ? 1 - easeOutCubic(animation.progress)
    : easeOutCubic(animation.progress);
  const total = innerWidth + 2;
  const center = Math.floor((total - 1) / 2);
  const radius = Math.ceil(total * progress / 2);
  const cells = Array.from({ length: total }, () => " ");
  if (progress >= 0.98) {
    cells[0] = "╰";
    cells[total - 1] = "╯";
  }
  for (let i = 1; i < total - 1; i++) {
    if (Math.abs(i - center) <= radius) cells[i] = "─";
  }
  if (Math.abs(0 - center) <= radius) cells[0] = "╰";
  if (Math.abs((total - 1) - center) <= radius) cells[total - 1] = "╯";
  return cells.map((cell) => cell === " " ? " " : border + cell + A.reset).join("");
}

function assertLineWidth(line: string, boxW: number): void {
  if (visibleWidth(line) !== boxW) {
    throw new Error(`Modal geometry mismatch: expected ${boxW} cells, got ${visibleWidth(line)}`);
  }
}

/**
 * Shared design-system primitive for every ToolNet modal/overlay.
 * Geometry is calculated from unstyled visible cells first; ANSI styling is
 * only applied while the already-sized frame is assembled.
 */
export function composeBox(
  cols: number,
  rows: number,
  opts: BoxOptions
): string[] {
  const { title = "", footer = "" } = opts;
  const hasFooter = Boolean(footer);
  const maxViewport = Math.max(3, rows - 5);
  const target = opts.width ?? (cols < 60 ? 46 : 58);
  const availableWidth = Math.max(1, cols - 2);
  // Explicit widths (used by the confirmation modal) are authoritative: do
  // not widen them past the requested mobile margin just to satisfy the
  // minimum used by the other, less constrained overlays.
  const minWidth = opts.width === undefined
    ? Math.min(22, availableWidth)
    : Math.min(Math.max(1, opts.width), availableWidth);
  const boxW = clamp(target, minWidth, availableWidth);
  const contentMax = Math.max(1, boxW - 4);
  const animation = opts.animation;
  const motionProgress = animation
    ? animation.animation.phase === "closing"
      ? 1 - easeOutCubic(animation.progress)
      : easeOutCubic(animation.progress)
    : 1;
  const maxBodyRows = Math.max(1, maxViewport - (hasFooter ? 3 : 2));

  let body = opts.body.slice(0, maxBodyRows);
  if (opts.body.length > maxBodyRows) {
    body = opts.body.slice(0, Math.max(1, maxBodyRows - 1));
    body.push(A.fgMuted + "…" + A.reset);
  }
  body = body.map((line) => truncateVisible(line, contentMax));

  const innerWidth = boxW - 2;
  const { startCol, startRow } = computeBoxGeometry(cols, rows, body.length, hasFooter, boxW);
  const border = opts.borderColor ?? A.fgBorder;
  const accent = opts.accent ?? A.fgCyan;
  const out: string[] = [];

  const top = animation
    ? animatedTopBorder(title, innerWidth, accent, border, animation)
    : styledTopBorder(title, innerWidth, accent, border);
  out.push(T.goto(startRow, startCol) + top);

  for (let index = 0; index < body.length; index++) {
    const row = body[index];
    // Reveal body rows after the title/rule. Closing reverses the same reveal
    // so the border never changes geometry while content retracts.
    const revealThreshold = (index + 1) / Math.max(1, body.length);
    const visible = !animation || motionProgress >= revealThreshold;
    const rendered = visible ? row : "";
    const line = visible || !animation
      ? styledBodyLine(rendered, innerWidth, border)
      : " ".repeat(boxW);
    out.push(T.goto(startRow + out.length, startCol) + line);
  }

  if (hasFooter) {
    out.push(T.goto(startRow + out.length, startCol) + styledFooterLine(footer, innerWidth, border));
  }

  const bottom = animation
    ? animatedBottomBorder(innerWidth, border, animation)
    : border + bottomBorder(innerWidth) + A.reset;
  out.push(T.goto(startRow + out.length, startCol) + bottom);

  if (process.env.NODE_ENV !== "production") {
    for (const line of out) assertLineWidth(line, boxW);
  }
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