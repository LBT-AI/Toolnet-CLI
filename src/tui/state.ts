import { saveSession, loadSession } from "../lib/sessionPersistence";
import { bypassEngine } from "../lib/bypass";
import type { Msg, PendingConfirmation } from "./types";
import { updateCrashGoal } from "../lib/crashRecovery";

export const SPINNER = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

export class TuiState {
  messages: Msg[] = [];
  currentSessionId = `sess_${Date.now()}`;
  currentModel = "openai/gpt-4o";
  agentMode: "Build" | "Plan" = "Build";
  bypassMode = bypassEngine.isEnabled();
  bypassLevel = bypassEngine.getLevel();
  gatewayUrl = "http://127.0.0.1:20127";

  inputBuffer = "";
  cursorPos = 0;
  scrollOffset = 0;
  statusText = "";
  isStreaming = false;
  spinnerIdx = 0;
  spinnerTimer: ReturnType<typeof setInterval> | null = null;
  pendingConfirmation: PendingConfirmation | null = null;

  showHelp = false;
  showModelPicker = false;
  modelPickerIdx = 0;
  availableModels: string[] = [];
  filteredModels: string[] = [];
  modelSearchQuery = "";

  abortController: AbortController | null = null;
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
}

export const tuiState = new TuiState();
