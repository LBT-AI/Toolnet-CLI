import { saveSession, loadSession } from "../lib/sessionPersistence";
import { bypassEngine } from "../lib/bypass";
import type { Msg, PendingConfirmation } from "./types";
import { updateCrashGoal } from "../lib/crashRecovery";

export const SPINNER = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

export class TuiState {
  messages: Msg[] = [];
  currentSessionId = `sess_${Date.now()}`;
  currentModel = "";
  agentMode: "Build" | "Plan" = "Build";
  bypassMode = bypassEngine.isEnabled();
  bypassLevel = bypassEngine.getLevel();

  /** Provider base URL — null means no provider configured */
  gatewayUrl: string | null = null;

  /** Active provider display name */
  providerName: string = "";

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

  showKeyManager = false;
  keyManagerIdx = 0;
  keyManagerInput: { provider: string; buffer: string } | null = null;
  keyManagerConfirmDelete: string | null = null;

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

  async openModelPicker(): Promise<void> {
    this.showModelPicker = true;
    this.showKeyManager = false;
    this.showHelp = false;
    this.modelSearchQuery = "";
    if (this.availableModels.length === 0 || this.availableModels[0] === "Provider offline" || this.availableModels[0] === "No provider configured") {
      this.availableModels = ["Loading..."];
      this.filteredModels = this.availableModels;
      this.modelPickerIdx = 0;
      this.setStatus("Fetching models...");
      this.requestRender();

      const { getActiveProvider } = await import("../providers");
      const provider = getActiveProvider();
      if (!provider) {
        this.availableModels = ["No provider configured — use /provider add to set one up"];
        this.filteredModels = this.availableModels;
        this.setStatus("No provider configured — use /provider add to set one up");
        this.requestRender();
        return;
      }

      try {
        const models = await provider.listModels();
        const allModels = models.map((m) => m.id);
        this.availableModels = allModels.length > 0 ? allModels : ["No models available"];
      } catch {
        this.availableModels = ["Provider offline"];
      }
    }

    this.filteredModels = [...this.availableModels];
    this.modelPickerIdx = this.filteredModels.indexOf(this.currentModel);
    if (this.modelPickerIdx < 0) this.modelPickerIdx = 0;
    this.setStatus("Type to search │ ↑↓ navigate │ Enter select │ Esc cancel");
    this.requestRender();
  }

  openKeyManager(): void {
    this.showKeyManager = true;
    this.showModelPicker = false;
    this.showHelp = false;
    this.keyManagerIdx = 0;
    this.keyManagerInput = null;
    this.keyManagerConfirmDelete = null;
    this.setStatus("Enter/A: Set Key │ D: Delete │ ↑↓: Navigate │ Esc: Close");
    this.requestRender();
  }

  closeKeyManager(): void {
    this.showKeyManager = false;
    this.keyManagerInput = null;
    this.keyManagerConfirmDelete = null;
    this.setStatus("");
    this.requestRender();
  }
}

export const tuiState = new TuiState();
