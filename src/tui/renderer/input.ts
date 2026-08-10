import { A, T } from "../../term";
import { store, COMMANDS } from "../store";
import { truncate } from "../utils/string";

function getSuggestions(input: string) {
  if (!input.startsWith("/")) return [];
  const search = input.toLowerCase();
  return COMMANDS.filter(c => c.name.startsWith(search));
}

export function renderInputAndPopups(cols: number, rows: number, primaryColor: string): string[] {
  const out: string[] = [];
  const activeSuggests = getSuggestions(store.inputBuffer);
  const popupRows = activeSuggests.length > 0 ? Math.min(activeSuggests.length, 8) + 1 : 0;

  // ── Slash command suggestions popup (above input) ──
  if (activeSuggests.length > 0) {
    const listRows = popupRows - 1;
    if (store.cmdSuggestIdx >= activeSuggests.length) store.cmdSuggestIdx = activeSuggests.length - 1;
    for (let si = 0; si < listRows; si++) {
      const cmd = activeSuggests[si];
      const selected = si === store.cmdSuggestIdx;
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
  }

  // ── Toast Notification ──
  if (store.toastMsg) {
    const toastW = store.toastMsg.length + 4;
    const toastR = 2; // top margin
    const toastC = Math.max(1, Math.floor((cols - toastW) / 2));
    out.push(T.goto(toastR, toastC));
    out.push(A.bgOverlay + A.fgText + A.bold + "  " + store.toastMsg + "  " + A.reset);
  }

  // ── Input border (Micro-interaction: Lights up when typing) ──
  const isTyping = store.inputBuffer.length > 0;
  const borderCol = isTyping ? primaryColor : A.fgSubtext + A.dim;
  out.push(borderCol + "─".repeat(cols) + A.reset + "\r\n");

  // ── Input bar (Micro-interaction: Prompt icon changes color) ──
  const prompt = isTyping ? primaryColor + A.bold + " ❯ " + A.reset : A.fgSubtext + A.bold + " ❯ " + A.reset;
  const promptWidth = 3;
  const chars = Array.from(store.inputBuffer);
  const inputVisible = chars.length > cols - promptWidth - 4
    ? "…" + chars.slice(-(cols - promptWidth - 5)).join("")
    : store.inputBuffer;
  const placeholder = store.inputBuffer === ""
    ? A.fgSubtext + A.dim + "Ask anything... (/help for commands)" + A.reset
    : A.fgText + inputVisible + A.reset;

  out.push(
    prompt +
    (store.inputBuffer === "" ? placeholder : A.fgText + inputVisible + A.reset) +
    A.reset + "\r\n"
  );

  return out;
}
