import { A, T } from "../../term";
import { stripAnsi, truncate } from "../layout";
import { SPINNER } from "../state";

export interface HeaderState {
  agentMode: string;
  bypassMode: boolean;
  bypassLevel: string;
  isStreaming?: boolean;
  spinnerIdx?: number;
  statusText?: string;
}

export function renderHeader(
  cols: number,
  state: HeaderState
): string {
  const isTiny = cols < 50;

  // Brand (compact on tiny screens)
  const brand = A.reset + A.bold + A.fgCyan + (isTiny ? "ToolNet" : "ToolNet CLI") + A.reset;

  // Mode/risk tag — only when non-default, never on a plain idle Build
  let modeTag = "";
  if (state.bypassMode) {
    modeTag = A.reset + A.fgRed + A.bold + ` Bypass:${state.bypassLevel.toUpperCase()}` + A.reset;
  } else if (state.agentMode === "Plan") {
    modeTag = A.reset + A.fgYellow + A.bold + " Plan" + A.reset;
  }

  // Right side status badge (Idle / Working / Thinking / Error)
  let statusBadge = A.reset + A.fgCyan + "● Idle" + A.reset;
  if (state.isStreaming) {
    const sp = SPINNER[(state.spinnerIdx || 0) % SPINNER.length];
    const isThinking = (state.statusText || "").toLowerCase().includes("think");
    statusBadge = A.reset + (isThinking ? A.fgYellow : A.fgCyan) + A.bold + `${sp} ` + A.reset + (isThinking ? A.fgYellow : A.fgCyan) + (isThinking ? "Thinking" : "Working") + A.reset;
  } else if (state.statusText) {
    const isErr = state.statusText.startsWith("✖") || state.statusText.toLowerCase().includes("error");
    if (isErr) {
      statusBadge = A.reset + A.fgRed + "✖ Error" + A.reset;
    }
  }

  const leftContent = brand + modeTag;
  const leftLen = stripAnsi(leftContent).length;
  const rightLen = stripAnsi(statusBadge).length;
  const maxLeft = Math.max(8, cols - 1 - rightLen);
  const leftVisible = leftLen > maxLeft ? truncate(leftContent, maxLeft) : leftContent;
  const leftVisibleLen = stripAnsi(leftVisible).length;
  const padding = Math.max(1, cols - 1 - leftVisibleLen - rightLen);

  const headerLine = T.clearLine + leftVisible + " ".repeat(padding) + statusBadge + "\r\n";
  const divider = T.clearLine + A.fgBorder + "─".repeat(cols - 1) + A.reset + "\r\n";

  return headerLine + divider;
}