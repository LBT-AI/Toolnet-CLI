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
 * Whether the working-status line should be drawn at all. Idle = no line
 * (the header badge already says idle); the line only appears when there is
 * something real to say: streaming, a transient result, help, or a queue.
 */
export function statusLineActive(state: WorkingStatusState): boolean {
  return Boolean(
    state.showHelp ||
    state.isStreaming ||
    state.statusText ||
    (state.queuedCount && state.queuedCount > 0)
  );
}

/**
 * Single-line activity status, shown ONLY when active (see statusLineActive).
 * No divider — the input divider below it is the only rule in that region.
 */
export function renderWorkingStatus(
  cols: number,
  state: WorkingStatusState
): string {
  if (!statusLineActive(state)) return "";

  const queueBadge = state.queuedCount && state.queuedCount > 0
    ? ` ${A.fgYellow}${state.queuedCount} queued${A.reset}`
    : "";

  let content = "";
  let fg = state.primaryColor;

  if (state.showHelp) {
    content = "Shortcuts: Tab mode · Ctrl+N models · / commands · Esc cancel";
    fg = A.fgYellow;
  } else if (state.isStreaming) {
    const sp = SPINNER[state.spinnerIdx % SPINNER.length];
    const text = state.statusText || "Working…";
    const elapsed = state.elapsedDisplay ? ` ${state.elapsedDisplay.trim()}` : "";
    content = `${sp} ${text}${elapsed}`;
  } else if (state.statusText) {
    const isErr = state.statusText.startsWith("✖") || state.statusText.startsWith("✗") || /error|failed/i.test(state.statusText);
    const isSuccess = state.statusText.startsWith("✔") || state.statusText.startsWith("✓");
    const icon = isErr ? "✖" : isSuccess ? "✔" : "●";
    const hasIconPrefix = /^[✖✗✔✓✅●]\s/.test(state.statusText);
    content = hasIconPrefix ? state.statusText : `${icon} ${state.statusText}`;
    fg = isErr ? A.fgRed : isSuccess ? A.fgGreen : state.primaryColor;
  } else {
    const nextText = state.nextQueuedText ? ` · Next: ${truncate(state.nextQueuedText, 30)}` : "";
    content = `${state.queuedCount} queued${nextText}`;
    fg = A.fgYellow;
  }

  const maxContent = Math.max(8, cols - 3);
  const visibleContent = stripAnsi(content).length > maxContent ? truncate(content, maxContent) : content;
  const stripped = stripAnsi(visibleContent);
  const pad = Math.max(0, cols - 1 - stripped.length);

  return T.clearLine + fg + " " + visibleContent + A.reset + queueBadge + " ".repeat(pad) + "\r\n";
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
 * Renders the Input Area: a single thin divider plus the prompt line.
 * No surrounding box — Claude-Code style, keeps vertical space tight.
 */
export function renderInputArea(
  cols: number,
  inputBuffer: string,
  primaryColor: string
): string {
  const isTyping = inputBuffer.length > 0;
  const dividerCol = isTyping ? primaryColor : A.fgBorder;
  const divider = T.clearLine + dividerCol + "─".repeat(cols - 1) + A.reset + "\r\n";

  if (!inputBuffer) {
    const prompt = A.reset + A.fgCyan + A.bold + "> " + A.reset;
    const placeholder = A.fgMuted + "Enter a coding task or / for commands" + A.reset;
    const stripped = stripAnsi(prompt + placeholder);
    const pad = Math.max(0, cols - 1 - stripped.length);
    return divider + T.clearLine + prompt + placeholder + " ".repeat(pad) + A.reset + "\r\n";
  }

  const lines = inputBuffer.split("\n");
  const maxLinesToShow = Math.min(3, lines.length);
  const outLines: string[] = [divider];
  const startIdx = Math.max(0, lines.length - maxLinesToShow);

  for (let i = startIdx; i < lines.length; i++) {
    const isFirst = i === 0;
    const prompt = isFirst
      ? primaryColor + A.bold + "> " + A.reset
      : A.fgMuted + "… " + A.reset;
    const promptWidth = 2;
    const maxInputWidth = Math.max(10, cols - promptWidth - 3);
    const rawText = lines[i];
    const lineText = isFirst && lines.length > 1 ? rawText + " ↵" : rawText;
    const visible = lineText.length > maxInputWidth
      ? "…" + lineText.slice(-(maxInputWidth - 1))
      : lineText;
    const textFormatted = A.fgText + visible + A.reset;
    const stripped = stripAnsi(prompt + textFormatted);
    const pad = Math.max(0, cols - 1 - stripped.length);
    outLines.push(T.clearLine + prompt + textFormatted + " ".repeat(pad) + A.reset + "\r\n");
  }

  return outLines.join("");
}

/**
 * Bottom bar: `provider · model · workspace` in one tight line, no labels,
 * no divider (the input divider already separates content from chrome).
 * Under 50 cols it stays the same line, just truncated harder.
 */
export function renderFooter(
  cols: number,
  state?: FooterState
): string {
  const providerName = state?.providerName ?? tuiState.providerName;
  const currentModel = state?.currentModel ?? tuiState.currentModel;
  const { workspaceRoot } = getCwdInfo();
  const wsPath = state?.workspacePath ?? workspaceRoot;

  const provVisible = providerName || "Not configured";
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
  const modelVisible = isModelSelected ? currentModel : "Not selected";

  const providerFg = providerName ? A.fgCyan : A.fgMuted;
  const modelFg = isModelSelected ? A.fgText : A.fgMuted;
  const wsFg = A.fgSubtext;

  const item = (fg: string, text: string, max: number) => fg + truncate(text, max) + A.reset;
  const sep = A.fgMuted + " · " + A.reset;

  // Budget the terminal width: provider gets most, model second, cwd last.
  const maxTotal = cols - 1;
  const provMax = Math.max(6, Math.floor(maxTotal * 0.4));
  const modelMax = Math.max(6, Math.floor((maxTotal - provMax - 3) * 0.45));
  const wsMax = Math.max(4, maxTotal - provMax - modelMax - 4);

  const content = " " + item(providerFg, provVisible, provMax) + sep + item(modelFg, modelVisible, modelMax) + sep + item(wsFg, wsPath || process.cwd(), wsMax);

  const maxContent = Math.max(10, maxTotal);
  const bar = truncate(content, maxContent);
  const strippedLen = stripAnsi(bar).length;
  const padding = Math.max(0, maxTotal - strippedLen);

  // Bottom bar: NO trailing newline. The footer sits on the very last grid
  // row; a '\r\n' at the bottom row would make a real terminal scroll the
  // whole screen up by one every frame (pushing the header off the top).
  // buildFrame() follows footer with clearDown + an absolute cursor goto.
  return T.clearLine + bar + " ".repeat(padding) + A.reset;
}