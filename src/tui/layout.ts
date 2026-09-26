import { getSize, A } from "../term";
import stringWidth from "string-width";
import {
  stripAnsi,
  visibleWidth,
  padVisible,
  truncateVisible,
  tailByCells,
  caretCellWidth,
} from "../lib/text";

// Canonical cell-math lives in `src/lib/text` so non-TUI code never imports
// from `src/tui`; these re-exports keep the renderers' import paths stable.
export { stripAnsi, visibleWidth, padVisible, truncateVisible, tailByCells };

export const ANSI_REGEX = /\x1b\[[^m]*m/g;

export const HEADER_ROWS = 2;        // Header text + divider
export const FOOTER_ROWS = 1;        // Bottom footer line
/** Prompt prefix ("> " / "… ") occupies 2 terminal cells before user text. */
export const PROMPT_PREFIX_CELLS = 2;



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
  /** Alias of inputRows (composer rows = divider + visible buffer lines). */
  composerRows: number;
  /** Terminal rows the activity status line consumes (0 when idle). */
  statusRows: number;
  popupRows: number;
  /** 0-based row of the composer divider; a one-line prompt sits here. */
  composerRow: number;
  /** 0-based row of the bottom footer bar. */
  footerRow: number;
  /** 0-based terminal row where the caret must be placed. */
  cursorRow: number;
  /** 0-based terminal column of the caret (cell after the typed content). */
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
  /** The live composer buffer — enables exact caret line/cell mapping. */
  inputBuffer = "",
): LayoutInfo {
  const { cols, rows } = getSize();
  return computeLayoutGeometry(cols, rows, activeSuggestsCount, inputPromptLen, cursorPos, statusActive, inputLineCount, inputBuffer);
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
  inputPromptLen = PROMPT_PREFIX_CELLS,
  cursorPos = 0,
  statusActive = false,
  inputLineCount = 1,
  inputBuffer = "",
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

  // Composer rows: divider + visible buffer lines, capped exactly like
  // renderInputArea (statusRenderer) — one shared budget, never guessed twice.
  const bufferLines = inputBuffer ? inputBuffer.split("\n").length : Math.max(1, inputLineCount);
  const inputRows = Math.min(
    COMPOSER_MAX_BUFFER_LINES + 1,
    Math.max(2, bufferLines + 1),
  );

  // ── One vertical ledger: every region counted exactly once ──────────────
  //   header + chat + popup + status + composer + footer === rows
  // Bottom-anchored chrome (footer, composer, status) gets its rows first;
  // the transcript absorbs whatever remains.
  const footerRow = rows - 1;
  // Composer divider sits inputRows above the footer; its prompt lines fill
  // [composerRow + 1 .. footerRow - 1], so the caret can never reach the
  // footer row and no gap opens between composer and footer.
  const composerRow = footerRow - inputRows; // divider row (0-based)
  const contentRows = rows - HEADER_ROWS - statusRows - inputRows - FOOTER_ROWS;

  // Command palette: a COMPACT autocomplete anchored above the composer,
  // sized to the actual result count (5-8 results) instead of a fixed sheet.
  // Window height = items (+1 wrapped description on narrow terminals) plus
  // top border, hint line and bottom border. The transcript keeps at least
  // chatFloor rows; the palette collapses rather than pushing chrome off-grid.
  const chatFloor = 2;
  const paletteWindow = Math.min(activeSuggestsCount, 8);
  const paletteChrome = 3; // top border + hint + bottom border
  const paletteNeeded =
    activeSuggestsCount > 0
      ? paletteWindow + paletteChrome + (cols < 60 ? paletteWindow : 0)
      : 0;
  const popupRows =
    paletteNeeded > 0 && contentRows >= chatFloor + Math.min(paletteNeeded, 4)
      ? Math.min(paletteNeeded, Math.max(0, contentRows - chatFloor))
      : 0;
  const chatRows = Math.max(chatFloor, contentRows - popupRows);

  // ── Caret placement — derived from the SAME composer geometry ────────────
  const lines = inputBuffer ? inputBuffer.split("\n") : [];
  const visibleLines = inputRows - 1;
  const startIdx = Math.max(0, bufferLines - visibleLines); // scrolled composer
  let caretLine = bufferLines - 1;
  let caretColInLine = 0;
  let caretPrefixWidth = cursorPos; // legacy path: codepoint≈cell approximation
  if (lines.length > 0) {
    // `cursorPos` is a UTF-16 offset into `inputBuffer` (it comes straight from
    // the composer document), so map it with UTF-16 lengths. Using code-point
    // lengths here mismatches on astral characters and lands the caret a column
    // or a line off. Measuring the prefix with visibleWidth keeps combining
    // marks (NFD Vietnamese) at zero cells.
    let pos = 0;
    for (let i = 0; i < lines.length; i++) {
      const lineLen = lines[i].length;
      if (pos + lineLen >= cursorPos || i === lines.length - 1) {
        caretLine = i;
        caretColInLine = Math.max(0, Math.min(cursorPos - pos, lineLen));
        break;
      }
      pos += lineLen + 1; // +1 for the newline character
    }
    // Cell-aware prefix: rounds a mid-cluster offset up to the cluster end so
    // CJK/emoji count their true width and no surrogate is split.
    caretPrefixWidth = caretCellWidth(lines[caretLine] ?? "", caretColInLine);
  }
  const visibleCaretIdx = Math.max(0, Math.min(caretLine - startIdx, visibleLines - 1));
  const cursorRow = composerRow + 1 + visibleCaretIdx;
  // 0-based caret column: prompt prefix cells + typed prefix width.
  const cursorCol = Math.min(inputPromptLen + caretPrefixWidth, cols - 1);

  return {
    cols,
    rows,
    breakpoint,
    hasPanel,
    panelWidth,
    chatCols,
    chatRows,
    inputRows,
    composerRows: inputRows,
    statusRows,
    popupRows,
    composerRow,
    footerRow,
    cursorRow,
    cursorCol,
  };
}
