import { saveSession, loadSession, listAllSessions, deleteSessionFile, createNewSession } from "../lib/sessionPersistence";
import { bypassEngine } from "../lib/bypass";
import type { Msg, PendingConfirmation } from "./types";
import { updateCrashGoal } from "../lib/crashRecovery";
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
import type { SessionItem } from "./renderers/sessionPickerRenderer";

export const SPINNER = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

export class TuiState {
  messages: Msg[] = [];
  currentSessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
    this.showModelPicker = true;
    this.showKeyManager = false;
    this.showHelp = false;
    this.modelSearchQuery = "";

    const { getActiveProvider, getActiveProviderConfig } = await import("../providers");
    const providerConfig = getActiveProviderConfig();
    const provider = getActiveProvider();
    if (!providerConfig || !provider) {
      this.currentModel = "";
      this.availableModels = ["No provider configured — use /key or /provider to set one up"];
      this.filteredModels = this.availableModels;
      this.setStatus("Provider: Not configured │ Model: Not selected");
      this.requestRender();
      return;
    }

    if (
      this.availableModels.length === 0 ||
      this.availableModels[0].startsWith("No provider") ||
      this.availableModels[0] === "Loading..." ||
      this.availableModels[0] === "Provider offline"
    ) {
      this.setStatus("Fetching models...");
      this.requestRender();
      await this.refreshActiveModels();
    }

    this.filteredModels = [...this.availableModels];
    if (this.availableModels.length === 0 || this.availableModels[0] === "No models available" || this.availableModels[0] === "Provider offline") {
      this.currentModel = "";
      this.setStatus(`Provider: ${providerConfig.name} │ Model: Not selected`);
      this.requestRender();
      return;
    }

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

  async openSkillsPicker(initialSkillName?: string, forceRefresh: boolean = false): Promise<void> {
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
    this.setStatus("↑↓ Navigate │ Enter View │ Esc Cancel │ Type to filter");
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
    this.setStatus(`Skill: ${skill.name}${offlineNote} │ Space: Toggle │ Esc: Back`);

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
    this.setStatus(`Provider: ${this.providerName || "Not configured"} │ Model: ${this.currentModel || "Not selected"}`);
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
    this.showQueueManager = true;
    this.showSkillsPicker = false;
    this.showModelPicker = false;
    this.showKeyManager = false;
    this.showHelp = false;
    this.queueManagerIdx = 0;
    this.queueManagerEditing = null;
    this.setStatus("↑↓ Navigate │ Enter Edit │ D Delete │ Ctrl+↑/↓ Reorder │ Esc Close");
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
    this.setStatus("Editing queued task │ Enter Save │ Esc Cancel");
    this.requestRender();
  }

  saveQueueEdit(index: number, newText: string): void {
    if (newText.trim()) {
      messageQueue.updateAt(index, newText.trim());
      this.showToast("Task updated");
    }
    this.queueManagerEditing = null;
    this.setStatus("↑↓ Navigate │ Enter Edit │ D Delete │ Ctrl+↑/↓ Reorder │ Esc Close");
    this.saveCurrentSession();
    this.requestRender();
  }

  cancelQueueEdit(): void {
    this.queueManagerEditing = null;
    this.setStatus("↑↓ Navigate │ Enter Edit │ D Delete │ Ctrl+↑/↓ Reorder │ Esc Close");
    this.requestRender();
  }

  openSessionPicker(): void {
    const rawSessions = listAllSessions();
    const currCwd = process.cwd();
    this.availableSessions = rawSessions.map((s) => ({
      sessionId: s.sessionId,
      name: s.metadata?.name,
      model: s.metadata?.model,
      provider: s.metadata?.provider,
      messagesCount: Array.isArray(s.messages) ? s.messages.length : 0,
      updatedAt: s.updatedAt,
      createdAt: s.metadata?.createdAt || s.updatedAt,
      workspace: s.metadata?.workspace || currCwd,
      queuedCount: Array.isArray(s.metadata?.queuedMessages) ? s.metadata.queuedMessages.length : 0,
      isCurrent: s.sessionId === this.currentSessionId,
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
    this.setStatus("↑↓ Navigate │ Enter Resume │ D Delete │ Esc Close");
    this.requestRender();
  }

  closeSessionPicker(): void {
    this.showSessionPicker = false;
    this.sessionSearchQuery = "";
    this.setStatus(`Provider: ${this.providerName || "Not configured"} │ Model: ${this.currentModel || "Not selected"}`);
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
    this.messages = (loaded.messages as any) || [];
    if (loaded.metadata?.model) this.currentModel = loaded.metadata.model;
    if (loaded.metadata?.provider) this.providerName = loaded.metadata.provider;
    if (loaded.metadata?.agentMode) this.agentMode = loaded.metadata.agentMode;

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
        this.messages = next.messages as any;
        if (next.metadata?.model) this.currentModel = next.metadata.model;
      } else {
        const newS = createNewSession();
        this.currentSessionId = newS.sessionId;
        this.messages = [];
        messageQueue.clear();
      }
    }

    this.openSessionPicker();
    return true;
  }
}

export const tuiState = new TuiState();

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
