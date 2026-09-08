import { tuiState } from "./state";
import { computeLayout, stripAnsi } from "./layout";
import { renderHeader } from "./renderers/headerRenderer";
import { renderChatMessages } from "./renderers/chatRenderer";
import { renderSidebar } from "./renderers/sidebarRenderer";
import { renderWorkingStatus, renderInputArea, renderFooter } from "./renderers/statusRenderer";
import { renderConfirmationModal, renderToast, renderSecretInputModal } from "./renderers/modalRenderer";
import { renderModelPickerBox } from "./renderers/modelPickerRenderer";
import { renderKeyManagerBox } from "./renderers/keyManagerRenderer";
import { renderSkillsPickerBox } from "./renderers/skillsPickerRenderer";
import { renderQueueManagerBox } from "./renderers/queueManagerRenderer";
import { renderSessionPickerBox } from "./renderers/sessionPickerRenderer";
import { renderSuggestionsPopup } from "./renderers/suggestRenderer";
import { renderToolsPanelBox } from "./renderers/toolsPanelRenderer";
import { renderHarnessPanelBox } from "./renderers/harnessPanelRenderer";
import { handleKey, handlePaste, getSuggestions, getInputState, setInputState, resetInputState } from "./input/inputHandler";
import { sendMessage } from "./events/agentWiring";
import { A, T, getSize } from "../term";
import { BracketedPasteParser, ENABLE_BRACKETED_PASTE } from "../lib/bracketedPaste";
import { setupTerminalLifecycle, restoreTerminal, wrapErrorBoundary, onTerminalResize } from "../lib/terminalLifecycle";
import { initWorkspace } from "../lib/codingAgent";
import { showBannerIfEligible } from "../banner/banner";
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

// Guard: renderAll() must NOT write to stdout before the alternate screen is active.
// autoRestoreActiveProvider() fires notifyProviderSwitch() → requestRender() → renderAll()
// during main() initialization, BEFORE write(T.altOn). Without this guard, the TUI frame
// would be painted on the normal screen (below the banner), causing a "split/duplicate" UI.
let isAltScreenActive = false;

onTerminalResize(() => {
  if (!isAltScreenActive) return;
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
    tuiState.setStatus("");
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
  tuiState.setStatus("");
  tuiState.requestRender();
});

// ── Single-commit render pipeline ──────────────────────────────────────────
// Every visual (main frame + suggestions + toast + confirmation + all modals +
// provider picker + tools/harness overlay) is composed into ONE string and
// flushed to the terminal in a SINGLE process.stdout.write() by commitFrame().
//
// A reentrancy lock + coalescing guarantee no torn / interleaved writes and no
// duplicate status/input/footer bars no matter how many events fire together
// (spinner tick, provider switch, SIGWINCH, keystrokes). Each core component
// (provider/model bar, prompt input, workspace bar) is pushed exactly once.
let rendering = false;
let pendingRerender = false;

function buildFrame(): string {
  const activeSuggests = getSuggestions(tuiState.inputBuffer);
  const statusActive =
    tuiState.showHelp ||
    tuiState.isStreaming ||
    Boolean(tuiState.statusText) ||
    messageQueue.size() > 0;
  const layout = computeLayout(activeSuggests.length, 3, tuiState.cursorPos, statusActive);
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
  // Rows are capped at cols - 1 wide: a line that fills the last column +
  // CRLF double-advances the cursor on autowrap terminals, scrolling the
  // frame and leaving stale duplicate provider/input/workspace rows behind.
  for (let i = 0; i < chatRows; i++) {
    const line = visibleLines[i] ?? "";
    const stripped = stripAnsi(line);
    const chatPad = Math.max(0, chatCols - 1 - stripped.length);
    const chatPart = line + " ".repeat(chatPad) + A.reset;

    if (hasPanel) {
      const panelPart = panelLines[i] || (A.bgSurface + " ".repeat(panelWidth) + A.reset);
      out.push(chatPart + panelPart + "\r\n");
    } else {
      out.push(chatPart + "\r\n");
    }
  }

  // 5. Suggestions Popup (Command palette) — part of the frame
  if (activeSuggests.length > 0) {
    const popup = renderSuggestionsPopup(cols, popupRows, activeSuggests, tuiState.cmdSuggestIdx, primaryColor);
    out.push(...popup);
  }

  // 6. Activity Status Line — only drawn when something is actually happening
  //    (idle renders nothing). Includes the queued-message preview naturally.
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

  // 9. Input Area — drawn exactly once (divider + prompt line)
  out.push(renderInputArea(cols, tuiState.inputBuffer, primaryColor));

  // 10. Bottom Status Rule — provider · model · workspace, drawn exactly once
  out.push(renderFooter(cols, {
    providerName: tuiState.providerName,
    currentModel: tuiState.currentModel,
    lastTokens: tuiState.lastTokens,
  }));

  // Erase anything below the freshly-painted frame (prevents stale duplicate
  // status/input/footer bars after resize or when a smaller frame is drawn).
  out.push(T.clearDown);

  // Cursor: only visible when nothing is layered on top of the main frame.
  const anyOverlayActive =
    tuiState.showHelp ||
    tuiState.showModelPicker ||
    tuiState.showKeyManager ||
    tuiState.showSecretInput ||
    tuiState.showSkillsPicker ||
    tuiState.showQueueManager ||
    tuiState.showSessionPicker ||
    providerPicker.show ||
    tuiState.overlay.type !== "none";

  if (!anyOverlayActive) {
    out.push(T.goto(layout.cursorRow, layout.cursorCol) + T.show);
  } else {
    out.push(T.hide);
  }

  // ── Overlays / modals: absolute-positioned draws on top of the base frame ──
  if (tuiState.showModelPicker) {
    out.push(renderModelPickerBox(cols, rows, {
      filteredModels: tuiState.filteredModels,
      modelPickerIdx: tuiState.modelPickerIdx,
      currentModel: tuiState.currentModel,
      modelSearchQuery: tuiState.modelSearchQuery,
    }));
  }

  if (tuiState.showSecretInput && tuiState.secretInputConfig) {
    out.push(...renderSecretInputModal(cols, rows, {
      config: tuiState.secretInputConfig,
      buffer: tuiState.secretInputBuffer,
      cursor: tuiState.secretInputCursor,
    }));
  }

  if (tuiState.showKeyManager) {
    out.push(renderKeyManagerBox(cols, rows, {
      keyManagerIdx: tuiState.keyManagerIdx,
      keyManagerInput: tuiState.keyManagerInput,
      keyManagerConfirmDelete: tuiState.keyManagerConfirmDelete,
    }));
  }

  if (tuiState.showSkillsPicker) {
    out.push(renderSkillsPickerBox(cols, rows, {
      filteredSkills: tuiState.filteredSkills,
      skillsPickerIdx: tuiState.skillsPickerIdx,
      skillsSearchQuery: tuiState.skillsSearchQuery,
      selectedSkillDetail: tuiState.selectedSkillDetail,
      isLoading: tuiState.isLoadingSkillDetail,
    }));
  }

  if (tuiState.showQueueManager) {
    out.push(renderQueueManagerBox(cols, rows, {
      queue: messageQueue.getAll(),
      queueIdx: tuiState.queueManagerIdx,
      editing: tuiState.queueManagerEditing,
    }));
  }

  if (tuiState.showSessionPicker) {
    out.push(renderSessionPickerBox(cols, rows, {
      filteredSessions: tuiState.filteredSessions,
      sessionPickerIdx: tuiState.sessionPickerIdx,
      sessionSearchQuery: tuiState.sessionSearchQuery,
      currentSessionId: tuiState.currentSessionId,
      currentWorkspace: process.cwd(),
    }));
  }

  if (providerPicker.show) {
    out.push(providerPicker.renderToString());
  }

  // 15. Tools / Harness panel overlay (drawn last — on top of everything)
  if (tuiState.overlay.type === "tools" || tuiState.overlay.type === "tool-detail") {
    out.push(renderToolsPanelBox(cols, rows, tuiState.overlay));
  } else if (tuiState.overlay.type === "harness" || tuiState.overlay.type === "harness-detail") {
    out.push(renderHarnessPanelBox(cols, rows, tuiState.overlay));
  }

  // Security Confirmation Modal and Toast are absolute-goto overlays too; they
  // are drawn after the base frame so the streaming cursor position is never
  // disturbed and the footer/input/status bars stay at their own rows.
  if (tuiState.pendingConfirmation) {
    out.push(...renderConfirmationModal(cols, rows, tuiState.pendingConfirmation));
  }

  if (tuiState.toastMsg) {
    out.push(...renderToast(cols, tuiState.toastMsg));
  }

  return out.join("");
}

/**
 * The ONLY place that commits a frame to the terminal. Guarded by a reentrancy
 * lock: while a frame is being committed, additional render requests set
 * `pendingRerender` and are folded into one coalesced re-render afterwards.
 */
function commitFrame(): void {
  if (!isAltScreenActive) return;
  if (rendering) {
    pendingRerender = true;
    return;
  }
  rendering = true;
  try {
    wrapErrorBoundary(() => {
      process.stdout.write(buildFrame());
    }, (err: unknown) => {
      // UI-level error recovery: close popups and update status
      tuiState.showModelPicker = false;
      tuiState.showKeyManager = false;
      tuiState.showSkillsPicker = false;
      tuiState.showQueueManager = false;
      tuiState.showSessionPicker = false;
      tuiState.showHelp = false;
      tuiState.overlay = { type: "none" };
      if (providerPicker.show) providerPicker.show = false;
      tuiState.setStatus(`⚠️ UI recovered from render glitch (${err instanceof Error ? err.message : String(err)})`);
      tuiState.showToast(`⚠️ UI recovered: ${err instanceof Error ? err.message : String(err)}`, 3000);
    });
  } finally {
    rendering = false;
    if (pendingRerender) {
      pendingRerender = false;
      commitFrame();
    }
  }
}

/**
 * Public render entry point — exported for callbacks (stdin, key handlers,
 * mounted TUI). Coalesces concurrent requests into a single commit.
 */
export function renderAll(): void {
  if (rendering) {
    pendingRerender = true;
    return;
  }
  commitFrame();
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
  isAltScreenActive = false;  // stop renderAll() from painting during teardown
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

  // Set status based on provider state (kept generic: the footer bar already
  // shows Provider/Model/Workspace, so the status line must not echo it).
  tuiState.setStatus("");

  await showBannerIfEligible();

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

  // Activate alternate screen. Set the guard BEFORE writing T.altOn so that
  // any synchronous listeners triggered by write() cannot fire renderAll() prematurely.
  isAltScreenActive = true;
  process.stdout.write(T.altOn + T.hide + T.home + T.clearDown + ENABLE_BRACKETED_PASTE);

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


export async function mountTui() {
  await main();
  return {
    waitUntilRendered: async () => {
      // Small delay to ensure it's on screen
      return new Promise(resolve => setTimeout(resolve, 50));
    },
    openSecretInput: async (config: {title: string, placeholder: string}) => {
      return await tuiState.openSecretInput(config);
    },
    showApiKeySetup: async (): Promise<boolean> => {
      while (true) {
        const key = await tuiState.openSecretInput({ title: "API Key", placeholder: "Enter your API key" });
        if (!key) return false;
        
        tuiState.setStatus("Validating API Key...");
        tuiState.requestRender();
        
        const { credentialsStore } = await import("../lib/keys");
        const { getActiveProvider } = await import("../providers");
        const provider = getActiveProvider();
        
        const valid = provider && provider.validateCredentials ? await provider.validateCredentials(key) : true;
        if (valid) {
          await credentialsStore.saveApiKey(key);
          return true;
        }
        
        tuiState.showToast("API Key không hợp lệ", 3000);
        tuiState.requestRender();
      }
    },
    showAuthError: async (msg: string) => {
      tuiState.showToast(msg, 3000);
      tuiState.requestRender();
    },
    keepAlive: async () => {
      return new Promise<void>(() => {});
    },
    runInteractiveLoop: async () => {
      return new Promise<void>(() => {});
    },
    refreshProviderState: async () => {
      await tuiState.refreshActiveModels();
      tuiState.requestRender();
    },
    setState: (s: string) => {
      tuiState.appState = s;
      if (s === "ready") {
        tuiState.setStatus("Ready");
      }
      tuiState.requestRender();
    }
  };
}
