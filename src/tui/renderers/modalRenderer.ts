import { A, T } from "../../term";
import { truncate, stripAnsi } from "../layout";
import type { PendingConfirmation } from "../types";

export function renderConfirmationModal(
  cols: number,
  rows: number,
  pendingConfirmation: PendingConfirmation
): string[] {
  const out: string[] = [];
  const boxW = Math.min(64, cols - 4);
  const boxH = 5;
  const startRow = Math.floor((rows - boxH) / 2);
  const startCol = Math.floor((cols - boxW) / 2);

  out.push(T.goto(startRow, startCol));
  out.push(A.bgRed + A.fgText + A.bold + "┌" + "─".repeat(boxW - 2) + "┐" + A.reset);

  out.push(T.goto(startRow + 1, startCol));
  const titleText = " 🛡️ Security Approval Required ";
  const titlePad = Math.max(0, boxW - 2 - titleText.length);
  out.push(A.bgRed + A.fgText + A.bold + "│" + titleText + " ".repeat(titlePad) + "│" + A.reset);

  out.push(T.goto(startRow + 2, startCol));
  const descText = " " + truncate(pendingConfirmation.prompt, boxW - 4);
  const descPad = Math.max(0, boxW - 2 - descText.length);
  out.push(A.bgRed + A.fgText + "│" + descText + " ".repeat(descPad) + "│" + A.reset);

  out.push(T.goto(startRow + 3, startCol));
  const hintText = " [Y] Once   [A] Allow for Session   [N] Deny ";
  const hintPad = Math.max(0, boxW - 2 - hintText.length);
  out.push(A.bgRed + A.fgText + A.bold + "│" + hintText + " ".repeat(hintPad) + "│" + A.reset);

  out.push(T.goto(startRow + 4, startCol));
  out.push(A.bgRed + A.fgText + A.bold + "└" + "─".repeat(boxW - 2) + "┘" + A.reset);

  return out;
}

export function renderToast(cols: number, toastMsg: string): string[] {
  if (!toastMsg) return [];
  const out: string[] = [];
  const isWarning =
    toastMsg.includes("⚠️") ||
    toastMsg.toLowerCase().includes("error") ||
    toastMsg.toLowerCase().includes("glitch") ||
    toastMsg.toLowerCase().includes("failed");

  const isSuccess =
    toastMsg.includes("✔") ||
    toastMsg.includes("✓") ||
    toastMsg.toLowerCase().includes("saved") ||
    toastMsg.toLowerCase().includes("resumed") ||
    toastMsg.toLowerCase().includes("switched");

  let borderColor = A.fgCyan;
  let fgColor = A.fgText;

  if (isWarning) {
    borderColor = A.fgYellow;
    fgColor = A.fgYellow;
  } else if (isSuccess) {
    borderColor = A.fgGreen;
    fgColor = A.fgGreen;
  }

  const toastText = ` ${toastMsg} `;
  const toastW = toastText.length + 2;
  const toastR = 2;
  const toastC = Math.max(1, Math.floor((cols - toastW) / 2));

  out.push(T.goto(toastR, toastC));
  out.push(borderColor + "╭" + "─".repeat(toastText.length) + "╮" + A.reset);
  out.push(T.goto(toastR + 1, toastC));
  out.push(borderColor + "│" + A.bgSurface + fgColor + A.bold + toastText + A.reset + borderColor + "│" + A.reset);
  out.push(T.goto(toastR + 2, toastC));
  out.push(borderColor + "╰" + "─".repeat(toastText.length) + "╯" + A.reset);

  return out;
}


export function renderSecretInputModal(
  cols: number,
  rows: number,
  state: { config: { title: string; placeholder: string }; buffer: string; cursor: number }
): string[] {
  const out: string[] = [];
  const boxW = Math.min(65, Math.max(40, cols - 4));
  const inputH = 7;
  const startRow = Math.floor((rows - inputH) / 2);
  const startCol = Math.floor((cols - boxW) / 2);

  out.push(T.goto(startRow, startCol));
  const title = ` ${state.config.title} `;
  out.push(A.fgBorder + "┌─" + A.bold + A.fgCyan + title + A.reset + A.fgBorder + "─".repeat(Math.max(0, boxW - 2 - title.length - 2)) + "┐" + A.reset);

  out.push(T.goto(startRow + 1, startCol));
  const hint = ` ${state.config.placeholder}:`;
  out.push(A.fgBorder + "│" + A.reset + A.fgSubtext + hint + " ".repeat(Math.max(0, boxW - 2 - stripAnsi(hint).length)) + A.fgBorder + "│" + A.reset);

  out.push(T.goto(startRow + 2, startCol));
  const bufLen = state.buffer.length;
  const cur = state.cursor;
  const maxContentWidth = Math.max(10, boxW - 4);

  let lineContent = "";
  if (bufLen === 0) {
    lineContent = " " + A.fgYellow + "█ (paste here)" + A.reset;
  } else {
    const maskedFull = "•".repeat(cur) + "█" + "•".repeat(Math.max(0, bufLen - cur));
    let visibleMasked = maskedFull;
    if (maskedFull.length > maxContentWidth) {
      const half = Math.floor(maxContentWidth / 2);
      const start = Math.max(0, Math.min(cur - half, maskedFull.length - maxContentWidth));
      visibleMasked = (start > 0 ? "…" : "") + maskedFull.slice(start, start + maxContentWidth - (start > 0 ? 1 : 0));
    }
    lineContent = " " + A.fgYellow + visibleMasked + A.reset;
  }
  out.push(A.fgBorder + "│" + A.reset + lineContent + " ".repeat(Math.max(0, boxW - 2 - stripAnsi(lineContent).length)) + A.fgBorder + "│" + A.reset);

  out.push(T.goto(startRow + 3, startCol));
  out.push(A.fgBorder + "├" + "─".repeat(boxW - 2) + "┤" + A.reset);

  out.push(T.goto(startRow + 4, startCol));
  const navHint = " Enter: Save │ Esc: Cancel";
  out.push(A.fgBorder + "│" + A.reset + A.fgMuted + navHint + " ".repeat(Math.max(0, boxW - 2 - stripAnsi(navHint).length)) + A.fgBorder + "│" + A.reset);

  out.push(T.goto(startRow + 5, startCol));
  out.push(A.fgBorder + "└" + "─".repeat(boxW - 2) + "┘" + A.reset);

  return out;
}
