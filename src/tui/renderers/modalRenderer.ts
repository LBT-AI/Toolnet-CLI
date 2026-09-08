import { A, T } from "../../term";
import { truncate } from "../layout";
import type { PendingConfirmation } from "../types";
import { composeBox, maskLine } from "./composeBox";

export const APPROVAL_OPTIONS = [
  { key: "y", label: "Allow once" },
  { key: "a", label: "Allow for this session" },
  { key: "t", label: "Always trust this folder" },
  { key: "n", label: "Deny" },
] as const;

export type ApprovalOptionKey = (typeof APPROVAL_OPTIONS)[number]["key"];

/**
 * Security / permission confirmation modal. Deliberately calm: dim border,
 * no red background, subtle highlight on the focused option. Red is reserved
 * exclusively for the Deny option.
 */
export function renderConfirmationModal(
  cols: number,
  rows: number,
  pendingConfirmation: PendingConfirmation
): string[] {
  const sel = pendingConfirmation.selectedIndex ?? 0;
  const prompt = truncate(pendingConfirmation.prompt, 120);

  // Short title + friendly description (folder-trust reads like a
  // workspace-access gate, not an alarm).
  let title = "Security approval";
  let desc = prompt;
  const folder = /do you trust the folder (.+)\??$/i.exec(prompt.trim());
  if (folder) {
    title = "Workspace access";
    desc = "ToolNet needs access to: " + truncate(folder[1], 80);
  } else if (/requires permission/i.test(prompt)) {
    title = "Permission";
  }

  const body: string[] = [A.fgSubtext + desc + A.reset, ""];

  for (let i = 0; i < APPROVAL_OPTIONS.length; i++) {
    const opt = APPROVAL_OPTIONS[i];
    const isSel = i === sel;
    const label = truncate(opt.label, 44);
    if (isSel) {
      body.push(
        A.bgOverlay + A.fgCyan + A.bold + " ❯ " + A.reset + A.bgOverlay + A.fgText + label + A.reset
      );
    } else {
      const fg = opt.key === "n" ? A.fgRed : A.fgSubtext;
      body.push("   " + fg + label + A.reset);
    }
  }

  body.push("");
  return composeBox(cols, rows, {
    title,
    body,
    footer: "↑↓ navigate   enter select   esc cancel",
    accent: A.fgCyan,
  });
}

export function renderToast(cols: number, toastMsg: string): string[] {
  if (!toastMsg) return [];
  const out: string[] = [];
  const isWarning =
    toastMsg.includes("⚠️") ||
    toastMsg.toLowerCase().includes("error") ||
    toastMsg.toLowerCase().includes("glitch") ||
    toastMsg.toLowerCase().includes("failed") ||
    toastMsg.toLowerCase().includes("invalid");

  const isSuccess =
    toastMsg.includes("✔") ||
    toastMsg.includes("✓") ||
    toastMsg.toLowerCase().includes("saved") ||
    toastMsg.toLowerCase().includes("switched");

  let borderColor = A.fgBorder;
  let fgColor = A.fgText;
  let icon = "◦";
  if (isWarning) {
    borderColor = A.fgYellow;
    fgColor = A.fgYellow;
    icon = "▲";
  } else if (isSuccess) {
    borderColor = A.fgGreen;
    fgColor = A.fgGreen;
    icon = "✓";
  }

  const toastText = ` ${icon} ${toastMsg} `;
  const toastW = toastText.length + 2;
  const toastR = 1;
  const toastC = Math.max(1, Math.floor((cols - toastW) / 2));

  out.push(T.goto(toastR, toastC));
  out.push(borderColor + "╭" + "─".repeat(toastW - 2) + "╮" + A.reset);
  out.push(T.goto(toastR + 1, toastC));
  out.push(borderColor + "│" + A.reset + fgColor + toastText + A.reset + borderColor + "│" + A.reset);
  out.push(T.goto(toastR + 2, toastC));
  out.push(borderColor + "╰" + "─".repeat(toastW - 2) + "╯" + A.reset);

  return out;
}

/** API-key / secret ephemeral input in the shared modal design. */
export function renderSecretInputModal(
  cols: number,
  rows: number,
  state: { config: { title: string; placeholder: string }; buffer: string; cursor: number }
): string[] {
  const title = truncate(state.config.title || "Connect provider", 52);
  const hasValue = state.buffer.length > 0;
  const masked = maskLine(state.buffer, state.cursor, Math.max(10, Math.min(52, cols - 14)));

  const body: string[] = [
    A.fgSubtext + (state.config.placeholder || "API Key") + A.reset,
    "",
    (hasValue ? A.fgText + "> " + masked + A.reset : A.fgMuted + "> " + "•".repeat(6) + A.reset),
    "",
  ];

  return composeBox(cols, rows, {
    title: "Connect provider",
    body,
    footer: hasValue ? "Enter save · Esc cancel" : "Paste key · Enter save · Esc cancel",
  });
}