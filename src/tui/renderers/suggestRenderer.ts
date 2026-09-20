import { A } from "../../term";
import { truncate, visibleWidth } from "../layout";

/**
 * Compact command autocomplete anchored immediately above the composer.
 * One row per command (`/name  description`), sized to the result window the
 * layout hands it — never a near-fullscreen sheet. On narrow terminals the
 * description is dropped before the command name is ever truncated.
 *
 * Called from buildFrame() as part of the single TUI render tree; never
 * writes to stdout directly.
 */
export function renderSuggestionsPopup(
  cols: number,
  popupRows: number,
  suggests: Array<{ name: string; desc: string }>,
  cmdSuggestIdx: number,
  _primaryColor: string
): string[] {
  const out: string[] = [];
  if (suggests.length === 0 || popupRows <= 0) return out;

  // Geometry: compact width — snug around command + description, not 96% of
  // the screen. Narrow terminals keep the full palette width for names.
  const paletteWidth =
    cols < 50
      ? Math.max(20, cols - 2)
      : Math.min(cols - 4, 56);
  const leftPad = Math.max(0, Math.floor((cols - paletteWidth) / 2));
  const innerWidth = paletteWidth - 2; // minus the two border columns

  // Rows available for command entries (top border + hint + bottom border).
  const bodyRows = Math.max(1, popupRows - 3);

  // ensureSelectedVisible over a sliding window of one-row items.
  const idx = Math.max(0, Math.min(cmdSuggestIdx, suggests.length - 1));
  let start = Math.max(0, Math.min(idx - Math.floor(bodyRows / 2), suggests.length - bodyRows));
  const end = Math.min(suggests.length, start + bodyRows);
  start = Math.max(0, Math.min(start, end - 1));

  // Row builders.
  const border = (glyph: string) =>
    " ".repeat(leftPad) + A.fgBorder + glyph + "─".repeat(paletteWidth - 2) + A.reset + "\r\n";

  const plainRow = (content: string): string => {
    const pad = Math.max(0, innerWidth - visibleWidth(content));
    return (
      " ".repeat(leftPad) + A.fgBorder + "│" + A.reset +
      content + " ".repeat(pad) +
      A.fgBorder + "│" + A.reset + "\r\n"
    );
  };

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

  // Description width: what remains after "/name" plus a two-cell gutter.
  for (let i = start; i < end; i++) {
    const cmd = suggests[i];
    const selected = i === idx;
    const bg = selected ? A.bgOverlay : "";
    const nameCell = Math.max(6, Math.floor(innerWidth * 0.42));
    const name = truncate(cmd.name, nameCell);
    const descMax = Math.max(0, innerWidth - nameCell - 2);
    const desc = cols < 44 ? "" : truncate(cmd.desc, descMax);

    const marker = selected ? A.fgCyan + A.bold + "● " + A.reset : "  ";
    const nameFmt = (selected ? A.fgCyan + A.bold : A.fgText) + name + A.reset;
    const descFmt = desc
      ? "  " + (selected ? A.fgText : A.fgSubtext) + desc + A.reset
      : "";
    out.push(highlightedRow(marker + nameFmt + descFmt, bg));
  }

  const hint = A.fgMuted + "↑↓ navigate · Tab complete · Enter run" + A.reset;
  const counter = A.fgSubtext + `${idx + 1} / ${suggests.length}` + A.reset;
  const hintPad = Math.max(2, innerWidth - visibleWidth(hint) - visibleWidth(counter));
  out.push(plainRow(hint + " ".repeat(hintPad) + counter));

  out.push(border("╰"));

  return out;
}
