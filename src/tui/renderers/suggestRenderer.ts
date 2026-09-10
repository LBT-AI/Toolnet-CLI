import { A } from "../../term";
import { stripAnsi, truncate, wrapVisible, visibleWidth } from "../layout";

/**
 * Large command-sheet palette, anchored directly above the composer
 * (Freebuff-style). Each command renders as a 2-line block — name row plus
 * description row — and the selected block is highlighted across the full
 * sheet width. The sheet spans most of the content viewport and scrolls
 * through arbitrarily many commands with a viewport window.
 *
 * Called from buildFrame() as part of the single TUI render tree; never
 * writes to stdout directly.
 */
export function renderSuggestionsPopup(
  cols: number,
  popupRows: number,
  suggests: Array<{ name: string; desc: string }>,
  cmdSuggestIdx: number,
  primaryColor: string
): string[] {
  const out: string[] = [];
  if (suggests.length === 0) return out;

  // ── Sheet geometry: near-full width, tall, anchored above the composer ──
  const paletteWidth =
    cols < 50
      ? Math.max(20, cols - 2) // narrow terminals: almost full width
      : cols < 80
        ? Math.max(24, cols - 4) // medium: width - 4
        : Math.min(cols - 4, Math.max(44, Math.floor(cols * 0.96))); // wide: 92-96%
  const leftPad = Math.max(0, Math.floor((cols - paletteWidth) / 2));
  const innerWidth = paletteWidth - 2; // minus the two border columns

  // Rows available for command entries (top border + hint + bottom border).
  const bodyRows = Math.max(4, popupRows - 3);

  // ── Item geometry: 1 name row + description rows ─────────────────────────
  // On narrow terminals the description may wrap (up to 2 lines); elsewhere
  // it stays on one truncated line.
  const descMax = Math.max(10, innerWidth - 6);
  const itemRows = suggests.map((c) => {
    const descLines = cols < 50 ? wrapVisible(c.desc, descMax).slice(0, 2) : [truncate(c.desc, descMax)];
    return 1 + descLines.length;
  });

  // Prefix sums: P[k] = rows consumed by items [0..k-1].
  const P: number[] = [0];
  for (const r of itemRows) P.push(P[P.length - 1] + r);

  // ensureSelectedVisible: keep the selection centered inside the viewport,
  // clamping at both ends so the selected block is always on screen.
  const idx = Math.max(0, Math.min(cmdSuggestIdx, suggests.length - 1));
  let start = idx;
  while (start > 0 && P[idx] - P[start] < Math.floor(bodyRows / 2)) start--;
  let end = idx + 1;
  while (end < suggests.length && P[end + 1] - P[start] <= bodyRows) end++;
  // If the centered window overflows (tall entries above), slide it down.
  while (P[end] - P[start] > bodyRows && start < idx) {
    start++;
    end = Math.max(end, idx + 1);
  }

  // ── Row builders ─────────────────────────────────────────────────────────
  const border = (glyph: string) =>
    " ".repeat(leftPad) + A.fgBorder + glyph + "─".repeat(paletteWidth - 2) + A.reset + "\r\n";

  // Plain row (no selection background) — used for the hint line.
  const plainRow = (content: string): string => {
    const pad = Math.max(0, innerWidth - visibleWidth(content));
    return (
      " ".repeat(leftPad) + A.fgBorder + "│" + A.reset +
      content + " ".repeat(pad) +
      A.fgBorder + "│" + A.reset + "\r\n"
    );
  };

  // Full-width highlighted row. `bg` re-applies the selection background
  // after every internal ANSI reset so the highlight spans the whole sheet.
  const highlightedRow = (content: string, bg: string): string => {
    const inner = bg ? content.replace(/\x1b\[0m/g, A.reset + bg) : content;
    const pad = Math.max(0, innerWidth - visibleWidth(inner));
    const filled = bg ? inner + bg + " ".repeat(pad) + A.reset : inner + " ".repeat(pad);
    return (
      " ".repeat(leftPad) + A.fgBorder + "│" + A.reset +
      filled +
      A.fgBorder + "│" + A.reset + "\r\n"
    );
  };

  out.push(border("╭"));

  for (let i = start; i < end && i < suggests.length; i++) {
    const cmd = suggests[i];
    const selected = i === idx;
    const bg = selected ? A.bgOverlay : "";
    const descLines = cols < 50 ? wrapVisible(cmd.desc, descMax).slice(0, 2) : [truncate(cmd.desc, descMax)];

    // Name row: ● marker (selected) + bold cyan name on selection.
    const marker = selected ? A.fgCyan + A.bold + "● " + A.reset : "  ";
    const nameFmt = (selected ? A.fgCyan + A.bold : A.fgText) + cmd.name + A.reset;
    out.push(highlightedRow(marker + nameFmt, bg));

    // Description row(s): bright on selection, muted otherwise.
    for (const dl of descLines) {
      const descFmt = (selected ? A.fgText : A.fgSubtext) + "    " + dl + A.reset;
      out.push(highlightedRow(descFmt, bg));
    }
  }

  // Hint + counter (e.g. "↑↓ navigate · enter select · esc close   7 / 37").
  const hint = A.fgMuted + "↑↓ navigate · enter select · esc close" + A.reset;
  const counter = A.fgSubtext + `${idx + 1} / ${suggests.length}` + A.reset;
  const hintPad = Math.max(2, innerWidth - visibleWidth(hint) - visibleWidth(counter));
  out.push(plainRow(hint + " ".repeat(hintPad) + counter));

  out.push(border("╰"));

  return out;
}