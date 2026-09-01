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
  queuedCount?: number;
  nextQueuedText?: string;
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
  const queueBadge = state.queuedCount && state.queuedCount > 0
    ? ` │ ${A.fgYellow}${state.queuedCount} queued${A.reset}`
    : "";

  if (state.showHelp) {
    content = A.fgYellow + "Shortcuts: Tab (mode) │ Ctrl+N (models) │ Esc (cancel) │ / (commands)" + A.reset;
  } else if (state.isStreaming) {
    const sp = SPINNER[state.spinnerIdx % SPINNER.length];
    const text = state.statusText || "Working…";
    const elapsed = state.elapsedDisplay ? ` · ${state.elapsedDisplay.trim()}` : "";
    content = A.fgCyan + A.bold + `${sp} ` + A.reset + A.fgCyan + text + A.reset + A.fgSubtext + elapsed + A.reset + queueBadge;
  } else if (state.statusText) {
    const isErr = state.statusText.startsWith("✖") || state.statusText.startsWith("✗") || state.statusText.toLowerCase().includes("error") || state.statusText.toLowerCase().includes("failed");
    const isSuccess = state.statusText.startsWith("✔") || state.statusText.startsWith("✓") || state.statusText.startsWith("✅");
    const fg = isErr ? A.fgRed : isSuccess ? A.fgGreen : state.primaryColor;
    const defaultIcon = isErr ? "✖" : isSuccess ? "✔" : "●";
    const hasIconPrefix = /^[✖✗✔✓✅●]\s/.test(state.statusText);
    const displayText = hasIconPrefix ? state.statusText : `${defaultIcon} ${state.statusText}`;
    const elapsed = state.elapsedDisplay ? ` · ${state.elapsedDisplay.trim()}` : "";
    content = fg + A.bold + displayText + A.reset + (elapsed ? A.fgSubtext + elapsed + A.reset : "") + queueBadge;
  } else {
    const modeLabel = tuiState.agentMode === "Plan" ? "Planner" : "Builder";
    const nextInfo = state.nextQueuedText ? ` │ ${A.fgYellow}Next: ${truncate(state.nextQueuedText, 25)}${A.reset}` : "";
    content = A.fgGreen + "● Ready" + A.reset + A.fgMuted + ` │ Mode: ${A.fgText}${modeLabel}${A.reset}${A.fgMuted} │ Enter: send │ Shift+Enter: newline` + A.reset + queueBadge + nextInfo;
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

  if (!inputBuffer) {
    const prompt = A.fgSubtext + A.bold + "> " + A.reset;
    const placeholder = A.fgMuted + "Enter a coding task or / for commands" + A.reset;
    const stripped = stripAnsi(prompt + placeholder);
    const pad = Math.max(0, cols - stripped.length - 1);
    const inputLine = T.clearLine + " " + prompt + placeholder + " ".repeat(pad) + A.reset + "\r\n";
    return divider + inputLine;
  }

  const lines = inputBuffer.split("\n");
  const maxLinesToShow = Math.min(4, lines.length);
  const outLines: string[] = [divider];
  const startIdx = Math.max(0, lines.length - maxLinesToShow);

  for (let i = startIdx; i < lines.length; i++) {
    const isFirst = i === 0;
    const prompt = isFirst
      ? primaryColor + A.bold + "> " + A.reset
      : A.fgMuted + "… " + A.reset;
    const promptWidth = 2;
    const maxInputWidth = Math.max(10, cols - promptWidth - 4);
    const rawText = lines[i];
    const lineText = isFirst && lines.length > 1 ? rawText + " ↵" : rawText;
    const visible = lineText.length > maxInputWidth
      ? "…" + lineText.slice(-(maxInputWidth - 1))
      : lineText;
    const textFormatted = A.fgText + visible + A.reset;
    const stripped = stripAnsi(prompt + textFormatted);
    const pad = Math.max(0, cols - stripped.length - 1);
    outLines.push(T.clearLine + " " + prompt + textFormatted + " ".repeat(pad) + A.reset + "\r\n");
  }

  return outLines.join("");
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
  const isModelSelected = Boolean(
    currentModel &&
    currentModel !== "none" &&
    currentModel !== "default" &&
    currentModel !== "Not selected" &&
    !currentModel.startsWith("No provider") &&
    !currentModel.startsWith("No models") &&
    !currentModel.startsWith("Provider offline") &&
    !currentModel.startsWith("Loading...")
  );
  const modelText = isModelSelected ? truncate(currentModel, 24) : "Not selected";
  const modelColor = isModelSelected ? A.fgText : A.fgYellow;
  const modelLabel = A.fgSubtext + "Model: " + modelColor + modelText + A.reset;

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
