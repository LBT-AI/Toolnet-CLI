import { A } from "../../term";
import { truncate, stripAnsi } from "../layout";

export function renderSuggestionsPopup(
  cols: number,
  popupRows: number,
  suggests: Array<{ name: string; desc: string }>,
  cmdSuggestIdx: number,
  primaryColor: string
): string[] {
  const out: string[] = [];
  if (suggests.length === 0) return out;

  const boxWidth = Math.min(cols - 4, 70);
  const leftPad = 2;

  // Header of command palette
  const title = " Commands ";
  const topBorder = " ".repeat(leftPad) + A.fgBorder + "┌─" + A.bold + A.fgCyan + title + A.reset + A.fgBorder + "─".repeat(Math.max(0, boxWidth - title.length - 2)) + "┐" + A.reset + "\r\n";
  out.push(topBorder);

  const maxItems = Math.max(1, Math.min(suggests.length, popupRows - 3));
  let startIdx = 0;
  if (cmdSuggestIdx >= maxItems) {
    startIdx = cmdSuggestIdx - maxItems + 1;
  }

  for (let i = 0; i < maxItems; i++) {
    const si = startIdx + i;
    if (si >= suggests.length) break;
    const cmd = suggests[si];
    const selected = si === cmdSuggestIdx;

    const pointer = selected ? A.fgCyan + "● " + A.reset : "  ";
    const nameFg = selected ? A.bold + A.fgCyan : A.fgText;
    const nameText = cmd.name.padEnd(16);
    const descText = truncate(cmd.desc || "", boxWidth - 24);
    const lineContent = pointer + nameFg + nameText + A.reset + A.fgSubtext + descText + A.reset;
    const strippedLen = stripAnsi(lineContent).length;
    const innerPad = Math.max(0, boxWidth - strippedLen);

    const row = " ".repeat(leftPad) + A.fgBorder + "│ " + A.reset + lineContent + " ".repeat(innerPad) + A.fgBorder + "│" + A.reset + "\r\n";
    out.push(row);
  }

  // Footer navigation hint
  const hint = A.fgMuted + " ↑↓ navigate │ Enter/Tab select │ Esc close" + A.reset;
  const hintStripped = stripAnsi(hint).length;
  const hintPad = Math.max(0, boxWidth - hintStripped);
  const hintRow = " ".repeat(leftPad) + A.fgBorder + "│ " + A.reset + hint + " ".repeat(hintPad) + A.fgBorder + "│" + A.reset + "\r\n";
  out.push(hintRow);

  const bottomBorder = " ".repeat(leftPad) + A.fgBorder + "└" + "─".repeat(boxWidth) + "┘" + A.reset + "\r\n";
  out.push(bottomBorder);

  return out;
}
