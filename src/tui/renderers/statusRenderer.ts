import { A, T } from "../../term";
import { stripAnsi, truncate } from "../layout";
import { getCwdInfo } from "../../lib/codingAgent";
import { SPINNER, tuiState } from "../state";

export interface WorkingStatusState {
  showHelp: boolean;
  isStreaming: boolean;
  spinnerIdx: number;
  statusText: string;
  elapsedDisplay: string;
  primaryColor: string;
}

export interface FooterState {
  providerName?: string;
  currentModel?: string;
  workspacePath?: string;
  lastTokens?: string;
}

/**
 * Renders the live Working / Activity status line directly above the input box.
 */
export function renderWorkingStatus(
  cols: number,
  state: WorkingStatusState
): string {
  let content = "";

  if (state.showHelp) {
    content = A.fgYellow + "Shortcuts: Tab (mode) │ Ctrl+N (models) │ Esc (cancel) │ / (commands)" + A.reset;
  } else if (state.isStreaming) {
    const sp = SPINNER[state.spinnerIdx % SPINNER.length];
    const text = state.statusText || "Working...";
    const elapsed = state.elapsedDisplay ? ` · ${state.elapsedDisplay}` : "";
    content = A.fgCyan + A.bold + `${sp} ` + A.reset + A.fgCyan + text + A.reset + A.fgSubtext + elapsed + A.reset;
  } else if (state.statusText) {
    const isErr = state.statusText.startsWith("✖") || state.statusText.toLowerCase().includes("error");
    const isSuccess = state.statusText.startsWith("✔") || state.statusText.startsWith("✅");
    const fg = isErr ? A.fgRed : isSuccess ? A.fgGreen : state.primaryColor;
    const icon = isErr ? "✖" : isSuccess ? "✔" : "●";
    content = fg + A.bold + `${icon} ` + state.statusText + A.reset + (state.elapsedDisplay ? A.fgSubtext + ` · ${state.elapsedDisplay}` + A.reset : "");
  } else {
    const modeLabel = tuiState.agentMode === "Plan" ? "Planner" : "Builder";
    content = A.fgGreen + "● Ready" + A.reset + A.fgMuted + ` │ Mode: ${A.fgText}${modeLabel}${A.reset}${A.fgMuted} │ Enter: send │ Shift+Enter: newline │ Tab: mode` + A.reset;
  }

  const divider = T.clearLine + A.fgBorder + "─".repeat(cols) + A.reset + "\r\n";
  const stripped = stripAnsi(content);
  const pad = Math.max(0, cols - stripped.length - 1);
  const line = T.clearLine + " " + content + " ".repeat(pad) + "\r\n";
  return divider + line;
}

/**
 * Backward-compatible alias for renderWorkingStatus.
 */
export function renderStatusBar(
  cols: number,
  state: WorkingStatusState
): string {
  return renderWorkingStatus(cols, state);
}

/**
 * Renders the Input Area with border and prompt.
 */
export function renderInputArea(
  cols: number,
  inputBuffer: string,
  primaryColor: string
): string {
  const isTyping = inputBuffer.length > 0;
  const borderCol = isTyping ? primaryColor : A.fgBorder;
  const divider = T.clearLine + borderCol + "─".repeat(cols) + A.reset + "\r\n";

  const prompt = isTyping
    ? primaryColor + A.bold + "> " + A.reset
    : A.fgSubtext + A.bold + "> " + A.reset;
  const promptWidth = 2;

  // Single or multiline display for input bar
  const firstLine = inputBuffer.includes("\n") ? inputBuffer.split("\n")[0] + " ↵" : inputBuffer;
  const maxInputWidth = Math.max(10, cols - promptWidth - 4);
  const inputVisible = firstLine.length > maxInputWidth
    ? "…" + firstLine.slice(-(maxInputWidth - 1))
    : firstLine;

  const placeholder = inputBuffer === ""
    ? A.fgMuted + "Enter a coding task or / for commands" + A.reset
    : A.fgText + inputVisible + A.reset;

  const stripped = stripAnsi(prompt + placeholder);
  const pad = Math.max(0, cols - stripped.length - 1);
  const inputLine = T.clearLine + " " + prompt + placeholder + " ".repeat(pad) + A.reset + "\r\n";
  return divider + inputLine;
}

/**
 * Renders the persistent bottom Footer bar:
 * Provider: <name> │ Model: <model> │ Workspace: <path>
 */
export function renderFooter(
  cols: number,
  state?: FooterState
): string {
  const providerName = state?.providerName ?? tuiState.providerName;
  const currentModel = state?.currentModel ?? tuiState.currentModel;
  const { workspaceRoot } = getCwdInfo();
  const wsPath = state?.workspacePath ?? workspaceRoot;

  // Provider label
  const provLabel = providerName
    ? A.fgSubtext + "Provider: " + A.fgGreen + truncate(providerName, 18) + A.reset
    : A.fgSubtext + "Provider: " + A.fgYellow + "Not configured" + A.reset;

  // Model label
  const modelLabel = A.fgSubtext + "Model: " + A.fgText + truncate(currentModel || "none", 24) + A.reset;

  // Workspace path label (dynamically truncated based on terminal width)
  const maxWsLen = Math.max(12, Math.min(35, cols - 65));
  const wsLabel = A.fgSubtext + "Workspace: " + A.fgText + truncate(wsPath || process.cwd(), maxWsLen) + A.reset;

  const items = [provLabel, modelLabel, wsLabel];
  const sep = A.fgMuted + " │ " + A.reset;
  const footerContent = " " + items.join(sep);
  const stripped = stripAnsi(footerContent);
  const padding = Math.max(0, cols - stripped.length);

  const divider = T.clearLine + A.fgBorder + "─".repeat(cols) + A.reset + "\r\n";
  const bar = T.clearLine + A.bgSurface + footerContent + " ".repeat(padding) + A.reset;

  return divider + bar;
}
