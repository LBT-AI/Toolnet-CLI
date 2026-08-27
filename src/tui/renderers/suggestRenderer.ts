import { A } from "../../term";
import { truncate } from "../layout";

export function renderSuggestionsPopup(
  cols: number,
  popupRows: number,
  suggests: Array<{ name: string; desc: string }>,
  cmdSuggestIdx: number,
  primaryColor: string
): string[] {
  const out: string[] = [];
  if (suggests.length === 0) return out;

  const listRows = popupRows - 1;
  let startIdx = 0;
  if (cmdSuggestIdx >= listRows) {
    startIdx = cmdSuggestIdx - listRows + 1;
  }

  for (let i = 0; i < listRows; i++) {
    const si = startIdx + i;
    if (si >= suggests.length) break;
    const cmd = suggests[si];
    const selected = si === cmdSuggestIdx;
    const bg = selected ? A.bgOverlay : A.bgSuggest;
    const nameFg = selected ? primaryColor + A.bold : primaryColor;
    const descFg = A.fgSubtext;
    const nameText = cmd.name.padEnd(14);
    const descText = truncate(cmd.desc, cols - 18);
    const line = bg + "  " + nameFg + nameText + A.reset + bg + descFg + descText + A.reset;
    const stripped = ("  " + nameText + descText).length;
    const pad = Math.max(0, cols - stripped - 2);
    out.push(line + bg + " ".repeat(pad) + A.reset + "\r\n");
  }

  out.push(A.bgSuggest + A.fgSubtext + " ↑↓ navigate  Tab/Enter select  Esc cancel ".padEnd(cols) + A.reset + "\r\n");
  return out;
}
