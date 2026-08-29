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
  // Left side: ToolNet branding + mode pill
  const brand = A.bold + A.fgCyan + "ToolNet CLI" + A.reset;
  
  let modeColor = A.fgText;
  if (state.agentMode === "Plan") modeColor = A.fgYellow;
  else if (state.bypassMode) modeColor = A.fgRed;
  
  const bypassTag = state.bypassMode ? A.fgRed + ` [Bypass:${state.bypassLevel.toUpperCase()}]` + A.reset : "";
  const modeBadge = A.fgSubtext + " [" + modeColor + state.agentMode + A.fgSubtext + "]" + bypassTag + A.reset;
  
  const leftContent = brand + modeBadge;
  const leftStripped = stripAnsi(leftContent);

  // Right side: Live System Status badge (Idle / Thinking / Working / Error)
  let statusBadge = A.fgGreen + "● Idle" + A.reset;
  if (state.isStreaming) {
    const sp = SPINNER[(state.spinnerIdx || 0) % SPINNER.length];
    const isThinking = (state.statusText || "").toLowerCase().includes("think");
    if (isThinking) {
      statusBadge = A.fgYellow + A.bold + `${sp} Thinking` + A.reset;
    } else {
      statusBadge = A.fgCyan + A.bold + `${sp} Working` + A.reset;
    }
  } else if (state.statusText) {
    const isErr = state.statusText.startsWith("✖") || state.statusText.toLowerCase().includes("error");
    if (isErr) {
      statusBadge = A.fgRed + "✖ Error" + A.reset;
    }
  }

  const rightStripped = stripAnsi(statusBadge);
  const padding = Math.max(1, cols - leftStripped.length - rightStripped.length);

  const headerLine = T.clearLine + leftContent + " ".repeat(padding) + statusBadge + "\r\n";
  const divider = T.clearLine + A.fgBorder + "─".repeat(cols) + A.reset + "\r\n";

  return headerLine + divider;
}
