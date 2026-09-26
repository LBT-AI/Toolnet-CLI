/**
 * Shared text-measurement and shaping primitives.
 *
 * These are the canonical implementations for terminal-cell math used by the
 * CLI, the banner, components, and the TUI. Nothing in this module may import
 * from `src/tui` or touch terminal state: every function is pure string →
 * string/number so any execution mode (TUI, headless, tests) can rely on it.
 */

import stripAnsiPackage from "strip-ansi";
import stringWidth from "string-width";

export function stripAnsi(text: string): string {
  return stripAnsiPackage(text);
}

/** Width occupied by a string in terminal cells, excluding ANSI sequences. */
export function visibleWidth(value: string): number {
  if (!value) return 0;
  return stringWidth(stripAnsi(value));
}

/**
 * Pad a string to an exact visible terminal-cell width. The value is assumed
 * to be pre-truncated by the caller: over-wide input is returned unchanged so
 * padding can never widen a line past its column budget.
 */
export function padVisible(
  value: string,
  width: number,
  align: "left" | "right" | "center" = "left",
): string {
  const current = visibleWidth(value);
  if (current >= width) return value;
  const padLen = width - current;
  if (align === "right") return " ".repeat(padLen) + value;
  if (align === "center") {
    const left = Math.floor(padLen / 2);
    return " ".repeat(left) + value + " ".repeat(padLen - left);
  }
  return value + " ".repeat(padLen);
}

/**
 * Truncate to terminal cells without slicing through a Unicode code point or
 * ANSI escape sequence. The ellipsis itself occupies one cell.
 */
export function truncateVisible(value: string, width: number, ellipsis = "…"): string {
  if (!value || width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  if (width === 1) return ellipsis.slice(0, 1);

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
  return out + ellipsis + (visibleWidth(value) > width ? "\x1b[0m" : "");
}

/** Keep the trailing `maxWidth` terminal cells of a string (cell-safe). */
export function tailByCells(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  const cps = Array.from(value);
  const out: string[] = [];
  let cells = 0;
  for (let i = cps.length - 1; i >= 0; i--) {
    const w = stringWidth(cps[i]);
    if (cells + w > maxWidth) break;
    out.unshift(cps[i]);
    cells += w;
  }
  return out.join("");
}

/**
 * Grapheme-cluster boundary helpers for cursor and editing operations.
 *
 * Vietnamese text can arrive as precomposed code points ("ạ" = U+1EA1) or as
 * a base character plus combining marks ("a" + U+0323). Treating the buffer as
 * one UTF-16 unit per keypress would split those clusters, so backspace or a
 * cursor move would leave behind an orphaned combining mark. These helpers move
 * by user-perceived character, matching what the terminal actually draws.
 */
const graphemeSegmenter = (() => {
  const Segmenter = (Intl as unknown as { Segmenter?: new (
    locale?: string,
    options?: { granularity?: string }
  ) => { segment(input: string): Iterable<{ index: number; segment: string }> } }).Segmenter;
  return Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : null;
})();

/** Regex covering the code points that extend the preceding cluster. */
const COMBINING_MARK = /\p{M}|\u200d|[\u{FE00}-\u{FE0F}]|[\u{1F3FB}-\u{1F3FF}]/u;

function isSurrogatePairStart(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff && index + 1 < value.length;
}

/** UTF-16 offset where the grapheme cluster before `index` starts. */
export function previousGraphemeStart(text: string, index: number): number {
  if (index <= 0) return 0;
  if (index > text.length) index = text.length;
  if (graphemeSegmenter) {
    let start = 0;
    for (const part of graphemeSegmenter.segment(text)) {
      if (part.index >= index) break;
      start = part.index;
    }
    return start;
  }
  // Fallback: walk back over one base code point plus any combining marks.
  let pos = index - 1;
  if (pos > 0 && text.charCodeAt(pos) >= 0xdc00 && text.charCodeAt(pos) <= 0xdfff) pos--;
  while (pos > 0 && COMBINING_MARK.test(text[pos])) pos--;
  return pos;
}

/** UTF-16 offset where the grapheme cluster at/after `index` ends. */
export function nextGraphemeEnd(text: string, index: number): number {
  if (index >= text.length) return text.length;
  if (index < 0) index = 0;
  if (graphemeSegmenter) {
    for (const part of graphemeSegmenter.segment(text)) {
      if (part.index + part.segment.length > index) return part.index + part.segment.length;
    }
    return text.length;
  }
  let pos = index + 1;
  if (isSurrogatePairStart(text, index)) pos = index + 2;
  while (pos < text.length && COMBINING_MARK.test(text[pos])) pos++;
  return pos;
}

/**
 * Terminal cells occupied by the text up to (but not into) UTF-16 `offset`.
 *
 * A cursor offset that lands inside a grapheme cluster — a legacy code-point
 * index, or a stale value — rounds up to the cluster's end, so the caret can
 * never sit between a base character and its combining mark, nor inside a
 * surrogate pair (which `String.slice` would split into mojibake).
 */
export function caretCellWidth(text: string, offset: number): number {
  if (offset <= 0) return 0;
  if (offset >= text.length) return visibleWidth(text);
  let cells = 0;
  let index = 0;
  while (index < text.length) {
    const end = nextGraphemeEnd(text, index);
    cells += visibleWidth(text.slice(index, end));
    index = end;
    if (index >= offset) return cells;
  }
  return cells;
}

/** List-entry shape shared by CLI catalog listings and TUI list panels. */
export interface ListItem {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  status?: "enabled" | "disabled" | "active";
}

/** Format a timestamp relative to now, e.g. "2m ago". */
export function formatRelativeTime(timestamp: string | number | Date): string {
  const ts =
    timestamp instanceof Date
      ? timestamp.getTime()
      : typeof timestamp === "number"
        ? timestamp
        : Date.parse(timestamp);
  if (!Number.isFinite(ts)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
