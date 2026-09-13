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
