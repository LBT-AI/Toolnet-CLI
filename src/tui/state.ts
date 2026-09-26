import {
  saveSession,
  loadSession,
  listAllSessions,
  listSessionSummaries,
  deleteSessionFile,
  createNewSession,
} from "../lib/sessionPersistence";
import { bypassEngine } from "../lib/bypass";
import type { Msg, PendingConfirmation, Overlay } from "./types";
import { updateCrashGoal } from "../lib/crashRecovery";
import { pendingInputs } from "../core/agent/pendingInput";
import { readPendingInputs } from "../core/session/pendingInputJournal";
import { createChatViewport, type ChatViewportState } from "./viewport";
import {
  loadAllSkills,
  loadResolvedSkillsSync,
  getSkillById,
  getSkillByIdSync,
  ensureSkillInstructions,
  toggleSkillEnabled,
  type SkillInfo,
} from "../lib/skillsLoader";
import { messageQueue } from "../lib/messageQueue";
import { setCurrentSessionId as bindCurrentContextSession } from "../lib/context";
import { setResponseLanguage } from "../lib/language";
import { listProviders, getDefaultProviderConfig } from "../providers/registry";
import {
  DEFAULT_REASONING_SETTINGS,
  type AgentPhase,
  type ReasoningBlock,
  type ReasoningSettings,
} from "../lib/reasoning";
import type { SessionItem } from "./renderers/sessionPickerRenderer";
import { classifyToolAction, type ToolCategory } from "../lib/commandClassifier";
import { prettyToolTarget } from "../lib/tool-format";

export interface ActiveToolActivity {
  callId: string;
  name: string;
  args: any;
  category: ToolCategory;
  actionLabel: string;
  target?: string;
  startedAt: number;
  elapsedMs: number;
  tail?: string[];
  status: "running" | "completed" | "error" | "cancelled";
  isBackground?: boolean;
  jobId?: string;
}

export interface AssistantDraft {
  /** Stable transcript id for the one in-flight assistant message in this turn. */
  id: string;
  runId: string;
  turnId: number;
  streaming: boolean;
}

export const SPINNER = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

export class TuiState {
  appState: string = "boot";
  messages: Msg[] = [];
  private _currentSessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  get currentSessionId(): string { return this._currentSessionId; }
  set currentSessionId(sessionId: string) {
    if (!sessionId) return;
    this._currentSessionId = sessionId;
    bindCurrentContextSession(sessionId);
  }
  /**
   * Durable session title (`title` on the session record). Undefined while the
   * session is still untitled — the workspace path is only a DISPLAY fallback
   * and is never written here. Populated by the background auto-title task, an
   * explicit rename, or a resume.
   */
  sessionTitle: string | undefined = undefined;
  currentModel = "";
  agentMode: "Build" | "Plan" = "Build";
  /** Response language preference — "auto" follows the user's latest message. */
  responseLanguage: "vi" | "en" | "zh" | "auto" = "auto";

  /** Agent lifecycle phase (thinking / working / streaming / done ...). */
  agentPhase: AgentPhase = "idle";
  /** Reasoning/thinking configuration — capability-aware. */
  reasoningSettings: ReasoningSettings = { ...DEFAULT_REASONING_SETTINGS };
  /** Streamed reasoning text from the provider (only when actually provided). */
  reasoningText = "";
  reasoningCollapsed = false;
  reasoningTokens = 0;
  reasoningElapsed = "";

  // ── Live reasoning draft (canonical stream lifecycle) ────────────────────
  /** Correlation id of the in-flight agent run; empty when idle. */
  currentRunId: string = "";
  /** Zero-based turn counter within the current run; advanced on tool calls. */
  currentTurnId = 0;
  /**
   * In-flight reasoning block for the active turn. Null when no reasoning
   * stream is open; non-null blocks are rendered live and finalized into the
   * transcript on the next lifecycle boundary (tool call / text / completion).
   */
  activeReasoningDraft: ReasoningBlock | null = null;
  /**
   * Canonical multi-tool live activity store, keyed by tool call id.
   *
   * The core runs independent read-only tools in PARALLEL within one model
   * turn (see ToolPlanner), so a single slot silently drops every tool but the
   * last — the UI would look like one tool ran while N actually did. Keying by
   * callId keeps each tool's own timer, progress tail and lifecycle.
   *
   * This is UI state ONLY: it is never the source of truth for the transcript
   * or a tool result (the engine owns those).
   */
  private toolActivities = new Map<string, ActiveToolActivity>();

  /**
   * Live RUNNING activities, oldest→newest so the render order is stable.
   * Returned by reference: renderers and tests read `elapsedMs`/`tail` without
   * a per-frame copy.
   */
  getActiveToolActivities(): ActiveToolActivity[] {
    return [...this.toolActivities.values()]
      .filter((activity) => activity.status === "running")
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Look up one activity by call id (running or settled). */
  findToolActivity(callId: string): ActiveToolActivity | undefined {
    return this.toolActivities.get(callId);
  }

  /** True when a call id has a live activity (avoids duplicate transcript rows). */
  hasActiveToolActivity(callId: string): boolean {
    return this.toolActivities.has(callId);
  }

  /** Remove every live activity (run reset / abort teardown). */
  clearToolActivities(): void {
    this.toolActivities.clear();
  }

  /**
   * Backward-compatible primary accessor. Prefers the most recently started
   * RUNNING activity; falls back to the most recently started one so status
   * reads after completion still work. Assigning replaces the whole set — the
   * old single-slot API is preserved for callers and tests that used it.
   */
  get activeToolActivity(): ActiveToolActivity | null {
    const all = [...this.toolActivities.values()];
    if (all.length === 0) return null;
    const running = all.filter((activity) => activity.status === "running");
    const pool = running.length > 0 ? running : all;
    return pool.reduce((latest, activity) => (activity.startedAt >= latest.startedAt ? activity : latest));
  }

  set activeToolActivity(activity: ActiveToolActivity | null) {
    this.toolActivities.clear();
    if (activity) this.toolActivities.set(activity.callId, activity);
  }

  /** One canonical assistant draft for the current model response. */
  activeAssistantDraft: AssistantDraft | null = null;
  private currentAssistantMessageId: string | null = null;
  private currentAssistantTurnId: number | null = null;
  private messageSeq = 0;
  private pendingToolCalls = new Map<string, number>();
  private completedToolCallTurnId: number | null = null;

  private resetAssistantTurnState(): void {
    this.activeAssistantDraft = null;
    this.currentAssistantMessageId = null;
    this.currentAssistantTurnId = null;
    this.pendingToolCalls.clear();
    this.completedToolCallTurnId = null;
  }

  private nextMessageId(prefix = "msg"): string {
    this.messageSeq += 1;
    return `${prefix}_${Date.now()}_${this.messageSeq}_${Math.random().toString(36).slice(2, 6)}`;
  }

  private withMessageId(message: Msg): Msg {
    if (typeof message.id === "string" && message.id) return message;
    return { ...message, id: this.nextMessageId(message.role) };
  }

  appendMessage(message: Msg): Msg {
    const normalized = this.withMessageId(message);
    this.messages.push(normalized);
    return normalized;
  }

  replaceMessages(messages: readonly Msg[]): Msg[] {
    const nextMessages = messages.map((message) => this.withMessageId(message));
    const hasSharedAnchor = this.chatViewport.anchorMessageId
      ? nextMessages.some((message) => message.id === this.chatViewport.anchorMessageId)
      : false;

    this.messages = nextMessages;
    this.chatLineMessageIds = [];
    this.scrollOffset = 0;

    if (hasSharedAnchor) {
      this.chatViewport.followTail = false;
      this.chatViewport.lastContentHeight = 0;
      return this.messages;
    }

    this.chatViewport.topRow = 0;
    this.chatViewport.followTail = true;
    this.chatViewport.anchorMessageId = null;
    this.chatViewport.anchorRowOffset = 0;
    this.chatViewport.lastContentHeight = 0;
    return this.messages;
  }

  clearMessages(): void {
    this.messages = [];
    this.chatLineMessageIds = [];
    this.scrollOffset = 0;
    this.chatViewport.topRow = 0;
    this.chatViewport.followTail = true;
    this.chatViewport.anchorMessageId = null;
    this.chatViewport.anchorRowOffset = 0;
  }

  private registerToolCall(callId: string, turnId: number): void {
    this.pendingToolCalls.set(callId, turnId);
  }

  private completeToolCall(callId: string): void {
    const turnId = this.pendingToolCalls.get(callId);
    this.pendingToolCalls.delete(callId);
    if (turnId !== undefined && this.pendingToolCalls.size === 0) {
      this.completedToolCallTurnId = turnId;
    }
  }

  private advanceTurnAfterTools(): void {
    if (this.completedToolCallTurnId === this.currentTurnId) {
      this.currentTurnId += 1;
      this.completedToolCallTurnId = null;
      this.resetAssistantTurnState();
    }
  }

  openAssistantDraft(turnId = this.currentTurnId): AssistantDraft {
    this.advanceTurnAfterTools();
    if (this.activeAssistantDraft?.runId === this.currentRunId && this.activeAssistantDraft.turnId === turnId) {
      return this.activeAssistantDraft;
    }
    this.activeAssistantDraft = {
      id: this.nextMessageId("assistant"),
      runId: this.currentRunId,
      turnId,
      streaming: true,
    };
    this.currentAssistantMessageId = this.activeAssistantDraft.id;
    this.currentAssistantTurnId = turnId;
    return this.activeAssistantDraft;
  }

  appendAssistantDelta(delta: string, turnId = this.currentTurnId): string {
    this.advanceTurnAfterTools();
    if (this.currentAssistantTurnId !== turnId || !this.currentAssistantMessageId) {
      this.resetAssistantTurnState();
    }
    const draft = this.openAssistantDraft(turnId);
    const existing = this.messages.find((m) => m.id === draft.id && m.role === "assistant");
    if (existing) {
      existing.content += delta;
    } else {
      this.appendMessage({ role: "assistant", id: draft.id, content: delta });
    }
    this.requestStreamRender();
    return draft.id;
  }

  finalizeAssistantDraft(_reason: string): AssistantDraft | null {
    const draft = this.activeAssistantDraft;
    if (!draft) return null;
    this.activeAssistantDraft = null;
    this.currentAssistantMessageId = null;
    this.currentAssistantTurnId = null;
    this.requestRender();
    return { ...draft, streaming: false };
  }

  attachToolCall(
    call: { id: string; type: string; function: { name: string; arguments: string } },
    turnId = this.currentTurnId
  ): string {
    const draftId = this.activeAssistantDraft?.id ?? this.currentAssistantMessageId;
    const draftTurnId = this.currentAssistantTurnId ?? turnId;
    this.finalizeAssistantDraft("tool-call");
    this.registerToolCall(call.id, turnId);
    const existing = draftId
      ? this.messages.find((m) => m.id === draftId && m.role === "assistant")
      : undefined;
    if (existing && draftTurnId === turnId) {
      existing.tool_calls = [...(existing.tool_calls ?? []), call];
      this.currentAssistantMessageId = existing.id ?? null;
      this.currentAssistantTurnId = turnId;
      return existing.id!;
    }

    const id = this.nextMessageId("assistant");
    this.appendMessage({
      role: "assistant",
      id,
      content: "",
      tool_calls: [call],
    });
    this.currentAssistantMessageId = id;
    this.currentAssistantTurnId = turnId;
    return id;
  }

  markToolResult(callId: string): void {
    this.completeToolCall(callId);
  }

  openActiveToolActivity(callId: string, name: string, args: any): ActiveToolActivity {
    const actionInfo = classifyToolAction(name, args);
    const target = prettyToolTarget(name, args);
    const isBg = args && typeof args === "object" && (args as any).background === true;
    const activity: ActiveToolActivity = {
      callId,
      name,
      args,
      category: actionInfo.category,
      actionLabel: actionInfo.actionLabel,
      target,
      startedAt: Date.now(),
      elapsedMs: 0,
      tail: [],
      status: "running",
      isBackground: isBg,
    };
    // Additive: starting tool B must not evict the still-running tool A.
    this.toolActivities.set(callId, activity);
    return activity;
  }

  updateActiveToolProgress(callId: string, progress: { elapsedMs?: number; tail?: string[] }): void {
    const activity = this.toolActivities.get(callId);
    if (!activity || activity.status !== "running") return;
    if (typeof progress.elapsedMs === "number") {
      activity.elapsedMs = progress.elapsedMs;
    } else {
      activity.elapsedMs = Date.now() - activity.startedAt;
    }
    if (progress.tail && progress.tail.length > 0) {
      activity.tail = progress.tail.slice(-5);
    }
    this.requestStreamRender();
  }

  /**
   * Cancel one activity by call id, or every running activity when omitted.
   * Returns a COPY of the first cancelled activity (transcript entries need a
   * frozen snapshot); the live entry keeps mutating until it is cleared.
   */
  cancelActiveToolActivity(callId?: string): ActiveToolActivity | null {
    const targets = callId
      ? [this.toolActivities.get(callId)].filter((activity): activity is ActiveToolActivity => !!activity)
      : this.getActiveToolActivities();
    let first: ActiveToolActivity | null = null;
    for (const activity of targets) {
      if (activity.status !== "running") continue;
      activity.status = "cancelled";
      activity.elapsedMs = Date.now() - activity.startedAt;
      if (!first) first = { ...activity };
    }
    if (first) this.requestStreamRender();
    return first;
  }

  /** Cancel every running activity; returns copies for transcript entries. */
  cancelAllToolActivities(): ActiveToolActivity[] {
    const cancelled: ActiveToolActivity[] = [];
    for (const activity of this.getActiveToolActivities()) {
      activity.status = "cancelled";
      activity.elapsedMs = Date.now() - activity.startedAt;
      cancelled.push({ ...activity });
    }
    if (cancelled.length > 0) this.requestStreamRender();
    return cancelled;
  }

  /**
   * Close one activity by call id, or all of them when omitted. Returns the
   * removed activity (the primary one for the no-arg teardown case).
   */
  closeActiveToolActivity(callId?: string): ActiveToolActivity | null {
    if (callId) {
      const existing = this.toolActivities.get(callId);
      if (!existing) return null;
      this.toolActivities.delete(callId);
      return existing;
    }
    const primary = this.activeToolActivity;
    this.toolActivities.clear();
    return primary;
  }

  bypassMode = bypassEngine.isEnabled();
  bypassLevel = bypassEngine.getLevel();

  /** Provider base URL — null means no provider configured */
  gatewayUrl: string | null = null;

  /** Active provider display name */
  providerName: string = "";

  inputBuffer = "";
  cursorPos = 0;
  /** Kept for backward compatibility: 0 = pinned to tail (see chatViewport). */
  scrollOffset = 0;
  /**
   * Conversation viewport scroll model — single source of truth for follow-tail
   * anchoring during streaming (see tui/viewport.ts). `scrollOffset` mirrors
   * `chatViewport.topRow` after every resolve for legacy readers.
   */
  chatViewport: ChatViewportState = createChatViewport();
  /** Measured chat height from the most recent frame; used by key handling. */
  chatRows = 0;
  /** Renderer-owned mapping from each chat row to its transcript message ID. */
  chatLineMessageIds: Array<string | null> = [];

  /**
   * Chrome render coalescing: spinner, status, tool progress, and other
   * transient updates arrive faster than the terminal can repaint full frames.
   * Buffer the request so N chrome updates in one window cost one layout+render.
   */
  private chromeRenderScheduled = false;
  private static CHROME_FRAME_MS = 33;

  requestChromeRender(): void {
    if (this.chromeRenderScheduled) return;
    this.chromeRenderScheduled = true;
    setTimeout(() => {
      this.chromeRenderScheduled = false;
      this.requestRender();
    }, TuiState.CHROME_FRAME_MS);
  }

  requestStreamRender(): void {
    this.requestChromeRender();
  }
  statusText = "";
  isStreaming = false;
  spinnerIdx = 0;
  spinnerTimer: ReturnType<typeof setInterval> | null = null;
  pendingConfirmation: PendingConfirmation | null = null;

  /** OAuth device-flow modal — pure state; renderAll composes it. */
  deviceCodeModal: import("./types").DeviceCodeModalState | null = null;

  /** Abort controller for the in-flight OAuth device polling loop. */
  oauthAbort: AbortController | null = null;

  /** Tools / Harness panel overlay — when non-none, all keys route into the overlay. */
  overlay: Overlay = { type: "none" };

  showHelp = false;
  showModelPicker = false;
  modelPickerIdx = 0;
  availableModels: string[] = [];
  filteredModels: string[] = [];
  modelSearchQuery = "";

  /**
   * Hierarchical /model workflow. `modelPickerStage = "provider"` shows the
   * provider list; "model" shows the pending provider's models. Selecting a
   * provider sets `pendingProviderId` — NAVIGATION ONLY — and the runtime
   * provider/model pair only changes when a model is chosen (atomic commit).
   * Esc/back at any earlier stage discards the pending id and leaves the
   * active pair untouched: the runtime is never left half-switched.
   */
  modelPickerStage: "provider" | "model" = "provider";
  pendingProviderId: string | null = null;
  providerPickerIdx = 0;
  providerEntries: Array<{ id: string; name: string; configured: boolean }> = [];
  /** Search cursor inside the model list's filter field. */
  modelSearchCursor = 0;

  async openProviderStage(): Promise<void> {
    this.showModelPicker = true;
    this.modelPickerStage = "provider";
    this.pendingProviderId = null;
    this.modelSearchQuery = "";
    this.modelSearchCursor = 0;
    this.providerEntries = buildProviderEntries();
    // Highlight the currently active provider when known.
    let active = 0;
    try {
      const { getActiveProviderConfig } = await import("../providers");
      const cfg = getActiveProviderConfig();
      if (cfg) active = this.providerEntries.findIndex((p) => p.id === cfg.id);
    } catch {}
    this.providerPickerIdx = active >= 0 ? active : 0;
    this.setStatus("");
    this.requestRender();
  }

  
  showSecretInput = false;
  secretInputConfig: { title: string; placeholder: string } | null = null;
  secretInputBuffer = "";
  secretInputCursor = 0;
  private secretInputResolve: ((value: string) => void) | null = null;

  async openSecretInput(config: { title: string; placeholder: string }): Promise<string> {
    this.overlay = { type: "none" };
    this.showSecretInput = true;
    this.secretInputConfig = config;
    this.secretInputBuffer = "";
    this.secretInputCursor = 0;
    this.showModelPicker = false;
    this.showKeyManager = false;
    this.showHelp = false;
    this.showSkillsPicker = false;
    this.showQueueManager = false;
    this.showSessionPicker = false;
    this.setStatus("");
    this.requestRender();

    return new Promise((resolve) => {
      this.secretInputResolve = resolve;
    });
  }

  resolveSecretInput(value: string): void {
    if (this.secretInputResolve) {
      this.secretInputResolve(value);
      this.secretInputResolve = null;
    }
    this.showSecretInput = false;
    this.secretInputConfig = null;
    this.setStatus("");
    this.requestRender();
  }

  showKeyManager = false;
  keyManagerIdx = 0;
  keyManagerInput: { provider: string; buffer: string; cursor?: number } | null = null;
  keyManagerConfirmDelete: string | null = null;

  showSkillsPicker = false;
  skillsPickerIdx = 0;
  skillsSearchQuery = "";
  availableSkills: SkillInfo[] = [];
  filteredSkills: SkillInfo[] = [];
  selectedSkillDetail: SkillInfo | null = null;
  isLoadingSkillDetail = false;

  showQueueManager = false;
  queueManagerIdx = 0;
  queueManagerEditing: { index: number; buffer: string; cursor: number } | null = null;

  showSessionPicker = false;
  sessionPickerIdx = 0;
  sessionSearchQuery = "";
  availableSessions: SessionItem[] = [];
  filteredSessions: SessionItem[] = [];

  abortController: AbortController | null = null;

  /** Active teamwork DAG scheduler abort hook — cancelled by Ctrl+C. */
  teamworkAbort: AbortController | null = null;
  ctrlCCount = 0;
  ctrlCTimer: ReturnType<typeof setTimeout> | null = null;
  startTime = 0;
  elapsedDisplay = "";
  lastTokens = "";

  toastMsg = "";
  toastTimer: ReturnType<typeof setTimeout> | null = null;

  cmdSuggestIdx = 0;

  // History
  promptHistory: string[] = [];
  historyIndex = -1;
  savedInput = "";

  renderCallback: (() => void) | null = null;

  saveCurrentSession(): void {
    if (this.currentSessionId) {
      saveSession(this.currentSessionId, this.messages, {
        model: this.currentModel,
        agentMode: this.agentMode,
        responseLanguage: this.responseLanguage,
        reasoningSettings: this.reasoningSettings,
        queuedMessages: messageQueue.getAllTexts(),
      });
    }
  }

  showToast(msg: string, ms = 2500): void {
    this.toastMsg = msg;
    this.requestRender();
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toastMsg = "";
      this.requestRender();
    }, ms);
  }

  setStatus(s: string): void {
    this.statusText = s;
  }

  requestRender(): void {
    if (this.renderCallback) {
      this.renderCallback();
    }
  }

  startNewRun(sessionId: string): string {
    if (sessionId) this.currentSessionId = sessionId;
    this.currentRunId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.currentTurnId = 0;
    this.activeReasoningDraft = null;
    this.activeToolActivity = null;
    this.resetAssistantTurnState();
    this.reasoningText = "";
    this.reasoningTokens = 0;
    this.reasoningElapsed = "";
    return this.currentRunId;
  }

  /**
   * Append a provider reasoning delta to the live draft.
   *
   * Invariants:
   *  - Correlation guard: deltas whose (sessionId, runId[, turnId]) do not
   *    match the active run are dropped — a late event from a previous run or
   *    a switched session must never leak into the current transcript.
   *  - Micro-cycle coalescing: providers may emit start/delta/end per token;
   *    a draft closed within the same turn is reopened and extended instead
   *    of finalized, so one logical block per turn segment.
   *  - An empty delta still opens the draft (reasoning-start with no text yet).
   *
   * Returns true when the delta was accepted into the live draft.
   */
  appendReasoningDelta(
    delta: string,
    ctx: { sessionId: string; runId: string; turnId?: number }
  ): boolean {
    if (!ctx) return false;
    if (ctx.sessionId !== this.currentSessionId || ctx.runId !== this.currentRunId) return false;
    if (
      typeof ctx.turnId === "number" &&
      ctx.turnId !== this.currentTurnId
    ) {
      return false;
    }

    const now = Date.now();
    if (!this.activeReasoningDraft) {
      this.activeReasoningDraft = {
        id: `rsn_${now}_${Math.random().toString(36).slice(2, 6)}`,
        turnId: ctx.turnId ?? this.currentTurnId,
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        text: "",
        startedAt: now,
        streaming: true,
      };
    } else if (this.activeReasoningDraft.endedAt !== undefined) {
      this.activeReasoningDraft.endedAt = undefined;
      this.activeReasoningDraft.streaming = true;
    }
    if (delta) this.activeReasoningDraft.text += delta;

    // Legacy live-surface fields: the frame renderer draws the live panel
    // from these while the draft is open.
    this.reasoningText = this.activeReasoningDraft.text;
    this.requestStreamRender();
    return true;
  }

  /**
   * Close the live reasoning draft and record it as a transcript block.
   *
   * `reason` is the lifecycle boundary that ended the stream (tool call,
   * text delta, agent completion, cancellation, error, run settle) — kept on
   * the block for diagnostics. Empty drafts are closed but not recorded: an
   * empty block would render as nothing and only pollute the transcript.
   *
   * Returns the finalized block, or null when nothing was active.
   */
  finalizeActiveReasoning(reason: string): ReasoningBlock | null {
    const draft = this.activeReasoningDraft;
    if (!draft) return null;
    this.activeReasoningDraft = null;

    const endedAt = draft.endedAt ?? Date.now();
    const finalized: ReasoningBlock = {
      ...draft,
      endedAt,
      streaming: false,
      durationMs: Math.max(0, endedAt - draft.startedAt),
      collapsed: this.reasoningCollapsed,
    };
    void reason;

    if (draft.text.trim()) {
      this.appendMessage({ role: "reasoning", content: draft.text, reasoning: finalized });
    }
    // The finalized block now lives in the transcript; the legacy live panel
    // must not double-render it.
    this.reasoningText = "";
    this.reasoningElapsed = "";
    if (finalized.tokens && finalized.tokens > 0) this.reasoningTokens = finalized.tokens;
    this.requestRender();
    return finalized;
  }

  pushPromptHistory(prompt: string): void {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    if (this.promptHistory.length === 0 || this.promptHistory[this.promptHistory.length - 1] !== trimmed) {
      this.promptHistory.push(trimmed);
    }
    this.historyIndex = -1;
    this.savedInput = "";
    updateCrashGoal(trimmed);
  }

  async refreshActiveModels(): Promise<string[]> {
    const { getActiveProvider, getActiveProviderConfig } = await import("../providers");
    const providerConfig = getActiveProviderConfig();
    const provider = getActiveProvider();
    if (!providerConfig || !provider) {
      this.currentModel = "";
      this.availableModels = ["No provider configured — use /key or /provider to set one up"];
      this.filteredModels = this.availableModels;
      return this.availableModels;
    }

    try {
      const models = await provider.listModels();
      // Index capability metadata (reasoning etc.) for the whole TUI.
      const { setModelCapabilities } = await import("../lib/reasoning");
      setModelCapabilities(models || []);
      const realModels = (models || []).filter((m) => m && m.id && typeof m.id === "string").map((m) => m.id);
      if (realModels.length > 0) {
        this.availableModels = realModels;
        // If currentModel is set but not in realModels, clear it
        if (this.currentModel && !this.availableModels.includes(this.currentModel)) {
          this.currentModel = "";
        }
        // If no model selected, select defaultModel if it exists in realModels, or first model
        if (!this.currentModel) {
          if (providerConfig.defaultModel && this.availableModels.includes(providerConfig.defaultModel)) {
            this.currentModel = providerConfig.defaultModel;
          } else {
            this.currentModel = this.availableModels[0];
          }
        }
      } else {
        this.availableModels = ["No models available"];
        this.currentModel = "";
      }
    } catch {
      this.availableModels = ["Provider offline"];
      this.currentModel = "";
    }

    this.filteredModels = [...this.availableModels];
    return this.availableModels;
  }

  async openModelPicker(): Promise<void> {
    this.overlay = { type: "none" };
    this.showKeyManager = false;
    this.showHelp = false;
    // The hierarchical workflow starts at the provider stage; the previous
    // active-provider model list becomes reachable by selecting a provider.
    await this.openProviderStage();
  }

  openKeyManager(): void {
    this.overlay = { type: "none" };
    this.showKeyManager = true;
    this.showModelPicker = false;
    this.showHelp = false;
    this.keyManagerIdx = 0;
    this.keyManagerInput = null;
    this.keyManagerConfirmDelete = null;
    this.setStatus("");
    this.requestRender();
  }

  closeKeyManager(): void {
    this.showKeyManager = false;
    this.keyManagerInput = null;
    this.keyManagerConfirmDelete = null;
    this.setStatus("");
    this.requestRender();
  }

  async openSkillsPicker(initialSkillName?: string, forceRefresh: boolean = false): Promise<void> {
    this.overlay = { type: "none" };
    this.showSkillsPicker = true;
    this.showModelPicker = false;
    this.showKeyManager = false;
    this.showHelp = false;
    this.skillsSearchQuery = "";
    this.isLoadingSkillDetail = false;

    // Load available local & cached remote skills instantly
    this.availableSkills = loadResolvedSkillsSync();
    this.filteredSkills = [...this.availableSkills];

    if (initialSkillName) {
      const foundSync = getSkillByIdSync(initialSkillName);
      if (foundSync) {
        this.openSkillDetail(foundSync);
        return;
      }

      // If not in sync cache, fetch asynchronously
      try {
        const foundAsync = await getSkillById(initialSkillName);
        if (foundAsync && this.showSkillsPicker) {
          this.openSkillDetail(foundAsync);
          return;
        }
      } catch {}

      if (this.showSkillsPicker) {
        this.showToast(`Skill not found: ${initialSkillName}`);
      }
    }

    this.selectedSkillDetail = null;
    this.skillsPickerIdx = 0;
    this.setStatus("");
    this.requestRender();

    // In background, fetch fresh remote metadata from ToolNet MCP
    loadAllSkills(process.cwd(), forceRefresh)
      .then((skills) => {
        if (!this.showSkillsPicker) return;
        this.availableSkills = skills;
        const query = this.skillsSearchQuery.toLowerCase();
        if (query) {
          this.filteredSkills = skills.filter(
            (s) =>
              s.id.toLowerCase().includes(query) ||
              s.name.toLowerCase().includes(query) ||
              s.description.toLowerCase().includes(query)
          );
        } else {
          this.filteredSkills = [...skills];
        }
        this.requestRender();
      })
      .catch(() => {});
  }

  openSkillDetail(skill: SkillInfo): void {
    this.selectedSkillDetail = skill;
    const offlineNote = skill.isOfflineCache ? " [Offline cache]" : "";
    this.setStatus("");

    if (!skill.instructionsLoaded && skill.source === "toolnet") {
      this.isLoadingSkillDetail = true;
      this.requestRender();
      ensureSkillInstructions(skill)
        .then((resolved) => {
          this.selectedSkillDetail = resolved;
          this.isLoadingSkillDetail = false;
          this.requestRender();
        })
        .catch(() => {
          this.isLoadingSkillDetail = false;
          this.requestRender();
        });
    } else {
      this.isLoadingSkillDetail = false;
      this.requestRender();
    }
  }

  closeSkillsPicker(): void {
    this.showSkillsPicker = false;
    this.selectedSkillDetail = null;
    this.isLoadingSkillDetail = false;
    this.setStatus("");
    this.requestRender();
  }

  toggleSkillInPicker(): void {
    if (!this.selectedSkillDetail) return;
    const next = toggleSkillEnabled(this.selectedSkillDetail.id);
    this.selectedSkillDetail.enabled = next;
    const found = this.availableSkills.find(s => s.id === this.selectedSkillDetail!.id);
    if (found) found.enabled = next;
    this.showToast(`Skill '${this.selectedSkillDetail.name}' ${next ? "enabled" : "disabled"}`);
    this.requestRender();
  }

  openQueueManager(): void {
    this.overlay = { type: "none" };
    this.showQueueManager = true;
    this.showSkillsPicker = false;
    this.showModelPicker = false;
    this.showKeyManager = false;
    this.showHelp = false;
    this.queueManagerIdx = 0;
    this.queueManagerEditing = null;
    this.setStatus("");
    this.requestRender();
  }

  closeQueueManager(): void {
    this.showQueueManager = false;
    this.queueManagerEditing = null;
    this.setStatus("");
    this.requestRender();
  }

  deleteFromQueue(index: number): void {
    const removed = messageQueue.removeAt(index);
    if (removed) {
      this.showToast(`Deleted task: ${removed.text.slice(0, 20)}…`);
    }
    if (this.queueManagerIdx >= messageQueue.size()) {
      this.queueManagerIdx = Math.max(0, messageQueue.size() - 1);
    }
    this.saveCurrentSession();
    this.requestRender();
  }

  reorderQueue(from: number, to: number): void {
    const ok = messageQueue.reorder(from, to);
    if (ok) {
      this.queueManagerIdx = to;
      this.saveCurrentSession();
      this.requestRender();
    }
  }

  startQueueEdit(index: number): void {
    const all = messageQueue.getAll();
    const target = all[index];
    if (!target) return;
    this.queueManagerEditing = {
      index,
      buffer: target.text,
      cursor: target.text.length,
    };
    this.setStatus("");
    this.requestRender();
  }

  saveQueueEdit(index: number, newText: string): void {
    if (newText.trim()) {
      messageQueue.updateAt(index, newText.trim());
      this.showToast("Task updated");
    }
    this.queueManagerEditing = null;
    this.setStatus("");
    this.saveCurrentSession();
    this.requestRender();
  }

  cancelQueueEdit(): void {
    this.queueManagerEditing = null;
    this.setStatus("");
    this.requestRender();
  }

  openSessionPicker(): void {
    this.overlay = { type: "none" };
    // Index metadata only: populating the picker must not load every transcript.
    const summaries = listSessionSummaries();
    const currCwd = process.cwd();
    this.availableSessions = summaries.map((s) => ({
      sessionId: s.id,
      name: s.title,
      preview: s.preview,
      model: s.model,
      provider: s.provider,
      messagesCount: s.messageCount,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
      workspace: s.workspacePath || currCwd,
      isCurrent: s.id === this.currentSessionId,
      status: s.status,
      harness: s.harness,
    }));
    this.sessionPickerIdx = 0;
    this.sessionSearchQuery = "";
    this.filterSessions();

    this.showSessionPicker = true;
    this.showSkillsPicker = false;
    this.showQueueManager = false;
    this.showModelPicker = false;
    this.showKeyManager = false;
    this.showHelp = false;
    this.setStatus("");
    this.requestRender();
  }

  closeSessionPicker(): void {
    this.showSessionPicker = false;
    this.sessionSearchQuery = "";
    this.setStatus("");
    this.requestRender();
  }

  // ── Tools / Harness panel overlay ─────────────────────────────────────────

  private closeSupportingModals(): void {
    this.showModelPicker = false;
    this.showKeyManager = false;
    this.showHelp = false;
    this.showSkillsPicker = false;
    this.showQueueManager = false;
    this.showSessionPicker = false;
  }

  openToolsOverlay(query?: string): void {
    this.closeSupportingModals();
    this.overlay = { type: "tools", selected: 0, scroll: 0, query: query || "" };
    this.setStatus("");
    this.requestRender();
  }

  openToolDetail(toolId: string): void {
    this.closeSupportingModals();
    this.overlay = { type: "tool-detail", toolId };
    this.setStatus("");
    this.requestRender();
  }

  openHarnessOverlay(query?: string): void {
    this.closeSupportingModals();
    this.overlay = { type: "harness", selected: 0, scroll: 0, query: query || "" };
    this.setStatus("");
    this.requestRender();
  }

  openHarnessSection(section: string): void {
    this.closeSupportingModals();
    this.overlay = { type: "harness-detail", section };
    this.setStatus("");
    this.requestRender();
  }

  dismissOverlay(): void {
    if (this.overlay.type === "none") return;
    this.overlay = { type: "none" };
    this.setStatus("");
    this.requestRender();
  }

  filterSessions(): void {
    const q = this.sessionSearchQuery.toLowerCase().trim();
    if (!q) {
      this.filteredSessions = [...this.availableSessions];
    } else {
      this.filteredSessions = this.availableSessions.filter((s) => {
        return (
          s.sessionId.toLowerCase().includes(q) ||
          (s.name && s.name.toLowerCase().includes(q)) ||
          (s.model && s.model.toLowerCase().includes(q)) ||
          (s.provider && s.provider.toLowerCase().includes(q)) ||
          (s.workspace && s.workspace.toLowerCase().includes(q))
        );
      });
    }

    if (this.sessionPickerIdx >= this.filteredSessions.length) {
      this.sessionPickerIdx = Math.max(0, this.filteredSessions.length - 1);
    }
  }

  resumeSelectedSession(): boolean {
    if (this.filteredSessions.length === 0) return false;
    const target = this.filteredSessions[this.sessionPickerIdx];
    if (!target) return false;

    const loaded = loadSession(target.sessionId);
    if (!loaded) return false;

    this.currentSessionId = loaded.sessionId;
    this.replaceMessages((loaded.messages as any) || []);
    this.sessionTitle = loaded.title
      ?? (typeof loaded.metadata?.name === "string" && loaded.metadata.name ? loaded.metadata.name : undefined);
    // Resume any steer that was admitted before the process ended.
    pendingInputs.restore(loaded.sessionId, readPendingInputs(loaded.sessionId));
    if (loaded.metadata?.model) this.currentModel = loaded.metadata.model;
    if (loaded.metadata?.provider) this.providerName = loaded.metadata.provider;
    if (loaded.metadata?.agentMode) this.agentMode = loaded.metadata.agentMode;
    if (loaded.metadata?.responseLanguage) {
      this.responseLanguage = loaded.metadata.responseLanguage;
      setResponseLanguage(this.responseLanguage);
    }

    if (Array.isArray(loaded.metadata?.queuedMessages)) {
      messageQueue.restore(loaded.metadata.queuedMessages);
    } else {
      messageQueue.clear();
    }

    // Ensure session is not resumed in a stale running state
    this.isStreaming = false;
    messageQueue.setIsProcessing(false);

    this.saveCurrentSession();
    this.closeSessionPicker();
    this.showToast(`Resumed session: ${target.sessionId}`);
    this.setStatus(`Session: ${this.currentSessionId}`);
    this.requestRender();
    return true;
  }

  deleteSelectedSession(): boolean {
    if (this.filteredSessions.length === 0) return false;
    const target = this.filteredSessions[this.sessionPickerIdx];
    if (!target) return false;

    const isCurrent = target.sessionId === this.currentSessionId;
    const ok = deleteSessionFile(target.sessionId);
    if (!ok) {
      this.showToast(`Failed to delete session ${target.sessionId}`);
      return false;
    }

    this.showToast(`Deleted session ${target.sessionId}`);
    if (isCurrent) {
      const remaining = listAllSessions();
      if (remaining.length > 0) {
        const next = remaining[0];
        this.currentSessionId = next.sessionId;
        this.replaceMessages(next.messages as any);
        this.sessionTitle = next.title
          ?? (typeof next.metadata?.name === "string" && next.metadata.name ? next.metadata.name : undefined);
        if (next.metadata?.model) this.currentModel = next.metadata.model;
      } else {
        const newS = createNewSession();
        this.currentSessionId = newS.sessionId;
        this.sessionTitle = undefined;
        this.clearMessages();
        messageQueue.clear();
      }
    }

    this.openSessionPicker();
    return true;
  }
}

/**
 * Provider list for the /model workflow's first stage: configured providers
 * first (selectable), built-in but unconfigured after (marked), canonical ids
 * preserved. Pure data — no runtime mutation.
 */
export function buildProviderEntries(): Array<{ id: string; name: string; configured: boolean }> {
  const builtin = [
    "toolnet",
    "openai",
    "anthropic",
    "gemini",
    "deepseek",
    "groq",
    "openrouter",
    "together",
    "mistral",
    "xai",
    "alibaba",
    "minimax",
    "cohere",
  ];
  const entries: Array<{ id: string; name: string; configured: boolean }> = [];
  for (const p of listProviders()) {
    entries.push({ id: p.id, name: p.name || p.id, configured: true });
  }
  const seen = new Set(entries.map((e) => e.id.toLowerCase()));
  for (const id of builtin) {
    if (!seen.has(id)) entries.push({ id, name: getDefaultProviderConfig(id).name, configured: false });
  }
  return entries;
}

export const tuiState = new TuiState();
bindCurrentContextSession(tuiState.currentSessionId);

// Subscribe to provider switch events to keep tuiState live
import { onProviderSwitch } from "../providers";
onProviderSwitch((_id, config) => {
  if (!config) {
    tuiState.providerName = "";
    tuiState.currentModel = "";
    tuiState.gatewayUrl = null;
    tuiState.availableModels = [];
    tuiState.filteredModels = [];
    tuiState.requestRender();
    return;
  }
  tuiState.providerName = config.name || config.id;
  if (config.defaultModel) {
    tuiState.currentModel = config.defaultModel;
  }
  if (config.baseUrl) {
    tuiState.gatewayUrl = config.baseUrl;
  }
  // Clear stale model list so active provider always gets fresh models
  tuiState.availableModels = [];
  tuiState.filteredModels = [];
  tuiState.requestRender();
});

export function openActiveToolActivity(callId: string, name: string, args: any): ActiveToolActivity {
  return tuiState.openActiveToolActivity(callId, name, args);
}

export function updateActiveToolProgress(
  callId: string,
  progress: { elapsedMs?: number; tail?: string[] } | string[],
  elapsedMs?: number,
): void {
  if (Array.isArray(progress)) {
    tuiState.updateActiveToolProgress(callId, { tail: progress, elapsedMs });
  } else {
    tuiState.updateActiveToolProgress(callId, progress);
  }
}

export function cancelActiveToolActivity(callId?: string): boolean {
  return tuiState.cancelActiveToolActivity(callId) !== null;
}

export function closeActiveToolActivity(callId?: string): ActiveToolActivity | null {
  return tuiState.closeActiveToolActivity(callId);
}

/** Running live tool activities, oldest→newest (multi-tool turns). */
export function getActiveToolActivities(): ActiveToolActivity[] {
  return tuiState.getActiveToolActivities();
}

/** Cancel every running activity; returns frozen copies for transcript rows. */
export function cancelAllToolActivities(): ActiveToolActivity[] {
  return tuiState.cancelAllToolActivities();
}
