import { A } from "../../term";
import { stripAnsi, truncate } from "../layout";
import { composeBox, computeBoxGeometry } from "./composeBox";

export function renderSuggestionsPopup(
  cols: number,
  popupRows: number,
  suggests: Array<{ name: string; desc: string }>,
  cmdSuggestIdx: number,
  primaryColor: string
): string[] {
  const out: string[] = [];
  if (suggests.length === 0) return out;

  const isNarrow = cols < 50;
  const { boxW, startCol } = computeBoxGeometry(cols, 30, suggests.length, true, isNarrow ? 46 : 56);

  // Render the palette inline in the content area (it is part of the streamed
  // frame, drawn above the input). Compact, single-line entries.
  const leftPad = Math.max(1, Math.floor((cols - boxW) / 2));
  const title = A.bold + A.fgCyan + " Commands " + A.reset;
  const line = (content: string, clip: number) => {
    const visible = truncate(stripAnsi(content) ? content : "", clip);
    const pad = Math.max(0, boxW - stripAnsi(visible).length);
    return " ".repeat(leftPad) + A.fgBorder + "│ " + A.reset + visible + " ".repeat(pad) + A.fgBorder + "│" + A.reset + "\r\n";
  };

  out.push(" ".repeat(leftPad) + A.fgBorder + "╭" + "─".repeat(boxW - 2) + "╮" + A.reset + "\r\n");
  out.push(" ".repeat(leftPad) + A.fgBorder + "│ " + A.reset + title + " ".repeat(Math.max(0, boxW - 2 - stripAnsi(title).length - 2)) + A.fgBorder + "│" + A.reset + "\r\n");

  const maxItems = Math.max(1, Math.min(suggests.length, popupRows - 4));
  let startIdx = 0;
  if (cmdSuggestIdx >= maxItems) startIdx = cmdSuggestIdx - maxItems + 1;

  for (let i = 0; i < maxItems; i++) {
    const si = startIdx + i;
    if (si >= suggests.length) break;
    const cmd = suggests[si];
    const selected = si === cmdSuggestIdx;
    const namePad = isNarrow ? 8 : 12;
    const nameText = cmd.name.padEnd(namePad, " ");
    const pointer = selected ? A.fgCyan + "● " + A.reset : "  ";
    const nameFmt = selected ? A.bold + A.fgCyan + nameText + A.reset : A.fgText + nameText + A.reset;
    const descMax = Math.max(4, boxW - 4 - namePad - 6);
    const descFmt = A.fgSubtext + truncate(cmd.desc || "", descMax) + A.reset;
    let content = pointer + nameFmt + " " + descFmt;
    if (selected) content = A.bgOverlay + content + A.reset;
    out.push(line(content, boxW - 4));
  }

  const hint = A.fgMuted + "↑↓ navigate · Enter select · Esc close" + A.reset;
  out.push(line(hint, boxW - 4));
  out.push(" ".repeat(leftPad) + A.fgBorder + "╰" + "─".repeat(boxW - 2) + "╯" + A.reset + "\r\n");

  return out;
}
