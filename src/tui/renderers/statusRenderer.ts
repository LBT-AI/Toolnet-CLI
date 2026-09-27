import { A, T } from "../../term";
import { stripAnsi, truncate, visibleWidth, tailByCells, COMPOSER_MAX_BUFFER_LINES } from "../layout";
import { getCwdInfo } from "../../lib/codingAgent";
import { SPINNER, tuiState } from "../state";
import { supportsReasoning, reasoningEffortLabel, type AgentPhase } from "../../lib/reasoning";
import { describeAgentPhase, isActivePhase } from "../sessionStatus";

export interface WorkingStatusState {
  showHelp: boolean;
  isStreaming: boolean;
  spinnerIdx: number;
  statusText: string;
  elapsedDisplay: string;
  primaryColor: string;
  /**
   * Canonical lifecycle phase. When supplied, the line renders from it instead
   * of guessing from `statusText` — this is the production path (app.ts always
   * passes `tuiState.agentPhase`). Omitted callers keep the legacy behavior so
   * the renderer stays usable in isolation and in unit tests.
   */
  agentPhase?: AgentPhase;
  queuedCount?: number;
  nextQueuedText?: string;
  /**
   * Model / workspace echoed onto the ACTIVE line so the user reads one status
   * (`Working · model · /root · 13s`) instead of a header badge + a second bar
   * saying the same thing. The header suppresses its badge while this line is
   * drawn (see `statusLineActive` / `renderHeader` `statusDelegated`).
   */
  modelName?: string;
  workspacePath?: string;
  /**
   * Follow-ups admitted while the agent is BUSY (delivery = steer) that are not
   * yet promoted into the conversation. Shown so the user sees their prompt was
   * accepted instead of silently swallowed.
   */
  pendingInputs?: number;
}

export interface FooterState {
  providerName?: string;
  currentModel?: string;
  workspacePath?: string;
  lastTokens?: string;
  agentMode?: string;
  bypassMode?: boolean;
  /** Durable session title; omitted (never an empty separator) when absent. */
  sessionTitle?: string;
}

/**
 * Whether the working-status line should be drawn at all. Idle = no line
 * (the header badge already says idle); the line only appears when there is
 * something real to say: streaming, a transient result, help, or a queue.
 */
export function statusLineActive(state: WorkingStatusState): boolean {
  return Boolean(
    state.showHelp ||
    (state.agentPhase && isActivePhase(state.agentPhase)) ||
    state.isStreaming ||
    state.statusText ||
    (state.queuedCount && state.queuedCount > 0) ||
    (state.pendingInputs && state.pendingInputs > 0)
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

  // Canonical presentation (production path): the phase decides the label and
  // color. No substring matching on the rendered text.
  const canonical = state.agentPhase ? describeAgentPhase(state.agentPhase) : null;

  if (state.showHelp) {
    content = "Shortcuts: Tab mode · Ctrl+N models · / commands · Esc cancel";
    fg = A.fgYellow;
  } else if (canonical && canonical.animated) {
    const sp = SPINNER[state.spinnerIdx % SPINNER.length];
    const elapsed = state.elapsedDisplay ? ` ${state.elapsedDisplay.trim()}` : "";
    // ONE status system: phase · model · workspace · elapsed. The header badge
    // is suppressed for the duration (statusDelegated), so this is the only
    // place the live state is painted.
    const context = [state.modelName, state.workspacePath]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    content = `${sp} ${canonical.label}${context ? " · " + context : ""}${elapsed}`;
    fg = canonical.color;
  } else if (state.isStreaming) {
    // Legacy fallback: no canonical phase supplied (unit tests / non-TUI
    // callers). Preserves the historical text-based presentation.
    const sp = SPINNER[state.spinnerIdx % SPINNER.length];
    const text = state.statusText || "Working…";
    const elapsed = state.elapsedDisplay ? ` ${state.elapsedDisplay.trim()}` : "";
    content = `${sp} ${text}${elapsed}`;
    const lower = text.toLowerCase();
    if (lower.includes("think") || lower.includes("reason")) {
      fg = A.fgViolet;
    } else {
      fg = A.fgAmber;
    }
  } else if (state.statusText) {
    const isErr = state.statusText.startsWith("✖") || state.statusText.startsWith("✗") || /error|failed/i.test(state.statusText);
    const isSuccess = state.statusText.startsWith("✔") || state.statusText.startsWith("✓");
    const icon = isErr ? "✖" : isSuccess ? "✔" : "●";
    const hasIconPrefix = /^[✖✗✔✓✅●]\s/.test(state.statusText);
    content = hasIconPrefix ? state.statusText : `${icon} ${state.statusText}`;
    fg = isErr ? A.fgRed : isSuccess ? A.fgGreen : state.primaryColor;
  } else if (state.queuedCount && state.queuedCount > 0) {
    const nextText = state.nextQueuedText ? ` · Next: ${truncate(state.nextQueuedText, 30)}` : "";
    content = `${state.queuedCount} queued${nextText}`;
    fg = A.fgYellow;
  }

  // Pending steer badge — appended to whatever the line already says, so
  // "Working · 2 steers pending" stays one compact, stable row on mobile.
  if (state.pendingInputs && state.pendingInputs > 0) {
    const label = state.pendingInputs === 1 ? "steer" : "steers";
    content += `${content ? " · " : ""}${state.pendingInputs} ${label} pending`;
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
  // Color-density trim: the divider stays at the quiet border tone even while
  // typing — the bright `>` prompt is the focus cue, a full-width bright rule
  // competed with the transcript for attention on small terminals.
  const divider = T.clearLine + A.fgBorder + "─".repeat(cols - 1) + A.reset + "\r\n";

  if (!inputBuffer) {
    const prompt = A.reset + A.fgCyan + A.bold + "> " + A.reset;
    const placeholder = A.fgMuted + "Enter a coding task or / for commands" + A.reset;
    const pad = Math.max(0, cols - 1 - visibleWidth(prompt + placeholder));
    return divider + T.clearLine + prompt + placeholder + " ".repeat(pad) + A.reset + "\r\n";
  }

  const lines = inputBuffer.split("\n");
  // The layout budget assumes this exact cap (layout.ts); longer drafts
  // scroll inside the composer instead of consuming transcript rows.
  const maxLinesToShow = Math.min(COMPOSER_MAX_BUFFER_LINES, lines.length);
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

  // ONE canonical footer: segments are added by priority while they fit, so a
  // wide terminal shows the full metadata line and a 52-col phone keeps only
  // the identity core. Truncation never splits the line into two rows.
  const fits = (candidate: string[]): boolean => {
    const projected = visibleWidth(" " + [...segmentsSoFar, ...candidate].join(sep));
    return projected <= Math.max(10, cols - 2);
  };
  const segmentsSoFar: string[] = [];
  const addSegment = (candidate: string[], needed: boolean): void => {
    if (needed || fits(candidate)) segmentsSoFar.push(...candidate);
  };

  // Mode tag — only when non-default (Bypass or Plan); plain Build shows nothing.
  let modeTag = "";
  if (bypassMode) {
    modeTag = A.reset + A.fgRed + A.bold + "Bypass" + A.reset;
  } else if (agentMode === "Plan") {
    modeTag = A.reset + A.fgYellow + A.bold + "Plan" + A.reset;
  }

  // Priority order: identity core → mode → tokens → workspace → extras.
  // `needed` segments (provider/model) always render; the rest must fit whole.
  addSegment([item(providerFg, provVisible, 24)], true);
  addSegment([item(modelFg, modelVisible, 24)], true);
  if (modeTag) addSegment([modeTag], false);
  // Reasoning tag — capability-aware: only for models that actually reason,
  // and only while reasoning is enabled. Never guessed from the model name.
  if (
    currentModel &&
    isModelSelected &&
    supportsReasoning(currentModel) &&
    tuiState.reasoningSettings.enabled
  ) {
    const rLabel = reasoningEffortLabel(tuiState.reasoningSettings);
    addSegment([A.reset + A.fgCyan + "reasoning: " + rLabel + A.reset], false);
  }
  if (lastTokens) addSegment([A.reset + A.fgSubtext + lastTokens + A.reset], false);
  addSegment([item(wsFg, wsPath || process.cwd(), 28)], false);
  // Session title last — truncated to the remaining width (never below a
  // 12-cell stub, and dropped entirely only when even that stub would not
  // fit), so an untitled or very narrow session shows `model · workspace`
  // with no dangling separator and no second metadata row.
  const sessionTitle = state?.sessionTitle ?? tuiState.sessionTitle;
  if (sessionTitle) {
    const used = visibleWidth(" " + segmentsSoFar.join(sep));
    const budget = cols - 2 - used - visibleWidth(sep);
    if (budget >= 12) {
      segmentsSoFar.push(item(A.fgSubtext, sessionTitle, budget));
    }
  }

  const segments: string[] = segmentsSoFar;

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