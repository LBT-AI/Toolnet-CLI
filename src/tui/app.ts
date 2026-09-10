import { tuiState } from "./state";
import { computeLayout, stripAnsi, visibleWidth } from "./layout";
import { resolveViewport } from "./viewport";
import { renderHeader } from "./renderers/headerRenderer";
import { renderChatMessages } from "./renderers/chatRenderer";
import { renderSidebar } from "./renderers/sidebarRenderer";
import { renderWorkingStatus, renderInputArea, renderFooter } from "./renderers/statusRenderer";
import { renderConfirmationModal, renderToast, renderSecretInputModal, renderDeviceCodeModal } from "./renderers/modalRenderer";
import { renderModelPickerBox } from "./renderers/modelPickerRenderer";
import { renderKeyManagerBox } from "./renderers/keyManagerRenderer";
import { renderSkillsPickerBox } from "./renderers/skillsPickerRenderer";
import { renderQueueManagerBox } from "./renderers/queueManagerRenderer";
import { renderSessionPickerBox } from "./renderers/sessionPickerRenderer";
import { renderSuggestionsPopup } from "./renderers/suggestRenderer";
import { renderReasoningPanel } from "./renderers/reasoningPanel";
import { renderToolsPanelBox } from "./renderers/toolsPanelRenderer";
import { renderHarnessPanelBox } from "./renderers/harnessPanelRenderer";
import { handleKey, handlePaste, getSuggestions, getInputState, setInputState, resetInputState } from "./input/inputHandler";
import { sendMessage } from "./events/agentWiring";
import { A, T, getSize } from "../term";
import { BracketedPasteParser, ENABLE_BRACKETED_PASTE } from "../lib/bracketedPaste";
import { setupTerminalLifecycle, restoreTerminal, wrapErrorBoundary, onTerminalResize } from "../lib/terminalLifecycle";
import { setResponseLanguage } from "../lib/language";
import { reasoningEffortLabel } from "../lib/reasoning";
import { initWorkspace } from "../lib/codingAgent";
import { loadConfig } from "../lib/config";
import { parseSessionArgs, loadSession, getLastSessionId, formatExitMessage } from "../lib/sessionPersistence";
import { providerPicker } from "../components/ProviderPicker";
import { checkPendingRecovery, clearPendingRecovery, markCleanExit } from "../lib/crashRecovery";
import { pluginManager } from "../lib/plugins/pluginManager";
import { getActiveProviderConfig, getActiveProvider, autoRestoreActiveProvider } from "../providers";
import { onProviderSwitch } from "../commands/provider";
import { statusManager } from "./statusService";
import { messageQueue } from "../lib/messageQueue";
import { workspaceAccessAnimation } from "./animations/modalAnimation";

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
  const layout = computeLayout(activeSuggests.length, 2, tuiState.cursorPos, statusActive);
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

  // 2A. Thinking panel — only when the upstream API actually streamed
  //     reasoning content (or a collapsed summary exists); never fabricated.
  if (tuiState.reasoningText || tuiState.reasoningCollapsed) {
    chatLines.push(
      ...renderReasoningPanel(chatCols, {
        text: tuiState.reasoningText,
        elapsed: tuiState.reasoningElapsed,
        effort: reasoningEffortLabel(tuiState.reasoningSettings),
        collapsed: tuiState.reasoningCollapsed,
        tokens: tuiState.reasoningTokens,
      })
    );
  }

  // ── Viewport resolve — the ONLY scroll decision point, once per frame ──
  // Layout was computed above; resolve the follow-tail/anchor window against
  // the measured height and mirror it into legacy scrollOffset for readers.
  const totalLines = chatLines.length;
  const window = resolveViewport(tuiState.chatViewport, totalLines, chatRows);
  // Legacy mirror: scrollOffset keeps its old meaning (rows scrolled past bottom).
  tuiState.scrollOffset = Math.max(0, totalLines - chatRows - window.start);
  const visibleLines = chatLines.slice(window.start, window.end);

  // 3. Sidebar Lines
  const panelLines = hasPanel ? renderSidebar(tuiState.currentModel, tuiState.startTime, panelWidth) : [];

  // 4. Combine Chat & Sidebar Lines
  // Rows are capped at cols - 1 wide: a line that fills the last column +
  // CRLF double-advances the cursor on autowrap terminals, scrolling the
  // frame and leaving stale duplicate provider/input/workspace rows behind.
  for (let i = 0; i < chatRows; i++) {
    const line = visibleLines[i] ?? "";
    // Pad by TERMINAL CELLS, not JS string length: CJK/emoji occupy 2 cells,
    // and under-padding lets the terminal soft-wrap the row, which shifts the
    // whole frame and makes new lines overwrite old ones.
    const chatPad = Math.max(0, chatCols - 1 - visibleWidth(line));
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

  // 10. Bottom Status Rule — provider · model · mode · tokens · workspace
  out.push(renderFooter(cols, {
    providerName: tuiState.providerName,
    currentModel: tuiState.currentModel,
    agentMode: tuiState.agentMode,
    bypassMode: tuiState.bypassMode,
    lastTokens: tuiState.lastTokens,
  }));

  // Erase anything below the freshly-painted frame (prevents stale duplicate
  // status/input/footer bars after resize or when a smaller frame is drawn).
  out.push(T.clearDown);

  // ── Cursor positioning ─────────────────────────────────────────────────────
  // Compute the absolute cursor position from the actual rendered input area.
  // The input area sits directly above the footer: divider row, then up to 3
  // visible input lines. The cursor must land on the exact line/column where
  // the user is typing, not on the divider or a separate row.
  const inputBuffer = tuiState.inputBuffer;
  const inputLines = inputBuffer ? inputBuffer.split("\n") : [];
  const maxInputLines = inputLines.length > 0 ? Math.min(3, inputLines.length) : 1;
  const inputStartIdx = Math.max(0, inputLines.length - maxInputLines);

  // Find which line and column the cursor is on within the input buffer.
  // The buffer cursor is a code-point index; we map it to terminal cells via
  // visibleWidth so CJK/emoji before the cursor don't misplace the caret.
  let cursorLine = 0;
  let cursorColInLine = 0;
  if (inputBuffer) {
    let pos = 0;
    for (let i = 0; i < inputLines.length; i++) {
      const lineLen = Array.from(inputLines[i]).length;
      if (pos + lineLen >= tuiState.cursorPos || i === inputLines.length - 1) {
        cursorLine = i;
        cursorColInLine = tuiState.cursorPos - pos;
        break;
      }
      pos += lineLen + 1; // +1 for the newline character
    }
  }

  const visibleLineIdx = cursorLine - inputStartIdx;

  // The input area (from bottom): footer → last input line → ... → divider.
  // Footer occupies the last terminal row. The last visible input line is at
  // rows - 1, the second-to-last at rows - 2, etc.
  // Prompt prefix ('> ' or '… ') is always 2 visible cells wide.
  const promptWidth = 2;
  const cursorPrefix = Array.from(inputLines[cursorLine] ?? "").slice(0, cursorColInLine).join("");
  layout.cursorRow = rows - 1 - (maxInputLines - 1 - visibleLineIdx);
  layout.cursorCol = Math.min(promptWidth + 1 + visibleWidth(cursorPrefix), cols - 1);

  // Cursor: only visible when nothing is layered on top of the main frame.
  const anyOverlayActive =
    tuiState.showHelp ||
    tuiState.showModelPicker ||
    tuiState.showKeyManager ||
    tuiState.showSecretInput ||
    tuiState.showSkillsPicker ||
    tuiState.showQueueManager ||
    tuiState.showSessionPicker ||
    Boolean(tuiState.deviceCodeModal) ||
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
    workspaceAccessAnimation.syncOpening(tuiState.pendingConfirmation, renderAll);
    out.push(...renderConfirmationModal(
      cols,
      rows,
      tuiState.pendingConfirmation,
      workspaceAccessAnimation.getRenderState(),
    ));
  } else if (workspaceAccessAnimation.getSnapshot()) {
    // Keep the closing frame in the same render tree until its elapsed-time
    // transition completes; the engine clears the snapshot via its callback.
    out.push(...renderConfirmationModal(
      cols,
      rows,
      workspaceAccessAnimation.getSnapshot()!,
      workspaceAccessAnimation.getRenderState(),
    ));
  } else {
    // Guard against external state resets (test teardown, crash recovery, or
    // another overlay replacing the modal) leaving an orphaned timer behind.
    workspaceAccessAnimation.reset();
  }

  if (tuiState.deviceCodeModal) {
    out.push(...renderDeviceCodeModal(cols, rows, tuiState.deviceCodeModal));
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

  const { resume, sessionId: requestedSessionId } = parseSessionArgs(process.argv.slice(2));
  if (requestedSessionId) {
    const loaded = loadSession(requestedSessionId);
    if (loaded && Array.isArray(loaded.messages)) {
      tuiState.currentSessionId = loaded.sessionId;
      tuiState.messages = loaded.messages as any;
      if (loaded.metadata?.model) tuiState.currentModel = loaded.metadata.model;
      if (loaded.metadata?.agentMode) tuiState.agentMode = loaded.metadata.agentMode;
      if (loaded.metadata?.responseLanguage) {
        tuiState.responseLanguage = loaded.metadata.responseLanguage;
        setResponseLanguage(loaded.metadata.responseLanguage);
      }
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
