import { tuiState } from "./state";
import { computeLayout, stripAnsi } from "./layout";
import { renderHeader } from "./renderers/headerRenderer";
import { renderChatMessages } from "./renderers/chatRenderer";
import { renderSidebar } from "./renderers/sidebarRenderer";
import { renderWorkingStatus, renderInputArea, renderFooter } from "./renderers/statusRenderer";
import { renderConfirmationModal, renderToast } from "./renderers/modalRenderer";
import { renderModelPickerBox } from "./renderers/modelPickerRenderer";
import { renderKeyManagerBox } from "./renderers/keyManagerRenderer";
import { renderSkillsPickerBox } from "./renderers/skillsPickerRenderer";
import { renderQueueManagerBox } from "./renderers/queueManagerRenderer";
import { renderQueuedMessagesPreview } from "./renderers/queuePreviewRenderer";
import { renderSessionPickerBox } from "./renderers/sessionPickerRenderer";
import { renderSuggestionsPopup } from "./renderers/suggestRenderer";
import { handleKey, handlePaste, getSuggestions, getInputState, setInputState, resetInputState } from "./input/inputHandler";
import { sendMessage } from "./events/agentWiring";
import { A, T, write, getSize } from "../term";
import { BracketedPasteParser, ENABLE_BRACKETED_PASTE } from "../lib/bracketedPaste";
import { setupTerminalLifecycle, restoreTerminal, wrapErrorBoundary, onTerminalResize } from "../lib/terminalLifecycle";
import { initWorkspace } from "../lib/codingAgent";
import { playSplashAnimation } from "../splash";
import { loadConfig } from "../lib/config";
import { parseSessionArgs, loadSession, getLastSessionId, formatExitMessage } from "../lib/sessionPersistence";
import { providerPicker } from "../components/ProviderPicker";
import { checkPendingRecovery, clearPendingRecovery, markCleanExit } from "../lib/crashRecovery";
import { pluginManager } from "../lib/plugins/pluginManager";
import { getActiveProviderConfig, getActiveProvider, autoRestoreActiveProvider } from "../providers";
import { onProviderSwitch } from "../commands/provider";
import { statusManager } from "./statusService";
import { messageQueue } from "../lib/messageQueue";

setupTerminalLifecycle();
onTerminalResize(() => {
  if (tuiState.showHelp) tuiState.showHelp = false;
  renderAll();
});

onProviderSwitch((id, config) => {
  if (!config) {
    tuiState.providerName = "";
    tuiState.gatewayUrl = null;
    tuiState.currentModel = "";
    tuiState.availableModels = [];
    tuiState.filteredModels = [];
    tuiState.setStatus("Provider: Not configured │ Model: Not selected");
    tuiState.requestRender();
    return;
  }
  const providerName = config.name || id;
  const defaultModel = config.defaultModel || "";
  tuiState.providerName = providerName;
  tuiState.gatewayUrl = config.baseUrl || null;
  tuiState.currentModel = defaultModel;
  tuiState.availableModels = [];
  tuiState.filteredModels = [];
  tuiState.setStatus(`Active Provider: ${providerName} │ Model: ${tuiState.currentModel || "Not selected"}`);
  tuiState.requestRender();
});

export function renderAll(): void {
  wrapErrorBoundary(() => {
    const activeSuggests = getSuggestions(tuiState.inputBuffer);
    const layout = computeLayout(activeSuggests.length, 3, tuiState.cursorPos);
    const { cols, rows, hasPanel, panelWidth, chatCols, chatRows, popupRows } = layout;
    const out: string[] = [];

    out.push(T.hide + T.home);

    let primaryColor = A.fgCyan;
    if (tuiState.bypassMode) {
      primaryColor = A.fgRed;
    } else if (tuiState.agentMode === "Plan") {
      primaryColor = A.fgYellow;
    }

    // 1. Header (Minimalist branding + live system status badge)
    out.push(renderHeader(cols, {
      agentMode: tuiState.agentMode,
      bypassMode: tuiState.bypassMode,
      bypassLevel: tuiState.bypassLevel,
      isStreaming: tuiState.isStreaming,
      spinnerIdx: tuiState.spinnerIdx,
      statusText: tuiState.statusText,
    }));

    // 2. Chat Lines
    const verbose = process.env.TOOLNET_DEBUG === "1" || process.argv.includes("--verbose");
    const chatLines = renderChatMessages(tuiState.messages, chatCols, primaryColor, verbose);

    // Scroll offset clamping
    const totalLines = chatLines.length;
    const maxScroll = Math.max(0, totalLines - chatRows);
    const clampedScroll = Math.min(tuiState.scrollOffset, maxScroll);
    const startLine = Math.max(0, totalLines - chatRows - clampedScroll);
    const visibleLines = chatLines.slice(startLine, startLine + chatRows);

    // 3. Sidebar Lines
    const panelLines = hasPanel ? renderSidebar(tuiState.currentModel, tuiState.startTime, panelWidth) : [];

    // 4. Combine Chat & Sidebar Lines
    for (let i = 0; i < chatRows; i++) {
      const line = visibleLines[i] ?? "";
      const stripped = stripAnsi(line);
      const chatPad = Math.max(0, chatCols - stripped.length);
      const chatPart = line + " ".repeat(chatPad) + A.reset;

      if (hasPanel) {
        const panelPart = panelLines[i] || (A.bgSurface + " ".repeat(panelWidth) + A.reset);
        out.push(chatPart + panelPart + "\r\n");
      } else {
        out.push(chatPart + "\r\n");
      }
    }

    // 5. Suggestions Popup (Command palette)
    if (activeSuggests.length > 0) {
      const popup = renderSuggestionsPopup(cols, popupRows, activeSuggests, tuiState.cmdSuggestIdx, primaryColor);
      out.push(...popup);
    }

    // 6. Toast Notification
    if (tuiState.toastMsg) {
      out.push(...renderToast(cols, tuiState.toastMsg));
    }

    // 7. Security Confirmation Modal
    if (tuiState.pendingConfirmation) {
      out.push(...renderConfirmationModal(cols, rows, tuiState.pendingConfirmation));
    }

    // 8. Working / Activity Status Line
    out.push(renderWorkingStatus(cols, {
      showHelp: tuiState.showHelp,
      isStreaming: tuiState.isStreaming,
      spinnerIdx: tuiState.spinnerIdx,
      statusText: tuiState.statusText,
      elapsedDisplay: tuiState.elapsedDisplay,
      primaryColor,
      queuedCount: messageQueue.size(),
      nextQueuedText: messageQueue.peek()?.text,
    }));

    // 8B. Dimmed Queued Messages Preview (like Agy)
    if (messageQueue.size() > 0) {
      out.push(renderQueuedMessagesPreview(cols, messageQueue.getAll()));
    }

    // 9. Input Area (Enter a coding task or / for commands)
    out.push(renderInputArea(cols, tuiState.inputBuffer, primaryColor));

    // 10. Persistent Footer Bar (Provider: X │ Model: Y │ Workspace: Z)
    out.push(renderFooter(cols, {
      providerName: tuiState.providerName,
      currentModel: tuiState.currentModel,
      lastTokens: tuiState.lastTokens,
    }));

    // Cursor position
    if (!tuiState.showHelp && !tuiState.showModelPicker && !tuiState.showKeyManager && !tuiState.showSkillsPicker && !tuiState.showQueueManager && !tuiState.showSessionPicker && !providerPicker.show) {
      out.push(T.goto(layout.cursorRow, layout.cursorCol) + T.show);
    } else {
      out.push(T.hide);
    }

    write(out.join(""));

    // 10. Model Picker Popup
    if (tuiState.showModelPicker) {
      const box = renderModelPickerBox(cols, rows, {
        filteredModels: tuiState.filteredModels,
        modelPickerIdx: tuiState.modelPickerIdx,
        currentModel: tuiState.currentModel,
        modelSearchQuery: tuiState.modelSearchQuery,
      });
      write(box);
    }

    // 11. Key Manager Modal Popup
    if (tuiState.showKeyManager) {
      const keyBox = renderKeyManagerBox(cols, rows, {
        keyManagerIdx: tuiState.keyManagerIdx,
        keyManagerInput: tuiState.keyManagerInput,
        keyManagerConfirmDelete: tuiState.keyManagerConfirmDelete,
      });
      write(keyBox);
    }

    // 12. Skills Picker Modal Popup
    if (tuiState.showSkillsPicker) {
      const skillsBox = renderSkillsPickerBox(cols, rows, {
        filteredSkills: tuiState.filteredSkills,
        skillsPickerIdx: tuiState.skillsPickerIdx,
        skillsSearchQuery: tuiState.skillsSearchQuery,
        selectedSkillDetail: tuiState.selectedSkillDetail,
        isLoading: tuiState.isLoadingSkillDetail,
      });
      write(skillsBox);
    }

    // 13. Queue Manager Modal Popup
    if (tuiState.showQueueManager) {
      const queueBox = renderQueueManagerBox(cols, rows, {
        queue: messageQueue.getAll(),
        queueIdx: tuiState.queueManagerIdx,
        editing: tuiState.queueManagerEditing,
      });
      write(queueBox);
    }

    // 14. Session Picker Modal Popup
    if (tuiState.showSessionPicker) {
      const sessionBox = renderSessionPickerBox(cols, rows, {
        filteredSessions: tuiState.filteredSessions,
        sessionPickerIdx: tuiState.sessionPickerIdx,
        sessionSearchQuery: tuiState.sessionSearchQuery,
        currentSessionId: tuiState.currentSessionId,
        currentWorkspace: process.cwd(),
      });
      write(sessionBox);
    }

    if (providerPicker.show) {
      providerPicker.render();
    }
  }, (err: unknown) => {
    // UI-level error recovery: close popups and update status
    tuiState.showModelPicker = false;
    tuiState.showKeyManager = false;
    tuiState.showSkillsPicker = false;
    tuiState.showQueueManager = false;
    tuiState.showSessionPicker = false;
    tuiState.showHelp = false;
    if (providerPicker.show) providerPicker.show = false;
    tuiState.setStatus(`⚠️ UI recovered from render glitch (${err instanceof Error ? err.message : String(err)})`);
    tuiState.showToast(`⚠️ UI recovered: ${err instanceof Error ? err.message : String(err)}`, 3000);
  });
}

tuiState.renderCallback = renderAll;

export async function openModelPicker(): Promise<void> {
  await tuiState.openModelPicker();
}

export function openKeyManager(): void {
  tuiState.openKeyManager();
}

function exitApp(): void {
  statusManager.stop();
  const hasContent = (tuiState.messages && tuiState.messages.length > 0) || messageQueue.size() > 0;
  const sessionId = tuiState.currentSessionId;
  if (hasContent && sessionId) {
    tuiState.saveCurrentSession();
  }
  markCleanExit();
  restoreTerminal();
  const msg = formatExitMessage(sessionId, hasContent);
  process.stdout.write(msg.replace(/\n/g, "\r\n"));
  process.exit(0);
}

function handleResize(): void {
  if (tuiState.showHelp) tuiState.showHelp = false;
  renderAll();
}

export async function main(): Promise<void> {
  initWorkspace();
  await pluginManager.loadAllPlugins();

  // Crash Recovery check
  const pendingRecovery = checkPendingRecovery();
  if (pendingRecovery && pendingRecovery.lastUserGoal) {
    tuiState.setStatus(`Recovered session from previous unexpected exit (${pendingRecovery.sessionId})`);
    tuiState.currentSessionId = pendingRecovery.sessionId;
    if (pendingRecovery.model && pendingRecovery.model !== "openai/gpt-4o" && pendingRecovery.model !== "none" && pendingRecovery.model !== "default") {
      tuiState.currentModel = pendingRecovery.model;
    }
    if (pendingRecovery.agentMode) tuiState.agentMode = pendingRecovery.agentMode;
  }

  // Resolve provider configuration from app config and provider registry
  autoRestoreActiveProvider();
  const providerConfig = getActiveProviderConfig();
  if (providerConfig) {
    tuiState.gatewayUrl = providerConfig.baseUrl;
    tuiState.providerName = providerConfig.name;
    tuiState.currentModel = providerConfig.defaultModel || "";
  } else {
    tuiState.gatewayUrl = null;
    tuiState.providerName = "";
    tuiState.currentModel = "";
  }

  // Load model from legacy config as fallback only if provider is configured
  try {
    const cfg = loadConfig();
    if (providerConfig && cfg.defaultModel && !tuiState.currentModel) {
      tuiState.currentModel = cfg.defaultModel;
    }
  } catch {}

  // Set status based on provider state
  if (providerConfig) {
    tuiState.setStatus(`Provider: ${providerConfig.name} │ Model: ${tuiState.currentModel || "Not selected"}`);
  } else {
    tuiState.setStatus("Provider: Not configured │ Model: Not selected");
  }

  if (!process.argv.includes("--no-splash")) {
    await playSplashAnimation();
  }

  const { resume, sessionId: requestedSessionId } = parseSessionArgs(process.argv.slice(2));
  if (requestedSessionId) {
    const loaded = loadSession(requestedSessionId);
    if (loaded && Array.isArray(loaded.messages)) {
      tuiState.currentSessionId = loaded.sessionId;
      tuiState.messages = loaded.messages as any;
      if (loaded.metadata?.model) tuiState.currentModel = loaded.metadata.model;
      if (loaded.metadata?.agentMode) tuiState.agentMode = loaded.metadata.agentMode;
      if (loaded.metadata?.queuedMessages && Array.isArray(loaded.metadata.queuedMessages)) {
        messageQueue.restore(loaded.metadata.queuedMessages);
      }
      tuiState.setStatus(`Loaded session: ${tuiState.currentSessionId}`);
    } else {
      tuiState.currentSessionId = requestedSessionId;
      tuiState.setStatus(`New session: ${tuiState.currentSessionId}`);
    }
  } else if (resume) {
    const lastId = getLastSessionId();
    if (lastId) {
      const loaded = loadSession(lastId);
      if (loaded && Array.isArray(loaded.messages)) {
        tuiState.currentSessionId = loaded.sessionId;
        tuiState.messages = loaded.messages as any;
        if (loaded.metadata?.model) tuiState.currentModel = loaded.metadata.model;
        if (loaded.metadata?.agentMode) tuiState.agentMode = loaded.metadata.agentMode;
        if (loaded.metadata?.queuedMessages && Array.isArray(loaded.metadata.queuedMessages)) {
          messageQueue.restore(loaded.metadata.queuedMessages);
        }
        tuiState.setStatus(`Resumed session: ${tuiState.currentSessionId}`);
      }
    }
  }

  write(T.altOn + T.hide + T.home + T.clearDown + ENABLE_BRACKETED_PASTE);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  process.stdout.on("resize", handleResize);
  renderAll();

  const pasteParser = new BracketedPasteParser();

  process.stdin.on("data", (data: Buffer) => {
    const chunks = pasteParser.parse(data);
    for (const chunk of chunks) {
      if (chunk.type === "paste") {
        handlePaste(chunk.content, { renderAll, sendMessage, exitApp, openModelPicker });
        continue;
      }

      const buf = Buffer.from(chunk.content);
      let i = 0;
      while (i < buf.length) {
        if (buf[i] === 0x1b) {
          if (i + 1 < buf.length && (buf[i + 1] === 0x5b || buf[i + 1] === 0x4f)) {
            let j = i + 2;
            while (j < buf.length && !(buf[j] >= 0x40 && buf[j] <= 0x7e)) j++;
            handleKey(buf.slice(i, j + 1), { renderAll, sendMessage, exitApp, openModelPicker });
            i = j + 1;
          } else if (i + 1 < buf.length) {
            handleKey(buf.slice(i, i + 2), { renderAll, sendMessage, exitApp, openModelPicker });
            i += 2;
          } else {
            handleKey(buf.slice(i, i + 1), { renderAll, sendMessage, exitApp, openModelPicker });
            i++;
          }
        } else {
          const b = buf[i];
          let len = 1;
          if ((b & 0xe0) === 0xc0) len = 2;
          else if ((b & 0xf0) === 0xe0) len = 3;
          else if ((b & 0xf8) === 0xf0) len = 4;
          handleKey(buf.slice(i, i + len), { renderAll, sendMessage, exitApp, openModelPicker });
          i += len;
        }
      }
    }
  });

  process.on("exit", () => {
    restoreTerminal();
  });

  process.on("SIGTERM", exitApp);
}

export { getInputState, setInputState, resetInputState, handlePaste };
