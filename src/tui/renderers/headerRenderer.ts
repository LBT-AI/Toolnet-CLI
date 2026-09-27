import { A, T } from "../../term";
import { stripAnsi, truncate } from "../layout";
import { SPINNER } from "../state";
import type { AgentPhase } from "../../lib/reasoning";
import { describeAgentPhase } from "../sessionStatus";

export interface HeaderState {
  agentMode: string;
  bypassMode: boolean;
  bypassLevel: string;
  isStreaming?: boolean;
  spinnerIdx?: number;
  statusText?: string;
  /**
   * Canonical lifecycle phase. When supplied the badge renders from it rather
   * than inferring "Thinking" from `statusText` — the production path passes
   * `tuiState.agentPhase`.
   */
  agentPhase?: AgentPhase;
  /**
   * True when the transient activity line below the transcript owns the live
   * status. Exactly ONE status indicator is painted at a time, so the header
   * falls back to a calm neutral dot instead of repeating the same label.
   */
  statusDelegated?: boolean;
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

  // Right side status badge (Idle / Working / Thinking / Error / Done).
  // While the activity line owns the live state this collapses to a neutral
  // dot: the header is identity chrome, not a second status bar.
  let statusBadge = A.reset + A.fgCyan + "● Idle" + A.reset;
  const canonical = state.agentPhase ? describeAgentPhase(state.agentPhase) : null;
  if (state.statusDelegated) {
    statusBadge = A.reset + A.fgMuted + "●" + A.reset;
  } else if (canonical && canonical.animated) {
    const sp = SPINNER[(state.spinnerIdx || 0) % SPINNER.length];
    statusBadge = A.reset + canonical.color + A.bold + `${sp} ` + A.reset + canonical.color + canonical.label + A.reset;
  } else if (state.isStreaming) {
    // Legacy fallback: no canonical phase supplied (isolated callers/tests).
    const sp = SPINNER[(state.spinnerIdx || 0) % SPINNER.length];
    const isThinking = (state.statusText || "").toLowerCase().includes("think");
    const color = isThinking ? A.fgViolet : A.fgAmber;
    const label = isThinking ? "Thinking" : "Working";
    statusBadge = A.reset + color + A.bold + `${sp} ` + A.reset + color + label + A.reset;
  } else if (state.statusText) {
    const isErr = state.statusText.startsWith("✖") || state.statusText.startsWith("✗") || state.statusText.toLowerCase().includes("error");
    const isDone = state.statusText.startsWith("✔") || state.statusText.startsWith("✓") || state.statusText.toLowerCase().includes("done");
    if (isErr) {
      statusBadge = A.reset + A.fgRed + "✖ Error" + A.reset;
    } else if (isDone) {
      statusBadge = A.reset + A.fgGreen + "✓ Done" + A.reset;
    }
  }

  const leftContent = brand + modeTag;
  const leftLen = stripAnsi(leftContent).length;
  const rightLen = stripAnsi(statusBadge).length;
  const maxLeft = Math.max(8, cols - 1 - rightLen);
  const leftVisible = leftLen > maxLeft ? truncate(leftContent, maxLeft) : leftContent;
  const leftVisibleLen = stripAnsi(leftVisible).length;
  const padding = Math.max(1, cols - 1 - leftVisibleLen - rightLen);

  // A softly lit header strip (navy panel) instead of bare terminal black.
  const headerLine = T.clearLine + A.bgPanel + leftVisible + " ".repeat(padding) + statusBadge + A.reset + "\r\n";
  const divider = T.clearLine + A.fgBorder + "─".repeat(cols - 1) + A.reset + "\r\n";

  return headerLine + divider;
}