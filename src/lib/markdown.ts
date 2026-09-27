/**
 * Canonical lightweight Markdown → ANSI renderer.
 *
 * This is the ONLY place inline Markdown markers are interpreted. It replaces
 * the previous chain of naive `.replace()` passes, which leaked raw `**`,
 * `***`, `###` and `***`-as-horizontal-rule into the transcript and corrupted
 * things like globs (`*.ts`), shell (`find . -name "*.ts"`) and math (`2 * 3`).
 *
 * Design rules:
 *  - Never delete `*`/`_`/backtick characters blindly. Only a *matched*,
 *    balanced marker pair is converted; every other character is emitted
 *    verbatim (so globs, shell and math survive untouched).
 *  - Support escapes (`\*` → literal `*`).
 *  - Streaming-safe: a trailing unterminated marker run is stripped for DISPLAY
 *    only (see `stripTrailingMarker`), never from the canonical content.
 *  - Block-level helpers (heading / horizontal rule / bullet) are pure and
 *    returned separately so the transcript renderer keeps ownership of layout.
 */

import { A, S } from "../term";
import { stripAnsi, truncateVisible, visibleWidth } from "./text";

const ESCAPE_CHARS = new Set(["*", "_", "`", "~", "\\", "|", "[", "]"]);

/** Collapse `\x` escapes to the literal character. */
export function unescapeMarkdown(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length && ESCAPE_CHARS.has(text[i + 1])) {
      out += text[i + 1];
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function findClosing(text: string, start: number, marker: string): number {
  const idx = text.indexOf(marker, start);
  if (idx === -1) return -1;
  // Reject empty emphasis (`** **`) and space-padded emphasis (`* x *`).
  const inner = text.slice(start, idx);
  if (inner.length === 0) return -1;
  if (/^\s/.test(inner) || /\s$/.test(inner)) return -1;
  return idx;
}

/**
 * True when the `_` at `index` sits INSIDE a word (`my_var`, `a_b_c`).
 * Per CommonMark, intraword underscores never open or close emphasis, which is
 * what keeps snake_case identifiers intact in rendered transcript text.
 */
function isIntrawordUnderscore(text: string, index: number): boolean {
  const before = index > 0 ? text[index - 1] : "";
  const after = index + 1 < text.length ? text[index + 1] : "";
  return /[A-Za-z0-9]/.test(before) && /[A-Za-z0-9]/.test(after);
}

/**
 * Render inline Markdown for one logical line into ANSI.
 * Handles `***bi***`, `**bold**`, `*it*`/`_it_`, `` `code` ``, and escapes.
 */
export function renderInlineMarkdown(text: string, baseColor: string = A.fgText): string {
  if (!text) return "";
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // Escaped marker → literal, no styling.
    if (ch === "\\" && i + 1 < text.length && ESCAPE_CHARS.has(text[i + 1])) {
      out += text[i + 1];
      i += 2;
      continue;
    }

    // Inline code — highest precedence, no nested parsing. Code and path
    // metadata are NEUTRAL COOL: a quiet tone over a whisper of backdrop.
    // Warm accents stay reserved for action semantics (write/edit), so the
    // transcript never reads as an orange-on-gray syntax dump.
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        out += A.bgCode + A.fgCode + text.slice(i + 1, end) + A.reset + baseColor;
        i = end + 1;
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    // Bold+italic `***text***`
    if (ch === "*" && text.startsWith("***", i)) {
      const end = findClosing(text, i + 3, "***");
      if (end !== -1) {
        out += `${A.bold}${A.italic}${text.slice(i + 3, end)}${A.boldOff}${A.italicOff}${baseColor}`;
        i = end + 3;
        continue;
      }
    }

    // Bold `**text**`
    if (ch === "*" && text.startsWith("**", i)) {
      const end = findClosing(text, i + 2, "**");
      if (end !== -1) {
        out += `${A.bold}${text.slice(i + 2, end)}${A.boldOff}${baseColor}`;
        i = end + 2;
        continue;
      }
      // Unterminated `**`: emit both chars verbatim (streaming/partial marker).
      out += "**";
      i += 2;
      continue;
    }

    // Italic `*text*` — the opener must not be followed by a space.
    if (ch === "*" && i + 1 < text.length && !/\s/.test(text[i + 1])) {
      const end = findClosing(text, i + 1, "*");
      if (end !== -1) {
        out += `${A.italic}${text.slice(i + 1, end)}${A.italicOff}${baseColor}`;
        i = end + 1;
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    // Italic `_text_`. Underscore emphasis is intraword-INSENSITIVE (CommonMark):
    // `my_var_name` and `snake_case_id` are identifiers, never emphasis, so a
    // `_` with a word character on either side stays a literal underscore.
    if (ch === "_" && i + 1 < text.length && !/\s/.test(text[i + 1]) && !isIntrawordUnderscore(text, i)) {
      const end = findClosing(text, i + 1, "_");
      if (end !== -1 && !isIntrawordUnderscore(text, end)) {
        out += `${A.italic}${text.slice(i + 1, end)}${A.italicOff}${baseColor}`;
        i = end + 1;
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/** `***`, `---`, `___` (3+) alone on a line, optionally spaced. */
export function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3) return false;
  const compact = trimmed.replace(/\s+/g, "");
  return /^\*{3,}$/.test(compact) || /^-{3,}$/.test(compact) || /^_{3,}$/.test(compact);
}

export interface HeadingLine {
  level: number;
  text: string;
}

/** Parse an ATX heading (`## Title`), or null. */
export function parseHeading(line: string): HeadingLine | null {
  const match = /^(#{1,6})\s+(.*\S)\s*$/.exec(line.trim());
  if (!match) return null;
  return { level: match[1].length, text: match[2] };
}

/** Heading hierarchy: H1 primary cyan, H2 ivory, H3+ subtle — amber is never a heading color. */
export function renderHeading(level: number, text: string): string {
  const body = renderInlineMarkdown(text);
  if (level === 1) return `${A.bold}${A.fgHeadingPrimary}${body}${A.reset}`;
  if (level === 2) return `${A.bold}${A.fgText}${body}${A.reset}`;
  return `${A.bold}${A.fgSubtext}${body}${A.reset}`;
}

export interface BulletLine {
  indent: string;
  marker: string;
  text: string;
}

/**
 * Parse a list bullet (`- item`, `* item`, `+ item`, `1. item`).
 * The `*`/`+` forms are the ones that leak as raw markers; `-` is left alone.
 */
export function parseBullet(line: string): BulletLine | null {
  const match = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
  if (!match) return null;
  return { indent: match[1], marker: match[2], text: match[3] };
}

/** Normalize a star/plus bullet to a real bullet glyph (`-` stays as-is). */
export function normalizeBulletMarker(marker: string): string {
  if (marker === "*" || marker === "+") return S.bullet;
  return marker;
}

/**
 * Strip an unterminated trailing marker run from a still-streaming line so a
 * partial `**`/`***`/backtick never flashes on screen. Returns the display text
 * plus whether something was suppressed. Never mutates canonical content.
 */
export function stripTrailingMarker(line: string): { text: string; suppressed: boolean } {
  const match = /(\*{1,3}|_{1,3}|`{1})\s*$/.exec(line);
  if (!match) return { text: line, suppressed: false };
  return { text: line.slice(0, line.length - match[1].length), suppressed: true };
}

/**
 * Full in-flight suppression for the line currently being streamed.
 *
 * Two partial shapes must never reach the screen:
 *  - a TRAILING run (`text **`): the closer has not arrived yet;
 *  - a LEADING run with no possible closer left on the line (`**hello`): the
 *    opener arrived alone, and rendering it verbatim is exactly the `**` flash.
 *
 * A line whose closer DID arrive (`*hello*`) is left untouched so a completed
 * pair is styled the same frame it completes. Display-only: canonical content
 * in the message buffer and the session is never modified.
 */
export function stripInFlightMarkers(line: string): { text: string; suppressed: boolean } {
  let text = line;
  let suppressed = false;

  const trail = /(\*{1,3}|_{1,3}|`{1})\s*$/.exec(text);
  if (trail) {
    text = text.slice(0, text.length - trail[1].length);
    suppressed = true;
  }

  const lead = /^(\*{1,3}|_{1,3}|`{1})/.exec(text);
  if (lead && !text.slice(lead[1].length).includes(lead[1][0])) {
    text = text.slice(lead[1].length);
    suppressed = true;
  }

  return { text, suppressed };
}

// ── Tables ──────────────────────────────────────────────────────────────────

export interface MarkdownTable {
  header: string[];
  rows: string[][];
}

/** Split one pipe-table row into trimmed cells (`null` when not a table row). */
export function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const inner = body.endsWith("|") && !body.endsWith("\\|") ? body.slice(0, -1) : body;
  const cells = inner.split("|").map((cell) => cell.trim());
  return cells.length > 0 ? cells : null;
}

/** The `| --- | :---: |` separator row. */
export function isTableDividerRow(line: string): boolean {
  const cells = splitTableRow(line);
  if (!cells) return false;
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")));
}

/**
 * Parse a pipe-table block starting at `lines[start]`.
 * Returns the table plus the index of the line AFTER the block, or null when
 * `start` does not open a table. Never touches fenced code (caller keeps that
 * state).
 */
export function parseMarkdownTable(
  lines: readonly string[],
  start: number,
): { table: MarkdownTable; end: number } | null {
  if (start + 1 >= lines.length) return null;
  const header = splitTableRow(lines[start]);
  if (!header || !isTableDividerRow(lines[start + 1])) return null;
  const dividerCols = splitTableRow(lines[start + 1])!.length;
  if (header.length !== dividerCols) return null;

  const rows: string[][] = [];
  let end = start + 2;
  while (end < lines.length) {
    const cells = splitTableRow(lines[end]);
    if (!cells) break;
    rows.push(cells);
    end++;
  }
  return { table: { header, rows }, end };
}

export interface MarkdownTableSpan {
  end: number;
  table: MarkdownTable;
}

/**
 * Fence-aware pre-scan for pipe tables.
 *
 * Returns the start index → span of every table block that lives OUTSIDE a
 * fenced code block. A `| --- |` line inside a fence is CODE, never a table,
 * so it must not be re-rendered as a grid.
 */
export function scanMarkdownTables(lines: readonly string[]): Map<number, MarkdownTableSpan> {
  const spans = new Map<number, MarkdownTableSpan>();
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const parsed = parseMarkdownTable(lines, i);
    if (parsed) {
      spans.set(i, parsed);
      i = parsed.end - 1;
    }
  }
  return spans;
}

export interface ResponsiveTableResult {
  /** Lines to paint in the transcript. */
  lines: string[];
  /** Present when the table did NOT fit: the hint row (`… · Ctrl+O`). */
  viewerHint: string | null;
  /** Every cell as plain text, for the detail viewer. */
  fullLines: string[];
}

const TABLE_CELL_PAD = 1;

/**
 * Bound a stacked card to the viewport. Card lines are `lead-ANSI + text +
 * reset`, so the plain middle is truncated cell-safely and the reset is kept,
 * keeping the frame's line-width ledger exact.
 */
function truncateStyled(line: string, maxWidth: number): string {
  if (visibleWidth(line) <= maxWidth) return line;
  const lead = /^(?:\u001b\[[0-9;]*m)+/.exec(line)?.[0] ?? "";
  const budget = Math.max(1, maxWidth - visibleWidth(lead));
  return lead + truncateVisible(stripAnsi(line), budget) + A.reset;
}

/** Plain-text rows of a table (header first) for the detail viewer. */
export function tableToLines(table: MarkdownTable): string[] {
  const widths = columnWidths(table);
  const render = (cells: string[]) =>
    cells.map((cell, i) => (cell + " ".repeat(Math.max(0, widths[i] - visibleCellWidth(cell))))).join("  ");
  const out = [render(table.header)];
  out.push(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of table.rows) out.push(render(row));
  return out;
}

function visibleCellWidth(cell: string): number {
  // Cells are plain text here (parsed before styling).
  return visibleWidth(cell);
}

function columnWidths(table: MarkdownTable): number[] {
  const widths = table.header.map((cell) => visibleCellWidth(cell));
  for (const row of table.rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleCellWidth(cell));
    });
  }
  return widths;
}

/** Natural terminal-cell width of the table when drawn as an aligned grid. */
export function tableNaturalWidth(table: MarkdownTable): number {
  const widths = columnWidths(table);
  return widths.reduce((sum, w) => sum + w + TABLE_CELL_PAD * 2, 0) + Math.max(0, widths.length - 1);
}

/**
 * Render a table responsively.
 *
 *  - fits the available width → an aligned, bordered grid (wide terminals);
 *  - does not fit             → stacked `key: value` cards so a 52-col phone
 *    terminal never sees an 8-column table wrap into one character per line;
 *  - more rows than `maxRows` → the first rows plus a summary row and a viewer
 *    hint; the FULL plain-text table is always returned in `fullLines` so a
 *    detail viewer can page it without the transcript ever flooding.
 */
export function renderResponsiveTable(
  table: MarkdownTable,
  cols: number,
  options: { maxRows?: number } = {},
): ResponsiveTableResult {
  const fullLines = tableToLines(table);
  const fits = tableNaturalWidth(table) <= Math.max(10, cols);
  const maxRows = Math.max(1, options.maxRows ?? (cols < 60 ? 4 : 10));

  const lines: string[] = [];
  if (fits) {
    const widths = columnWidths(table);
    const renderRow = (cells: string[], style: (cell: string) => string) =>
      A.fgBorder + S.box.vertical + A.reset +
      cells
        .map(
          (cell, i) =>
            A.dim + " ".repeat(TABLE_CELL_PAD) + A.reset + style(cell) +
            " ".repeat(Math.max(0, widths[i] - visibleCellWidth(cell)) + TABLE_CELL_PAD) +
            A.reset,
        )
        .join(A.fgBorder + S.box.vertical + A.reset);

    lines.push(renderRow(table.header, (cell) => A.bold + A.fgText + cell + A.reset));
    lines.push(
      A.fgBorder +
        S.box.horizontal.repeat(Math.max(1, tableNaturalWidth(table))) +
        A.reset,
    );
    for (const row of table.rows) {
      lines.push(renderRow(row, (cell) => A.fgSubtext + cell + A.reset));
    }
  } else {
    // Stacked cards: one heading per row, remaining cells as `key: value`.
    // Card keys are metadata (muted), values subtext — no warm accents inside
    // table data.
    const maxCardWidth = Math.max(8, cols);
    for (const row of table.rows) {
      const [first, ...rest] = row;
      lines.push(truncateStyled(A.bold + A.fgText + first + A.reset, maxCardWidth));
      if (rest.length > 0) {
        const detail =
          "  " + A.fgMuted +
          rest.map((cell, i) => `${table.header[i + 1]}: ` + A.reset + A.fgSubtext + cell).join(A.fgMuted + " · ") +
          A.reset;
        lines.push(truncateStyled(detail, maxCardWidth));
      }
    }
  }

  let viewerHint: string | null = null;
  if (table.rows.length > maxRows) {
    const kept = lines.slice(0, Math.min(maxRows, lines.length));
    const hidden = table.rows.length - maxRows;
    lines.length = 0;
    lines.push(...kept);
    lines.push(A.fgMuted + `… +${hidden} more rows` + A.reset);
    viewerHint = A.fgMuted + `${table.rows.length} rows · Ctrl+O to view full report` + A.reset;
  }

  return { lines, viewerHint, fullLines };
}
