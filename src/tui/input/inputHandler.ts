import { tuiState } from "../state";
import { getAllCommands } from "../../commands";
import { providerPicker } from "../../components/ProviderPicker";
import { MultilineInputBuffer } from "./multilineInput";

const inputBufferManager = new MultilineInputBuffer();

export function getInputState(): { buffer: string; cursor: number } {
  return {
    buffer: inputBufferManager.getText(),
    cursor: inputBufferManager.getCursor(),
  };
}

export function setInputState(buffer: string, cursor?: number): void {
  inputBufferManager.setText(buffer, cursor);
  tuiState.inputBuffer = inputBufferManager.getText();
  tuiState.cursorPos = inputBufferManager.getCursor();
}

export function resetInputState(): void {
  inputBufferManager.clear();
  tuiState.inputBuffer = "";
  tuiState.cursorPos = 0;
}

export function getSuggestions(input: string) {
  if (!input.startsWith("/")) return [];
  const search = input.toLowerCase().slice(1);
  return getAllCommands()
    .filter((c) => c.name.startsWith(search) || c.aliases.some((a) => a.startsWith(search)))
    .map((c) => ({ name: "/" + c.name, desc: c.description }));
}

export function handleKey(
  data: Buffer,
  callbacks?: {
    renderAll?: () => void;
    sendMessage?: (text: string) => void;
    exitApp?: () => void;
    openModelPicker?: () => Promise<void>;
  }
): void {
  const s = data.toString("utf8");
  const hex = data.toString("hex");
  const renderAll = callbacks?.renderAll || (() => tuiState.requestRender());
  const sendMessage = callbacks?.sendMessage || (() => {});
  const exitApp = callbacks?.exitApp || (() => {});
  const openModelPicker = callbacks?.openModelPicker || (async () => {});

  // 1. Pending Security Approval Modal
  if (tuiState.pendingConfirmation) {
    if (hex === "1b") {
      if (tuiState.pendingConfirmation.onDecision) tuiState.pendingConfirmation.onDecision("n");
      tuiState.pendingConfirmation.resolve(false);
      tuiState.pendingConfirmation = null;
      renderAll();
    } else if (s.toLowerCase() === "y") {
      if (tuiState.pendingConfirmation.onDecision) tuiState.pendingConfirmation.onDecision("y");
      tuiState.pendingConfirmation.resolve(true);
      tuiState.pendingConfirmation = null;
      renderAll();
    } else if (s.toLowerCase() === "a") {
      if (tuiState.pendingConfirmation.onDecision) tuiState.pendingConfirmation.onDecision("a");
      tuiState.pendingConfirmation.resolve(true);
      tuiState.pendingConfirmation = null;
      renderAll();
    } else if (s.toLowerCase() === "n") {
      if (tuiState.pendingConfirmation.onDecision) tuiState.pendingConfirmation.onDecision("n");
      tuiState.pendingConfirmation.resolve(false);
      tuiState.pendingConfirmation = null;
      renderAll();
    }
    return;
  }

  // 2. Model Picker navigation
  if (tuiState.showModelPicker) {
    if (hex === "1b5b41" || hex === "1b4f41") { // Up
      tuiState.modelPickerIdx = tuiState.modelPickerIdx <= 0 ? tuiState.filteredModels.length - 1 : tuiState.modelPickerIdx - 1;
      renderAll();
    } else if (hex === "1b5b42" || hex === "1b4f42") { // Down
      tuiState.modelPickerIdx = tuiState.modelPickerIdx >= tuiState.filteredModels.length - 1 ? 0 : tuiState.modelPickerIdx + 1;
      renderAll();
    } else if (hex === "0d" || hex === "0a") { // Enter
      const sel = tuiState.filteredModels[tuiState.modelPickerIdx];
      if (sel && !sel.includes("No models") && !sel.includes("Gateway offline") && !sel.includes("Error") && !sel.includes("No matches")) {
        tuiState.currentModel = sel;
        tuiState.setStatus("Model: " + tuiState.currentModel);
      }
      tuiState.showModelPicker = false;
      renderAll();
    } else if (hex === "1b") { // Esc
      tuiState.showModelPicker = false;
      tuiState.setStatus("");
      renderAll();
    } else if (hex === "7f" || hex === "08") { // Backspace
      if (tuiState.modelSearchQuery.length > 0) {
        tuiState.modelSearchQuery = tuiState.modelSearchQuery.slice(0, -1);
        const query = tuiState.modelSearchQuery.toLowerCase();
        tuiState.filteredModels = tuiState.availableModels.filter((m) => m.toLowerCase().includes(query));
        if (tuiState.filteredModels.length === 0) tuiState.filteredModels = ["No matches"];
        tuiState.modelPickerIdx = 0;
        renderAll();
      }
    } else if (s.length === 1 && s >= " " && s <= "~") {
      tuiState.modelSearchQuery += s;
      const query = tuiState.modelSearchQuery.toLowerCase();
      tuiState.filteredModels = tuiState.availableModels.filter((m) => m.toLowerCase().includes(query));
      if (tuiState.filteredModels.length === 0) tuiState.filteredModels = ["No matches"];
      tuiState.modelPickerIdx = 0;
      renderAll();
    }
    return;
  }

  // 3. Provider Picker
  if (providerPicker.show) {
    providerPicker.handleKey(hex, {
      renderAll,
      setStatus: (msg: string) => tuiState.setStatus(msg),
      onSelect: (sel) => {
        inputBufferManager.setText("/key " + sel + " ");
        tuiState.inputBuffer = inputBufferManager.getText();
        tuiState.cursorPos = inputBufferManager.getCursor();
        tuiState.setStatus("Paste your API key and press Enter");
        renderAll();
      },
    });
    return;
  }

  // 4. Help toggle
  if (tuiState.showHelp && (hex === "1b" || s === "?")) {
    tuiState.showHelp = false;
    renderAll();
    return;
  }

  // 5. Ctrl+C (1st aborts running stream/tool; 2nd exits)
  if (hex === "03") {
    if (tuiState.isStreaming) {
      tuiState.abortController?.abort();
      if (tuiState.spinnerTimer) {
        clearInterval(tuiState.spinnerTimer);
        tuiState.spinnerTimer = null;
      }
      tuiState.isStreaming = false;
      tuiState.setStatus("Cancelled");
      renderAll();
      return;
    }
    tuiState.ctrlCCount++;
    if (tuiState.ctrlCCount >= 2) {
      exitApp();
    } else {
      tuiState.setStatus("Press Ctrl+C again to exit (or type /exit)");
      renderAll();
      if (tuiState.ctrlCTimer) clearTimeout(tuiState.ctrlCTimer);
      tuiState.ctrlCTimer = setTimeout(() => {
        tuiState.ctrlCCount = 0;
        tuiState.setStatus("");
        renderAll();
      }, 2000);
    }
    return;
  }

  // 6. Ctrl+L — clear / redraw
  if (hex === "0c") {
    renderAll();
    return;
  }

  // 7. Esc — close popups or cancel stream, never exit
  if (hex === "1b") {
    if (tuiState.showHelp) { tuiState.showHelp = false; renderAll(); return; }
    if (tuiState.showModelPicker) { tuiState.showModelPicker = false; renderAll(); return; }
    if (providerPicker.show) { providerPicker.show = false; renderAll(); return; }
    if (tuiState.isStreaming) {
      tuiState.abortController?.abort();
      if (tuiState.spinnerTimer) {
        clearInterval(tuiState.spinnerTimer);
        tuiState.spinnerTimer = null;
      }
      tuiState.isStreaming = false;
      tuiState.setStatus("Cancelled");
      renderAll();
    }
    return;
  }

  // 8. Ctrl+N — model picker
  if (s === "\x0e") {
    openModelPicker();
    return;
  }

  // 9. Slash command suggestions navigation
  const suggests = getSuggestions(inputBufferManager.getText());
  if (suggests.length > 0) {
    if (hex === "1b5b41" || hex === "1b4f41") { // Up
      tuiState.cmdSuggestIdx = tuiState.cmdSuggestIdx <= 0 ? suggests.length - 1 : tuiState.cmdSuggestIdx - 1;
      renderAll();
      return;
    }
    if (hex === "1b5b42" || hex === "1b4f42") { // Down
      tuiState.cmdSuggestIdx = tuiState.cmdSuggestIdx >= suggests.length - 1 ? 0 : tuiState.cmdSuggestIdx + 1;
      renderAll();
      return;
    }
    if (hex === "09") { // Tab
      const selected = suggests[tuiState.cmdSuggestIdx]?.name;
      if (selected) {
        inputBufferManager.setText(selected + " ");
        tuiState.inputBuffer = inputBufferManager.getText();
        tuiState.cursorPos = inputBufferManager.getCursor();
        renderAll();
      }
      return;
    }
  }

  // 10. Tab — toggle mode (if not autocompleting)
  if (hex === "09") {
    tuiState.agentMode = tuiState.agentMode === "Build" ? "Plan" : "Build";
    tuiState.setStatus("Mode: " + tuiState.agentMode);
    renderAll();
    return;
  }

  // 11. ? — help toggle when empty input
  if (s === "?" && inputBufferManager.getText() === "") {
    tuiState.showHelp = !tuiState.showHelp;
    renderAll();
    return;
  }

  // 12. Page Up / Page Down — scrolling
  if (hex === "1b5b357e") { tuiState.scrollOffset += 5; renderAll(); return; } // PgUp
  if (hex === "1b5b367e") { tuiState.scrollOffset = Math.max(0, tuiState.scrollOffset - 5); renderAll(); return; } // PgDn

  // 13. Shift+Enter / Alt+Enter / Ctrl+J — Insert newline in input
  // (hex: 0a, 1b0d, 1b5b31333b3275, 1b5b32373b323b31337e)
  const isShiftEnter =
    hex === "0a" ||
    hex === "1b0d" ||
    hex === "1b5b31333b3275" ||
    hex === "1b5b32373b323b31337e" ||
    (s.length === 1 && s.charCodeAt(0) === 10);

  if (isShiftEnter) {
    inputBufferManager.insertNewline();
    tuiState.inputBuffer = inputBufferManager.getText();
    tuiState.cursorPos = inputBufferManager.getCursor();
    renderAll();
    return;
  }

  // 14. Up / Down arrow navigation
  if (hex === "1b5b41" || hex === "1b4f41") { // Up arrow
    if (inputBufferManager.isMultiline() && !inputBufferManager.isAtFirstLine()) {
      inputBufferManager.moveUp();
      tuiState.inputBuffer = inputBufferManager.getText();
      tuiState.cursorPos = inputBufferManager.getCursor();
      renderAll();
      return;
    }
    // History up
    if (tuiState.promptHistory.length > 0) {
      if (tuiState.historyIndex === -1) {
        tuiState.savedInput = inputBufferManager.getText();
        tuiState.historyIndex = tuiState.promptHistory.length - 1;
      } else if (tuiState.historyIndex > 0) {
        tuiState.historyIndex--;
      }
      const histText = tuiState.promptHistory[tuiState.historyIndex] || "";
      inputBufferManager.setText(histText);
      tuiState.inputBuffer = inputBufferManager.getText();
      tuiState.cursorPos = inputBufferManager.getCursor();
      renderAll();
      return;
    }
    // Scroll chat up if history empty
    tuiState.scrollOffset++;
    renderAll();
    return;
  }

  if (hex === "1b5b42" || hex === "1b4f42") { // Down arrow
    if (inputBufferManager.isMultiline() && !inputBufferManager.isAtLastLine()) {
      inputBufferManager.moveDown();
      tuiState.inputBuffer = inputBufferManager.getText();
      tuiState.cursorPos = inputBufferManager.getCursor();
      renderAll();
      return;
    }
    // History down
    if (tuiState.historyIndex !== -1) {
      if (tuiState.historyIndex < tuiState.promptHistory.length - 1) {
        tuiState.historyIndex++;
        const histText = tuiState.promptHistory[tuiState.historyIndex];
        inputBufferManager.setText(histText);
      } else {
        tuiState.historyIndex = -1;
        inputBufferManager.setText(tuiState.savedInput);
      }
      tuiState.inputBuffer = inputBufferManager.getText();
      tuiState.cursorPos = inputBufferManager.getCursor();
      renderAll();
      return;
    }
    // Scroll chat down
    tuiState.scrollOffset = Math.max(0, tuiState.scrollOffset - 1);
    renderAll();
    return;
  }

  // Left / Right cursor movement
  if (hex === "1b5b44") { // Left
    inputBufferManager.moveLeft();
    tuiState.cursorPos = inputBufferManager.getCursor();
    renderAll();
    return;
  }
  if (hex === "1b5b43") { // Right
    inputBufferManager.moveRight();
    tuiState.cursorPos = inputBufferManager.getCursor();
    renderAll();
    return;
  }

  // 15. Enter — submit prompt (handles \r)
  if (hex === "0d") {
    if (tuiState.isStreaming) return;
    const text = inputBufferManager.getText();
    inputBufferManager.clear();
    tuiState.inputBuffer = "";
    tuiState.cursorPos = 0;
    tuiState.cmdSuggestIdx = 0;
    tuiState.setStatus("");
    renderAll();
    if (text.trim()) {
      tuiState.pushPromptHistory(text);
      sendMessage(text);
    }
    return;
  }

  // 16. Backspace
  if (hex === "7f" || hex === "08") {
    if (inputBufferManager.deleteBackward()) {
      tuiState.inputBuffer = inputBufferManager.getText();
      tuiState.cursorPos = inputBufferManager.getCursor();
      tuiState.cmdSuggestIdx = 0;
      renderAll();
    }
    return;
  }

  // 17. Delete key
  if (hex === "1b5b337e") {
    if (inputBufferManager.deleteForward()) {
      tuiState.inputBuffer = inputBufferManager.getText();
      tuiState.cursorPos = inputBufferManager.getCursor();
      tuiState.cmdSuggestIdx = 0;
      renderAll();
    }
    return;
  }

  // 18. Line Navigation & Editing shortcuts
  if (hex === "01" || s === "\x01") { // Ctrl+A (Home)
    inputBufferManager.moveToStartOfLine();
    tuiState.cursorPos = inputBufferManager.getCursor();
    renderAll();
    return;
  }
  if (hex === "05" || s === "\x05") { // Ctrl+E (End)
    inputBufferManager.moveToEndOfLine();
    tuiState.cursorPos = inputBufferManager.getCursor();
    renderAll();
    return;
  }
  if (hex === "0b" || s === "\x0b") { // Ctrl+K (kill line)
    inputBufferManager.killToEndOfLine();
    tuiState.inputBuffer = inputBufferManager.getText();
    tuiState.cursorPos = inputBufferManager.getCursor();
    tuiState.cmdSuggestIdx = 0;
    renderAll();
    return;
  }
  if (hex === "15" || s === "\x15") { // Ctrl+U (clear line)
    inputBufferManager.clearLine();
    tuiState.inputBuffer = "";
    tuiState.cursorPos = 0;
    tuiState.cmdSuggestIdx = 0;
    renderAll();
    return;
  }
  if (hex === "17") { // Ctrl+W (delete word back)
    inputBufferManager.deleteWordBackward();
    tuiState.inputBuffer = inputBufferManager.getText();
    tuiState.cursorPos = inputBufferManager.getCursor();
    tuiState.cmdSuggestIdx = 0;
    renderAll();
    return;
  }

  // 19. Printable characters & Multi-byte UTF-8
  if (s.length === 1 && s.charCodeAt(0) >= 32) {
    inputBufferManager.insertText(s);
    tuiState.inputBuffer = inputBufferManager.getText();
    tuiState.cursorPos = inputBufferManager.getCursor();
    tuiState.cmdSuggestIdx = 0;
    renderAll();
    return;
  }

  if (data.length > 1 && !s.startsWith("\x1b")) {
    inputBufferManager.insertText(s);
    tuiState.inputBuffer = inputBufferManager.getText();
    tuiState.cursorPos = inputBufferManager.getCursor();
    tuiState.cmdSuggestIdx = 0;
    renderAll();
    return;
  }
}
