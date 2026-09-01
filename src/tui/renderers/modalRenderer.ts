import { A, T } from "../../term";
import { truncate } from "../layout";
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
