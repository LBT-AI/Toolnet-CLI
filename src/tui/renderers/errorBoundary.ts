import { A } from "../../term";
import { composeBox } from "./composeBox";
import { MIN_COLS } from "../layout";

/** Floor for the fault-recovery frame — fits title + instructions + footer. */
const FALLBACK_MIN_ROWS = 12;

export interface RenderBoundaryResult {
  hasError: boolean;
  /** Fallback frame when faulty; the render fn's output otherwise. */
  frame: string;
  error?: Error;
}

/**
 * Catch a render fault and produce an actionable fallback frame instead of
 * crashing the process, leaving raw mode on, or destroying session state.
 *
 * The frame is composed through the shared box primitive so geometry stays
 * consistent with every other overlay; `cols`/`rows` come from the caller so
 * this stays a pure function for tests.
 */
export function renderWithErrorBoundary(
  renderFn: () => string,
  cols = 80,
  rows = 24,
): RenderBoundaryResult {
  try {
    return { hasError: false, frame: renderFn() };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    return { hasError: true, frame: renderFallbackFrame(error, cols, rows), error };
  }
}

/**
 * The actionable frame painted when a render pass faults.
 *
 * The frame is clamped to the smallest readable geometry: a terminal that
 * reports an absurd size (or a faulting resize race) must not shrink the
 * recovery frame until its instructions are truncated away — this frame is
 * the only guidance the user gets when the TUI cannot paint.
 */
export function renderFallbackFrame(error: Error, cols = 80, rows = 24): string {
  const message = truncateLine(error.message || "Unknown render fault", 46);
  return composeBox(Math.max(cols, MIN_COLS), Math.max(rows, FALLBACK_MIN_ROWS), {
    title: "⚠ ToolNet TUI Render Fault Caught",
    body: [
      `Error: ${message}`,
      "Press Ctrl+L to redraw or type /exit",
      "The terminal session is intact; rendering was skipped.",
      "",
    ],
    footer: "ToolNet · render boundary",
    accent: A.fgRed,
  }).join("\n");
}

function truncateLine(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) return value;
  return `${value.slice(0, maxWidth - 1)}…`;
}

/** Ordered escape sequence for complete terminal restoration on exit. */
export function terminalTeardownSequence(disableBracketedPaste: string): string {
  return [
    "\x1b[?25h", // cursor show
    disableBracketedPaste, // bracketed paste off
    "\x1b[?1049l", // leave alternate screen
  ].join("");
}
