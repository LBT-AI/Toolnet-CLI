import { A, T } from "../../term";
import { truncateVisible, visibleWidth, wrapVisible } from "../layout";
import type { PendingConfirmation, DeviceCodeModalState } from "../types";
import { composeBox, maskLine } from "./composeBox";
import type { ModalAnimationRenderState } from "../animations/modalAnimation";

export const APPROVAL_OPTIONS = [
  { key: "y", label: "Allow once" },
  { key: "a", label: "Allow for this session" },
  { key: "t", label: "Always trust this folder" },
  { key: "n", label: "Deny" },
] as const;

export type ApprovalOptionKey = (typeof APPROVAL_OPTIONS)[number]["key"];

const MODAL_MIN_WIDTH = 38;
const MODAL_MAX_WIDTH = 58;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Width of the confirmation modal, including its two border columns. */
export function calculateConfirmationModalWidth(cols: number): number {
  if (cols < 60) {
    // Keep at least two cells of margin on narrow terminals. Below the
    // nominal minimum, the terminal wins so the frame remains drawable.
    return Math.min(cols - 4, clamp(cols - 6, MODAL_MIN_WIDTH, MODAL_MAX_WIDTH));
  }
  return clamp(cols - 6, MODAL_MIN_WIDTH, MODAL_MAX_WIDTH);
}

function workspaceDescription(prompt: string, contentWidth: number, compact: boolean): string[] {
  const folder = /do you trust the folder\s+(.+?)\??$/i.exec(prompt.trim());
  if (!folder) {
    return wrapVisible(prompt, contentWidth);
  }

  const workspacePath = folder[1].replace(/\?$/, "").trim();
  const prefix = compact ? "Access to" : "ToolNet needs access to";
  const combined = `${prefix} ${workspacePath}`;
  if (visibleWidth(combined) <= contentWidth) return [combined];

  if (compact) {
    // A narrow viewport must keep the option list intact. Prefer one concise,
    // cell-bounded description line over consuming rows with a long path.
    return [truncateVisible(combined, contentWidth)];
  }

  const pathLines = wrapVisible(workspacePath, contentWidth);
  if (visibleWidth(prefix) + 1 + visibleWidth(pathLines[0]) <= contentWidth) {
    return [`${prefix} ${pathLines[0]}`, ...pathLines.slice(1, 2)];
  }
  return [prefix, truncateVisible(pathLines[0], contentWidth)];
}

function optionLabel(label: string, compact: boolean): string {
  if (!compact) return label;
  switch (label) {
    case "Allow for this session": return "Allow for session";
    case "Always trust this folder": return "Always trust";
    default: return label;
  }
}

/**
 * Security / permission confirmation modal. Permission state and key handling
 * remain unchanged; this renderer only builds a sized, centered frame.
 */
export function renderConfirmationModal(
  cols: number,
  rows: number,
  pendingConfirmation: PendingConfirmation,
  animation: ModalAnimationRenderState | null = null
): string[] {
  const selectedIndex = Math.min(
    Math.max(0, pendingConfirmation.selectedIndex ?? 0),
    APPROVAL_OPTIONS.length - 1
  );
  const modalWidth = calculateConfirmationModalWidth(cols);
  const contentWidth = Math.max(1, modalWidth - 4);
  const compact = cols < 60;
  const prompt = pendingConfirmation.prompt || "Permission required";

  let title = "Security approval";
  let description = workspaceDescription(prompt, contentWidth, compact);
  const folderPrompt = /do you trust the folder\s+(.+?)\??$/i.test(prompt.trim());
  if (folderPrompt) {
    title = "Workspace access";
  } else if (/requires permission/i.test(prompt)) {
    title = "Permission";
  }

  const body: string[] = description.map((line) => A.fgSubtext + truncateVisible(line, contentWidth) + A.reset);
  body.push("");

  for (let i = 0; i < APPROVAL_OPTIONS.length; i++) {
    const option = APPROVAL_OPTIONS[i];
    const transitionSelected = animation?.selectionFrom !== undefined &&
      animation.selectionTo !== undefined &&
      animation.selectionProgress !== undefined
      ? (animation.selectionProgress >= 0.5 ? animation.selectionTo : animation.selectionFrom)
      : selectedIndex;
    const selected = i === transitionSelected;
    const closingFlash = animation?.animation.phase === "closing" &&
      animation.closingSelectedIndex === i &&
      animation.progress < 0.35;
    const label = optionLabel(option.label, compact);
    const labelColor = option.key === "n" ? A.fgRed : A.fgText;
    if (selected) {
      body.push(
        A.fgCyan + A.bold + "❯ " + A.reset +
        labelColor + (closingFlash ? A.bold + A.fgCyan : A.bold) + label + A.reset
      );
    } else {
      body.push(
        "  " +
        (option.key === "n" ? A.fgRed : A.fgSubtext) + label + A.reset
      );
    }
  }

  body.push("");
  const footer = compact ? "↑↓ · enter · esc" : "↑↓ navigate   enter select   esc cancel";

  return composeBox(cols, rows, {
    title,
    body,
    footer,
    width: modalWidth,
    accent: A.fgCyan,
    borderColor: A.fgBorder,
    animation,
  });
}

/**
 * OAuth device-flow modal — pure renderer, returns string[] only.
 * Shows the provider, the user code to type, and the verification URL.
 */
export function renderDeviceCodeModal(
  cols: number,
  rows: number,
  state: DeviceCodeModalState
): string[] {
  const body: string[] = [
    A.fgSubtext + "Authorize " + A.fgText + truncateVisible(state.provider, 24) + A.reset,
    "",
  ];
  if (state.userCode) {
    body.push(A.fgSubtext + "Enter this code:" + A.reset);
    body.push(A.bold + A.fgCyan + "  " + truncateVisible(state.userCode, 40) + A.reset);
    body.push("");
  }
  body.push(A.fgSubtext + "Open in a browser:" + A.reset);
  body.push(A.fgText + truncateVisible(state.verificationUriComplete || state.verificationUri, 46) + A.reset);
  body.push("");
  body.push(A.fgMuted + truncateVisible(state.statusText, 46) + A.reset);
  body.push("");
  return composeBox(cols, rows, {
    title: "Device authorization",
    body,
    footer: "esc cancel",
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
  const toastW = visibleWidth(toastText) + 2;
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
  const title = truncateVisible(state.config.title || "Connect provider", 52);
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