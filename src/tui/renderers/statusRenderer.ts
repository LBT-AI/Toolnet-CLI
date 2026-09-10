import { A, T } from "../../term";
import { stripAnsi, truncate, visibleWidth, tailByCells } from "../layout";
import { getCwdInfo } from "../../lib/codingAgent";
import { SPINNER, tuiState } from "../state";
import { supportsReasoning, reasoningEffortLabel } from "../../lib/reasoning";

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
  agentMode?: string;
  bypassMode?: boolean;
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
  const visibleContent = visibleWidth(content) > maxContent ? truncate(content, maxContent) : content;
  const pad = Math.max(0, cols - 1 - visibleWidth(visibleContent));

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
    const pad = Math.max(0, cols - 1 - visibleWidth(prompt + placeholder));
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
    // Truncate by terminal cells so CJK/emoji input never overflows the row.
    const visible =
      visibleWidth(lineText) > maxInputWidth
        ? "…" + tailByCells(lineText, maxInputWidth - 1)
        : lineText;

    const textFormatted = A.fgText + visible + A.reset;
    const pad = Math.max(0, cols - 1 - visibleWidth(prompt + textFormatted));
    outLines.push(T.clearLine + prompt + textFormatted + " ".repeat(pad) + A.reset + "\r\n");
  }

  return outLines.join("");
}

/**
 * Bottom bar: `provider · model · [Plan|Bypass] · tokens · workspace` in one
 * tight line, no labels, no divider (the input divider already separates
 * content from chrome). Under 50 cols it stays one line, just truncated.
 */
export function renderFooter(
  cols: number,
  state?: FooterState
): string {
  const providerName = state?.providerName ?? tuiState.providerName;
  const currentModel = state?.currentModel ?? tuiState.currentModel;
  const agentMode = state?.agentMode ?? tuiState.agentMode;
  const bypassMode = state?.bypassMode ?? tuiState.bypassMode;
  const lastTokens = state?.lastTokens;
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

  // Mode tag — only when non-default (Bypass or Plan); plain Build shows nothing.
  let modeTag = "";
  if (bypassMode) {
    modeTag = A.reset + A.fgRed + A.bold + "Bypass" + A.reset;
  } else if (agentMode === "Plan") {
    modeTag = A.reset + A.fgYellow + A.bold + "Plan" + A.reset;
  }

  const segments: string[] = [item(providerFg, provVisible, 24)];
  segments.push(item(modelFg, modelVisible, 24));
  if (modeTag) segments.push(modeTag);
  // Reasoning tag — capability-aware: only for models that actually reason,
  // and only while reasoning is enabled. Never guessed from the model name.
  if (
    currentModel &&
    isModelSelected &&
    supportsReasoning(currentModel) &&
    tuiState.reasoningSettings.enabled
  ) {
    const rLabel = reasoningEffortLabel(tuiState.reasoningSettings);
    segments.push(A.reset + A.fgCyan + "reasoning: " + rLabel + A.reset);
  }
  if (lastTokens) segments.push(A.reset + A.fgSubtext + lastTokens + A.reset);
  segments.push(item(wsFg, wsPath || process.cwd(), 28));

  const content = " " + segments.join(sep);

  const maxContent = Math.max(10, cols - 1);
  const bar = truncate(content, maxContent);
  const padding = Math.max(0, cols - 1 - visibleWidth(bar));

  // Bottom bar: NO trailing newline. The footer sits on the very last grid
  // row; a '\r\n' at the bottom row would make a real terminal scroll the
  // whole screen up by one every frame (pushing the header off the top).
  // buildFrame() follows footer with clearDown + an absolute cursor goto.
  return T.clearLine + bar + " ".repeat(padding) + A.reset;
}