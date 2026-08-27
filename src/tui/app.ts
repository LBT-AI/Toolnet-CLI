import { tuiState } from "./state";
import { computeLayout, stripAnsi } from "./layout";
import { renderHeader } from "./renderers/headerRenderer";
import { renderChatMessages } from "./renderers/chatRenderer";
import { renderSidebar } from "./renderers/sidebarRenderer";
import { renderStatusBar, renderInputArea } from "./renderers/statusRenderer";
import { renderConfirmationModal, renderToast } from "./renderers/modalRenderer";
import { renderModelPickerBox } from "./renderers/modelPickerRenderer";
import { renderSuggestionsPopup } from "./renderers/suggestRenderer";
import { handleKey, getSuggestions, getInputState, setInputState, resetInputState } from "./input/inputHandler";
import { sendMessage } from "./events/agentWiring";
import { A, T, write, getSize } from "../term";
import { BracketedPasteParser, ENABLE_BRACKETED_PASTE } from "../lib/bracketedPaste";
import { setupTerminalLifecycle, restoreTerminal, wrapErrorBoundary } from "../lib/terminalLifecycle";
import { initWorkspace } from "../lib/codingAgent";
import { playSplashAnimation } from "../splash";
import { loadConfig } from "../lib/config";
import { parseSessionArgs, loadSession, getLastSessionId } from "../lib/sessionPersistence";
import { providerPicker } from "../components/ProviderPicker";
import { loadCliKeys } from "../lib/keys";
import { checkPendingRecovery, clearPendingRecovery, markCleanExit } from "../lib/crashRecovery";
import { pluginManager } from "../lib/plugins/pluginManager";

setupTerminalLifecycle();

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

    // 1. Header
    out.push(renderHeader(cols, {
      currentModel: tuiState.currentModel,
      agentMode: tuiState.agentMode,
      bypassMode: tuiState.bypassMode,
      bypassLevel: tuiState.bypassLevel,
      lastTokens: tuiState.lastTokens,
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

    // 5. Suggestions Popup
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

    // 8. Input Area
    out.push(renderInputArea(cols, tuiState.inputBuffer, primaryColor));

    // 9. Status Bar
    out.push(renderStatusBar(cols, {
      showHelp: tuiState.showHelp,
      isStreaming: tuiState.isStreaming,
      spinnerIdx: tuiState.spinnerIdx,
      statusText: tuiState.statusText,
      elapsedDisplay: tuiState.elapsedDisplay,
      primaryColor,
    }));

    // Cursor position
    if (!tuiState.showHelp && !tuiState.showModelPicker && !providerPicker.show) {
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

    if (providerPicker.show) {
      providerPicker.render();
    }
  });
}

tuiState.renderCallback = renderAll;

export async function openModelPicker(): Promise<void> {
  tuiState.showModelPicker = true;
  tuiState.modelSearchQuery = "";
  if (tuiState.availableModels.length === 0 || tuiState.availableModels[0] === "Gateway offline") {
    tuiState.availableModels = ["Loading..."];
    tuiState.filteredModels = tuiState.availableModels;
    tuiState.modelPickerIdx = 0;
    tuiState.setStatus("Fetching models...");
    renderAll();
    try {
      const localKeys = loadCliKeys();
      const masterKey = localKeys["toolnet"] || localKeys["gateway"] || localKeys["default"];
      const fetchHeaders: Record<string, string> = {};
      if (masterKey) fetchHeaders["Authorization"] = `Bearer ${masterKey}`;

      const res = await fetch(tuiState.gatewayUrl + "/v1/models", { headers: fetchHeaders });
      if (res.ok) {
        const data = (await res.json()) as any;
        const allModels = (data.data || []).map((m: any) => m.id as string);
        tuiState.availableModels = allModels.length > 0 ? allModels : ["No models available"];
      } else {
        tuiState.availableModels = ["Error loading models"];
      }
    } catch {
      tuiState.availableModels = ["Gateway offline"];
    }
  }

  tuiState.filteredModels = [...tuiState.availableModels];
  tuiState.modelPickerIdx = tuiState.filteredModels.indexOf(tuiState.currentModel);
  if (tuiState.modelPickerIdx < 0) tuiState.modelPickerIdx = 0;
  tuiState.setStatus("Type to search  ↑↓ navigate  Enter select  Esc cancel");
  renderAll();
}

function exitApp(): void {
  if (tuiState.spinnerTimer) clearInterval(tuiState.spinnerTimer);
  markCleanExit();
  restoreTerminal();
  process.stdout.write("Goodbye!\r\n");
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
    if (pendingRecovery.model) tuiState.currentModel = pendingRecovery.model;
    if (pendingRecovery.agentMode) tuiState.agentMode = pendingRecovery.agentMode;
  }

  try {
    const res = await fetch(tuiState.gatewayUrl + "/api/health", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error("not ok");
    tuiState.setStatus("● Connected to " + tuiState.gatewayUrl);
  } catch {
    tuiState.setStatus("✖ Cannot reach gateway at " + tuiState.gatewayUrl + " — start with ./start-all.sh");
  }

  if (!process.argv.includes("--no-splash")) {
    await playSplashAnimation();
  }

  try {
    const cfg = loadConfig();
    if (cfg.defaultModel) tuiState.currentModel = cfg.defaultModel;
    if (cfg.baseUrl) tuiState.gatewayUrl = cfg.baseUrl;
  } catch {}

  const { resume, sessionId: requestedSessionId } = parseSessionArgs(process.argv.slice(2));
  if (requestedSessionId) {
    const loaded = loadSession(requestedSessionId);
    if (loaded && Array.isArray(loaded.messages)) {
      tuiState.currentSessionId = loaded.sessionId;
      tuiState.messages = loaded.messages as any;
      if (loaded.metadata?.model) tuiState.currentModel = loaded.metadata.model;
      if (loaded.metadata?.agentMode) tuiState.agentMode = loaded.metadata.agentMode;
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
        // Multi-line paste into buffer without auto-submitting
        const currentBuf = tuiState.inputBuffer;
        const cur = tuiState.cursorPos;
        const newBuf = currentBuf.slice(0, cur) + chunk.content + currentBuf.slice(cur);
        setInputState(newBuf, cur + chunk.content.length);
        tuiState.cmdSuggestIdx = 0;
        renderAll();
      } else {
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
    }
  });

  process.on("exit", () => {
    restoreTerminal();
  });

  process.on("SIGTERM", exitApp);
}

export { getInputState, setInputState, resetInputState };
