import { tuiState } from "../state";
import { getAllCommands } from "../../commands";
import { providerPicker } from "../../components/ProviderPicker";
import { MultilineInputBuffer } from "./multilineInput";
import { getKeyManagerProviders } from "../renderers/keyManagerRenderer";
import { saveCliKey, deleteCliKey, getCliKey } from "../../lib/keys";
import { syncProviderOnKeySave, setActiveProvider } from "../../providers";
import { BRACKETED_PASTE_START, parseBracketedPaste, stripBracketedPaste } from "../../lib/bracketedPaste";
import { statusManager } from "../statusService";
import { messageQueue } from "../../lib/messageQueue";

const inputBufferManager = new MultilineInputBuffer();

export interface InputCallbacks {
  renderAll?: () => void;
  sendMessage?: (text: string) => void;
  exitApp?: () => void;
  openModelPicker?: () => Promise<void>;
}

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

/**
 * Handles incoming pasted text with strict modal focus priority.
 * Ensures that if a modal (e.g. Set Key) is active, paste is captured by the modal
 * and NEVER leaks down to the bottom command line input.
 */
export function handlePaste(
  pastedText: string,
  callbacks?: InputCallbacks
): void {
  const renderAll = callbacks?.renderAll || (() => tuiState.requestRender());
  try {
    _handlePasteInternal(pastedText, callbacks);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    tuiState.setStatus(`⚠️ Paste handling glitch recovered: ${errMsg}`);
    tuiState.showToast(`⚠️ Paste error: ${errMsg}`, 3000);
    renderAll();
  }
}

function _handlePasteInternal(
  pastedText: string,
  callbacks?: InputCallbacks
): void {
  const renderAll = callbacks?.renderAll || (() => tuiState.requestRender());

  // 1. Pending Security Approval Modal
  if (tuiState.pendingConfirmation) {
    return;
  }

  // 2. Key Manager Modal
  if (tuiState.showKeyManager) {
    // If confirm delete mode is active, ignore paste
    if (tuiState.keyManagerConfirmDelete) {
      return;
    }

    // If inputting API key, insert sanitized text into modal buffer at cursor
    if (tuiState.keyManagerInput) {
      const sanitized = stripBracketedPaste(pastedText).replace(/[\r\n\x00-\x1f\x7f]/g, "");
      if (!sanitized) return;

      const input = tuiState.keyManagerInput;
      const cur = input.cursor !== undefined ? input.cursor : input.buffer.length;
      input.buffer = input.buffer.slice(0, cur) + sanitized + input.buffer.slice(cur);
      input.cursor = cur + sanitized.length;
      renderAll();
      return;
    }

    // In provider list navigation mode, ignore paste so it doesn't leak down
    return;
  }

  // 3. Model Picker
  if (tuiState.showModelPicker) {
    const sanitized = stripBracketedPaste(pastedText).replace(/[\r\n\x00-\x1f\x7f]/g, "");
    if (!sanitized) return;

    tuiState.modelSearchQuery += sanitized;
    const query = tuiState.modelSearchQuery.toLowerCase();
    tuiState.filteredModels = tuiState.availableModels.filter((m) => m.toLowerCase().includes(query));
    if (tuiState.filteredModels.length === 0) {
      tuiState.filteredModels = ["No matches"];
    }
    tuiState.modelPickerIdx = 0;
    renderAll();
    return;
  }

  // 3B. Skills Picker
  if (tuiState.showSkillsPicker) {
    if (tuiState.selectedSkillDetail) return;
    const sanitized = stripBracketedPaste(pastedText).replace(/[\r\n\x00-\x1f\x7f]/g, "");
    if (!sanitized) return;

    tuiState.skillsSearchQuery += sanitized;
    const query = tuiState.skillsSearchQuery.toLowerCase();
    tuiState.filteredSkills = tuiState.availableSkills.filter(
      (sk) => sk.id.toLowerCase().includes(query) || sk.name.toLowerCase().includes(query) || sk.description.toLowerCase().includes(query)
    );
    tuiState.skillsPickerIdx = 0;
    renderAll();
    return;
  }

  // 3C. Queue Manager Edit Mode
  if (tuiState.showQueueManager) {
    if (tuiState.queueManagerEditing) {
      const sanitized = stripBracketedPaste(pastedText).replace(/[\r\n\x00-\x1f\x7f]/g, "");
      if (!sanitized) return;

      const editing = tuiState.queueManagerEditing;
      const chars = Array.from(editing.buffer);
      chars.splice(editing.cursor, 0, sanitized);
      editing.buffer = chars.join("");
      editing.cursor += Array.from(sanitized).length;
      renderAll();
      return;
    }
    return;
  }

  // 3D. Session Picker Search paste
  if (tuiState.showSessionPicker) {
    const sanitized = stripBracketedPaste(pastedText).replace(/[\r\n\x00-\x1f\x7f]/g, "");
    if (!sanitized) return;
    tuiState.sessionSearchQuery += sanitized;
    tuiState.filterSessions();
    renderAll();
    return;
  }

  // 4. Provider Picker or Help overlay
  if (providerPicker.show || tuiState.showHelp) {
    return;
  }

  // 5. Default: Command line multiline input
  const sanitized = stripBracketedPaste(pastedText);
  inputBufferManager.insertText(sanitized);
  tuiState.inputBuffer = inputBufferManager.getText();
  tuiState.cursorPos = inputBufferManager.getCursor();
  tuiState.cmdSuggestIdx = 0;
  renderAll();
}

/**
 * Primary keyboard and input sequence handler with error boundary.
 */
export function handleKey(
  data: Buffer | string,
  callbacks?: InputCallbacks
): void {
  const renderAll = callbacks?.renderAll || (() => tuiState.requestRender());
  try {
    _handleKeyInternal(data, callbacks);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    tuiState.setStatus(`⚠️ Key handling glitch recovered: ${errMsg}`);
    tuiState.showToast(`⚠️ Key error: ${errMsg}`, 3000);
    renderAll();
  }
}

function _handleKeyInternal(
  data: Buffer | string,
  callbacks?: InputCallbacks
): void {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  const s = buf.toString("utf8");
  const hex = buf.toString("hex");
  const renderAll = callbacks?.renderAll || (() => tuiState.requestRender());
  const sendMessage = callbacks?.sendMessage || (() => {});
  const exitApp = callbacks?.exitApp || (() => {});
  const openModelPicker = callbacks?.openModelPicker || (async () => {});

  // 0. Bracketed Paste detection in incoming buffer
  if (s.includes(BRACKETED_PASTE_START)) {
    const chunks = parseBracketedPaste(s);
    for (const chunk of chunks) {
      if (chunk.type === "paste") {
        handlePaste(chunk.content, callbacks);
        continue;
      }
      if (chunk.content.length > 0) {
        handleKey(Buffer.from(chunk.content), callbacks);
      }
    }
    return;
  }

  // 1. Pending Security Approval Modal
  if (tuiState.pendingConfirmation) {
    if (hex === "1b") {
      if (tuiState.pendingConfirmation.onDecision) tuiState.pendingConfirmation.onDecision("n");
      tuiState.pendingConfirmation.resolve(false);
      tuiState.pendingConfirmation = null;
      renderAll();
      return;
    }
    if (s.toLowerCase() === "y") {
      if (tuiState.pendingConfirmation.onDecision) tuiState.pendingConfirmation.onDecision("y");
      tuiState.pendingConfirmation.resolve(true);
      tuiState.pendingConfirmation = null;
      renderAll();
      return;
    }
    if (s.toLowerCase() === "a") {
      if (tuiState.pendingConfirmation.onDecision) tuiState.pendingConfirmation.onDecision("a");
      tuiState.pendingConfirmation.resolve(true);
      tuiState.pendingConfirmation = null;
      renderAll();
      return;
    }
    if (s.toLowerCase() === "n") {
      if (tuiState.pendingConfirmation.onDecision) tuiState.pendingConfirmation.onDecision("n");
      tuiState.pendingConfirmation.resolve(false);
      tuiState.pendingConfirmation = null;
      renderAll();
      return;
    }
    return;
  }

  // 2. Model Picker navigation
  if (tuiState.showModelPicker) {
    if (hex === "1b5b41" || hex === "1b4f41") { // Up
      tuiState.modelPickerIdx = tuiState.modelPickerIdx <= 0 ? tuiState.filteredModels.length - 1 : tuiState.modelPickerIdx - 1;
      renderAll();
      return;
    }
    if (hex === "1b5b42" || hex === "1b4f42") { // Down
      tuiState.modelPickerIdx = tuiState.modelPickerIdx >= tuiState.filteredModels.length - 1 ? 0 : tuiState.modelPickerIdx + 1;
      renderAll();
      return;
    }
    if (hex === "0d" || hex === "0a") { // Enter
      const sel = tuiState.filteredModels[tuiState.modelPickerIdx];
      if (
        sel &&
        !sel.includes("No models") &&
        !sel.includes("Provider offline") &&
        !sel.includes("Gateway offline") &&
        !sel.includes("Error") &&
        !sel.includes("No matches") &&
        !sel.includes("No provider") &&
        !sel.includes("Loading...")
      ) {
        tuiState.currentModel = sel;
        tuiState.setStatus(`Provider: ${tuiState.providerName || "Not configured"} │ Model: ${tuiState.currentModel}`);
      } else {
        tuiState.setStatus(`Provider: ${tuiState.providerName || "Not configured"} │ Model: ${tuiState.currentModel || "Not selected"}`);
      }
      tuiState.showModelPicker = false;
      renderAll();
      return;
    }
    if (hex === "1b") { // Esc
      tuiState.showModelPicker = false;
      tuiState.setStatus(`Provider: ${tuiState.providerName || "Not configured"} │ Model: ${tuiState.currentModel || "Not selected"}`);
      renderAll();
      return;
    }
    if (hex === "7f" || hex === "08") { // Backspace
      if (tuiState.modelSearchQuery.length > 0) {
        tuiState.modelSearchQuery = tuiState.modelSearchQuery.slice(0, -1);
        const query = tuiState.modelSearchQuery.toLowerCase();
        tuiState.filteredModels = tuiState.availableModels.filter((m) => m.toLowerCase().includes(query));
        if (tuiState.filteredModels.length === 0) tuiState.filteredModels = ["No matches"];
        tuiState.modelPickerIdx = 0;
        renderAll();
      }
      return;
    }
    if (s.length >= 1 && !s.startsWith("\x1b") && s >= " " && s <= "~") {
      tuiState.modelSearchQuery += s;
      const query = tuiState.modelSearchQuery.toLowerCase();
      tuiState.filteredModels = tuiState.availableModels.filter((m) => m.toLowerCase().includes(query));
      if (tuiState.filteredModels.length === 0) tuiState.filteredModels = ["No matches"];
      tuiState.modelPickerIdx = 0;
      renderAll();
      return;
    }
    return;
  }

  // 2B. Skills Picker Modal
  if (tuiState.showSkillsPicker) {
    // If viewing skill detail
    if (tuiState.selectedSkillDetail) {
      if (hex === "1b" || hex === "7f" || hex === "08" || s.toLowerCase() === "b") { // Esc / Backspace / 'b' -> Back to list
        tuiState.selectedSkillDetail = null;
        tuiState.setStatus("↑↓ Navigate │ Enter Select │ Esc Close");
        renderAll();
        return;
      }
      if (s === " " || s.toLowerCase() === "e" || s.toLowerCase() === "t" || hex === "0d" || hex === "0a") { // Space / E / T / Enter -> Toggle
        tuiState.toggleSkillInPicker();
        renderAll();
        return;
      }
      return;
    }

    // In list view
    if (hex === "1b5b41" || hex === "1b4f41") { // Up
      tuiState.skillsPickerIdx =
        tuiState.skillsPickerIdx <= 0
          ? Math.max(0, tuiState.filteredSkills.length - 1)
          : tuiState.skillsPickerIdx - 1;
      renderAll();
      return;
    }
    if (hex === "1b5b42" || hex === "1b4f42") { // Down
      tuiState.skillsPickerIdx =
        tuiState.skillsPickerIdx >= tuiState.filteredSkills.length - 1
          ? 0
          : tuiState.skillsPickerIdx + 1;
      renderAll();
      return;
    }
    if (hex === "0d" || hex === "0a") { // Enter
      const sel = tuiState.filteredSkills[tuiState.skillsPickerIdx];
      if (sel) {
        tuiState.openSkillDetail(sel);
        renderAll();
        return;
      }
      return;
    }
    if (hex === "1b") { // Esc
      tuiState.closeSkillsPicker();
      renderAll();
      return;
    }
    if (hex === "7f" || hex === "08") { // Backspace
      if (tuiState.skillsSearchQuery.length > 0) {
        tuiState.skillsSearchQuery = tuiState.skillsSearchQuery.slice(0, -1);
        const query = tuiState.skillsSearchQuery.toLowerCase();
        tuiState.filteredSkills = tuiState.availableSkills.filter(
          (sk) =>
            sk.id.toLowerCase().includes(query) ||
            sk.name.toLowerCase().includes(query) ||
            sk.description.toLowerCase().includes(query)
        );
        tuiState.skillsPickerIdx = 0;
        renderAll();
      }
      return;
    }
    if (s.length >= 1 && !s.startsWith("\x1b") && s >= " " && s <= "~") {
      tuiState.skillsSearchQuery += s;
      const query = tuiState.skillsSearchQuery.toLowerCase();
      tuiState.filteredSkills = tuiState.availableSkills.filter(
        (sk) =>
          sk.id.toLowerCase().includes(query) ||
          sk.name.toLowerCase().includes(query) ||
          sk.description.toLowerCase().includes(query)
      );
      tuiState.skillsPickerIdx = 0;
      renderAll();
      return;
    }
    return;
  }

  // 3. Key Manager Modal
  if (tuiState.showKeyManager) {
    // 3A. Confirm Delete Mode
    if (tuiState.keyManagerConfirmDelete) {
      if (hex === "79" || hex === "59") { // 'y' / 'Y'
        const prov = tuiState.keyManagerConfirmDelete;
        deleteCliKey(prov);
        tuiState.showToast("Deleted API key for " + prov);
        tuiState.keyManagerConfirmDelete = null;
        renderAll();
        return;
      }
      if (hex === "6e" || hex === "4e" || hex === "1b") { // 'n' / 'N' / Esc
        tuiState.keyManagerConfirmDelete = null;
        renderAll();
        return;
      }
      return;
    }

    // 3B. Inputting API Key Mode
    if (tuiState.keyManagerInput) {
      const input = tuiState.keyManagerInput;
      const cur = input.cursor !== undefined ? input.cursor : input.buffer.length;

      // Esc -> Cancel input
      if (hex === "1b") {
        tuiState.keyManagerInput = null;
        tuiState.setStatus("Enter/A: Set Key │ D: Delete │ ↑↓: Move │ Esc: Close");
        renderAll();
        return;
      }

      // Enter -> Save key
      if (hex === "0d" || hex === "0a") {
        const { provider, buffer } = input;
        const trimmed = buffer.trim();
        if (trimmed) {
          saveCliKey(provider, trimmed);
          syncProviderOnKeySave(provider, trimmed);
          tuiState.showToast("Saved API key for " + provider);
        }
        tuiState.keyManagerInput = null;
        tuiState.setStatus("Enter/A: Set Key │ D: Delete │ ↑↓: Move │ Esc: Close");
        renderAll();
        return;
      }

      // Backspace
      if (hex === "7f" || hex === "08" || s === "\x7f" || s === "\b") {
        if (cur > 0) {
          input.buffer = input.buffer.slice(0, cur - 1) + input.buffer.slice(cur);
          input.cursor = cur - 1;
          renderAll();
        }
        return;
      }

      // Delete key
      if (hex === "1b5b337e" || s === "\x1b[3~") {
        if (cur < input.buffer.length) {
          input.buffer = input.buffer.slice(0, cur) + input.buffer.slice(cur + 1);
          input.cursor = cur;
          renderAll();
        }
        return;
      }

      // Left arrow
      if (hex === "1b5b44" || hex === "1b4f44" || s === "\x1b[D" || s === "\x1bOD") {
        if (cur > 0) {
          input.cursor = cur - 1;
          renderAll();
        }
        return;
      }

      // Right arrow
      if (hex === "1b5b43" || hex === "1b4f43" || s === "\x1b[C" || s === "\x1bOC") {
        if (cur < input.buffer.length) {
          input.cursor = cur + 1;
          renderAll();
        }
        return;
      }

      // Home / Ctrl+A
      if (hex === "1b5b48" || hex === "1b4f48" || hex === "1b5b317e" || hex === "1b5b377e" || hex === "01" || s === "\x01") {
        input.cursor = 0;
        renderAll();
        return;
      }

      // End / Ctrl+E
      if (hex === "1b5b46" || hex === "1b4f46" || hex === "1b5b347e" || hex === "1b5b387e" || hex === "05" || s === "\x05") {
        input.cursor = input.buffer.length;
        renderAll();
        return;
      }

      // Ctrl+U — clear input
      if (hex === "15" || s === "\x15") {
        input.buffer = "";
        input.cursor = 0;
        renderAll();
        return;
      }

      // Ctrl+K — delete to end
      if (hex === "0b" || s === "\x0b") {
        input.buffer = input.buffer.slice(0, cur);
        renderAll();
        return;
      }

      // Ctrl+W — delete word backward
      if (hex === "17" || s === "\x17") {
        if (cur > 0) {
          const before = input.buffer.slice(0, cur);
          const after = input.buffer.slice(cur);
          const trimmed = before.replace(/\S+\s*$/, "");
          input.buffer = trimmed + after;
          input.cursor = trimmed.length;
          renderAll();
        }
        return;
      }

      // Printable text / Unicode / multi-character typing or paste
      if (!s.startsWith("\x1b")) {
        const cleanText = s.replace(/[\r\n\x00-\x1f\x7f]/g, "");
        if (cleanText.length > 0) {
          input.buffer = input.buffer.slice(0, cur) + cleanText + input.buffer.slice(cur);
          input.cursor = cur + cleanText.length;
          renderAll();
        }
        return;
      }

      return;
    }

    // 3C. Normal Key Manager List Navigation
    if (hex === "1b") { // Esc -> Close Key Manager
      tuiState.closeKeyManager();
      renderAll();
      return;
    }

    const providers = getKeyManagerProviders();

    if (hex === "1b5b41" || hex === "1b4f41" || hex === "0b") { // Up
      tuiState.keyManagerIdx = tuiState.keyManagerIdx <= 0 ? Math.max(0, providers.length - 1) : tuiState.keyManagerIdx - 1;
      renderAll();
      return;
    }

    if (hex === "1b5b42" || hex === "1b4f42" || hex === "0e") { // Down
      tuiState.keyManagerIdx = tuiState.keyManagerIdx >= providers.length - 1 ? 0 : tuiState.keyManagerIdx + 1;
      renderAll();
      return;
    }

    if (hex === "0d" || hex === "0a" || hex === "61" || hex === "41") { // Enter or 'a' / 'A'
      const item = providers[tuiState.keyManagerIdx];
      if (item) {
        tuiState.keyManagerInput = { provider: item.id, buffer: "", cursor: 0 };
        tuiState.setStatus("Enter API key for " + item.name + " │ Enter: Save │ Esc: Cancel");
        renderAll();
      }
      return;
    }

    if (hex === "64" || hex === "44") { // 'd' / 'D'
      const item = providers[tuiState.keyManagerIdx];
      if (item && item.isConfigured) {
        tuiState.keyManagerConfirmDelete = item.id;
        renderAll();
      } else if (item) {
        tuiState.showToast("No key configured for " + item.name);
      }
      return;
    }

    return;
  }

  // 3C. Queue Manager Modal
  if (tuiState.showQueueManager) {
    // 3C-1. Editing mode
    if (tuiState.queueManagerEditing) {
      const editing = tuiState.queueManagerEditing;

      if (hex === "1b") { // Esc -> cancel edit
        tuiState.cancelQueueEdit();
        renderAll();
        return;
      }

      if (hex === "0d" || hex === "0a") { // Enter -> save edit
        tuiState.saveQueueEdit(editing.index, editing.buffer);
        renderAll();
        return;
      }

      if (hex === "7f" || hex === "08") { // Backspace
        if (editing.cursor > 0) {
          const chars = Array.from(editing.buffer);
          chars.splice(editing.cursor - 1, 1);
          editing.buffer = chars.join("");
          editing.cursor--;
          renderAll();
        }
        return;
      }

      if (hex === "1b5b337e") { // Delete
        const chars = Array.from(editing.buffer);
        if (editing.cursor < chars.length) {
          chars.splice(editing.cursor, 1);
          editing.buffer = chars.join("");
          renderAll();
        }
        return;
      }

      if (hex === "1b5b44") { // Left
        editing.cursor = Math.max(0, editing.cursor - 1);
        renderAll();
        return;
      }

      if (hex === "1b5b43") { // Right
        editing.cursor = Math.min(editing.buffer.length, editing.cursor + 1);
        renderAll();
        return;
      }

      if (hex === "01" || s === "\x01" || hex === "1b5b48" || hex === "1b4f48") { // Home / Ctrl+A
        editing.cursor = 0;
        renderAll();
        return;
      }

      if (hex === "05" || s === "\x05" || hex === "1b5b46" || hex === "1b4f46") { // End / Ctrl+E
        editing.cursor = editing.buffer.length;
        renderAll();
        return;
      }

      if (s.length >= 1 && !s.startsWith("\x1b") && s >= " ") { // Printable / UTF-8
        const chars = Array.from(editing.buffer);
        chars.splice(editing.cursor, 0, s);
        editing.buffer = chars.join("");
        editing.cursor += Array.from(s).length;
        renderAll();
        return;
      }

      return;
    }

    // 3C-2. Navigation & Actions
    if (hex === "1b") { // Esc -> close
      tuiState.closeQueueManager();
      renderAll();
      return;
    }

    const qSize = messageQueue.size();

    // Up navigation
    if (hex === "1b5b41" || hex === "1b4f41") {
      tuiState.queueManagerIdx =
        tuiState.queueManagerIdx <= 0 ? Math.max(0, qSize - 1) : tuiState.queueManagerIdx - 1;
      renderAll();
      return;
    }

    // Down navigation
    if (hex === "1b5b42" || hex === "1b4f42") {
      tuiState.queueManagerIdx =
        tuiState.queueManagerIdx >= qSize - 1 ? 0 : tuiState.queueManagerIdx + 1;
      renderAll();
      return;
    }

    // Reorder Up: Ctrl+Up, Alt+Up, Shift+Up, u, U, p, P, K
    const isReorderUp =
      hex === "1b5b313b3541" || hex === "1b5b313b3241" || hex === "1b5b313b3341" ||
      s === "u" || s === "U" || s === "p" || s === "P" || s === "K";
    if (isReorderUp) {
      if (qSize > 1 && tuiState.queueManagerIdx > 0) {
        tuiState.reorderQueue(tuiState.queueManagerIdx, tuiState.queueManagerIdx - 1);
        renderAll();
      }
      return;
    }

    // Reorder Down: Ctrl+Down, Alt+Down, Shift+Down, n, N, J
    const isReorderDown =
      hex === "1b5b313b3542" || hex === "1b5b313b3242" || hex === "1b5b313b3342" ||
      s === "n" || s === "N" || s === "J";
    if (isReorderDown) {
      if (qSize > 1 && tuiState.queueManagerIdx < qSize - 1) {
        tuiState.reorderQueue(tuiState.queueManagerIdx, tuiState.queueManagerIdx + 1);
        renderAll();
      }
      return;
    }

    // Enter -> start edit
    if (hex === "0d" || hex === "0a") {
      if (qSize > 0) {
        tuiState.startQueueEdit(tuiState.queueManagerIdx);
        renderAll();
      }
      return;
    }

    // Delete / d / D
    if (hex === "1b5b337e" || s === "d" || s === "D") {
      if (qSize > 0) {
        tuiState.deleteFromQueue(tuiState.queueManagerIdx);
        renderAll();
      }
      return;
    }

    return;
  }

  // 3D. Session Picker Modal
  if (tuiState.showSessionPicker) {
    if (hex === "1b") { // Esc -> close
      tuiState.closeSessionPicker();
      renderAll();
      return;
    }

    const count = tuiState.filteredSessions.length;

    // Up
    if (hex === "1b5b41" || hex === "1b4f41") {
      tuiState.sessionPickerIdx =
        tuiState.sessionPickerIdx <= 0 ? Math.max(0, count - 1) : tuiState.sessionPickerIdx - 1;
      renderAll();
      return;
    }

    // Down
    if (hex === "1b5b42" || hex === "1b4f42") {
      tuiState.sessionPickerIdx =
        tuiState.sessionPickerIdx >= count - 1 ? 0 : tuiState.sessionPickerIdx + 1;
      renderAll();
      return;
    }

    // Enter -> resume
    if (hex === "0d" || hex === "0a") {
      tuiState.resumeSelectedSession();
      renderAll();
      return;
    }

    // Delete / d / D (only if search query is empty or Delete key pressed)
    if (hex === "1b5b337e" || ((s === "d" || s === "D") && !tuiState.sessionSearchQuery)) {
      tuiState.deleteSelectedSession();
      renderAll();
      return;
    }

    // Backspace in search
    if (hex === "7f" || hex === "08") {
      if (tuiState.sessionSearchQuery.length > 0) {
        tuiState.sessionSearchQuery = tuiState.sessionSearchQuery.slice(0, -1);
        tuiState.filterSessions();
        renderAll();
      }
      return;
    }

    // Printable characters for search filter
    if (s.length >= 1 && !s.startsWith("\x1b") && s >= " " && s <= "~") {
      tuiState.sessionSearchQuery += s;
      tuiState.filterSessions();
      renderAll();
      return;
    }

    return;
  }

  // 4. Provider Picker
  if (providerPicker.show) {
    providerPicker.handleKey(hex, {
      renderAll,
      setStatus: (msg: string) => tuiState.setStatus(msg),
      onSelect: (sel) => {
        const hasKey = Boolean(getCliKey(sel));
        if (hasKey) {
          setActiveProvider(sel);
          tuiState.showToast("Active provider switched to " + sel);
          tuiState.setStatus("Active Provider: " + tuiState.providerName + " │ Model: " + (tuiState.currentModel || "none"));
          renderAll();
          return;
        }

        // Provider has no key -> open Set Key modal directly!
        tuiState.keyManagerInput = { provider: sel, buffer: "", cursor: 0 };
        tuiState.showKeyManager = true;
        tuiState.setStatus("Enter API key for " + sel + " │ Enter: Save │ Esc: Cancel");
        tuiState.showToast("Please enter an API key for " + sel);
        renderAll();
      },
    });
    return;
  }

  // 5. Help toggle
  if (tuiState.showHelp && (hex === "1b" || s === "?")) {
    tuiState.showHelp = false;
    renderAll();
    return;
  }

  // 6. Ctrl+C (1st aborts running stream/tool; 2nd exits)
  if (hex === "03") {
    if (tuiState.isStreaming) {
      tuiState.abortController?.abort();
      statusManager.cancel();
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

  // 7. Ctrl+L — clear / redraw
  if (hex === "0c") {
    renderAll();
    return;
  }

  // 8. Slash Command Suggestions Palette (Priority handler when palette is OPEN)
  const suggests = getSuggestions(inputBufferManager.getText());
  if (suggests.length > 0) {
    // 8A. Up Arrow — navigate up in palette
    if (hex === "1b5b41" || hex === "1b4f41") {
      tuiState.cmdSuggestIdx = tuiState.cmdSuggestIdx <= 0 ? suggests.length - 1 : tuiState.cmdSuggestIdx - 1;
      renderAll();
      return;
    }

    // 8B. Down Arrow — navigate down in palette
    if (hex === "1b5b42" || hex === "1b4f42") {
      tuiState.cmdSuggestIdx = tuiState.cmdSuggestIdx >= suggests.length - 1 ? 0 : tuiState.cmdSuggestIdx + 1;
      renderAll();
      return;
    }

    // 8C. Tab — autocomplete highlighted command into input without executing
    if (hex === "09") {
      const safeIdx = Math.max(0, Math.min(tuiState.cmdSuggestIdx, suggests.length - 1));
      const selected = suggests[safeIdx]?.name;
      if (selected) {
        inputBufferManager.setText(selected + " ");
        tuiState.inputBuffer = inputBufferManager.getText();
        tuiState.cursorPos = inputBufferManager.getCursor();
        tuiState.cmdSuggestIdx = 0;
        renderAll();
      }
      return;
    }

    // 8D. Enter — execute highlighted command directly without submitting raw input
    if (hex === "0d" || hex === "0a" || s === "\r" || s === "\n") {
      const safeIdx = Math.max(0, Math.min(tuiState.cmdSuggestIdx, suggests.length - 1));
      const selected = suggests[safeIdx]?.name;
      if (selected) {
        inputBufferManager.clear();
        tuiState.inputBuffer = "";
        tuiState.cursorPos = 0;
        tuiState.cmdSuggestIdx = 0;
        tuiState.setStatus("");
        renderAll();
        sendMessage(selected);
        return;
      }
    }

    // 8E. Escape — close palette and clear slash input
    if (hex === "1b") {
      inputBufferManager.clear();
      tuiState.inputBuffer = "";
      tuiState.cursorPos = 0;
      tuiState.cmdSuggestIdx = 0;
      tuiState.setStatus("");
      renderAll();
      return;
    }
  }

  // 9. Esc — close popups or cancel stream, never exit
  if (hex === "1b") {
    if (tuiState.showHelp) { tuiState.showHelp = false; renderAll(); return; }
    if (tuiState.showModelPicker) { tuiState.showModelPicker = false; renderAll(); return; }
    if (tuiState.showSkillsPicker) { tuiState.closeSkillsPicker(); renderAll(); return; }
    if (tuiState.showQueueManager) { tuiState.closeQueueManager(); renderAll(); return; }
    if (tuiState.showSessionPicker) { tuiState.closeSessionPicker(); renderAll(); return; }
    if (providerPicker.show) { providerPicker.show = false; renderAll(); return; }
    if (tuiState.isStreaming) {
      tuiState.abortController?.abort();
      statusManager.cancel();
      renderAll();
    }
    return;
  }

  // 10. Ctrl+N — model picker
  if (s === "\x0e") {
    openModelPicker();
    return;
  }

  // 11. Tab — toggle mode (if not autocompleting)
  if (hex === "09") {
    tuiState.agentMode = tuiState.agentMode === "Build" ? "Plan" : "Build";
    tuiState.setStatus("Mode: " + tuiState.agentMode);
    renderAll();
    return;
  }

  // 12. ? — help toggle when empty input
  if (s === "?" && inputBufferManager.getText() === "") {
    tuiState.showHelp = !tuiState.showHelp;
    renderAll();
    return;
  }

  // 13. Page Up / Page Down — scrolling
  if (hex === "1b5b357e") { tuiState.scrollOffset += 5; renderAll(); return; } // PgUp
  if (hex === "1b5b367e") { tuiState.scrollOffset = Math.max(0, tuiState.scrollOffset - 5); renderAll(); return; } // PgDn

  // 14. Shift+Enter / Alt+Enter / Ctrl+J — Insert newline in input
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

  // 15. Up / Down arrow navigation
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

  // 16. Left / Right cursor movement
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

  // 17. Enter — submit prompt or enqueue if working
  if (hex === "0d") {
    const text = inputBufferManager.getText().trim();
    if (!text) return;

    inputBufferManager.clear();
    tuiState.inputBuffer = "";
    tuiState.cursorPos = 0;
    tuiState.cmdSuggestIdx = 0;

    // Slash command -> run immediately
    if (text.startsWith("/")) {
      tuiState.setStatus("");
      renderAll();
      sendMessage(text);
      return;
    }

    tuiState.pushPromptHistory(text);

    // If agent is currently working/streaming or processing -> enqueue into message queue
    if (tuiState.isStreaming || messageQueue.getIsProcessing()) {
      const queued = messageQueue.enqueue(text);
      tuiState.saveCurrentSession();
      if (queued) {
        tuiState.showToast(`Queued (${messageQueue.size()} in queue)`);
      }
      renderAll();
      return;
    }

    // Agent is idle -> execute immediately
    tuiState.setStatus("");
    renderAll();
    sendMessage(text);
    return;
  }

  // 18. Backspace
  if (hex === "7f" || hex === "08") {
    if (inputBufferManager.deleteBackward()) {
      tuiState.inputBuffer = inputBufferManager.getText();
      tuiState.cursorPos = inputBufferManager.getCursor();
      tuiState.cmdSuggestIdx = 0;
      renderAll();
    }
    return;
  }

  // 19. Delete key
  if (hex === "1b5b337e") {
    if (inputBufferManager.deleteForward()) {
      tuiState.inputBuffer = inputBufferManager.getText();
      tuiState.cursorPos = inputBufferManager.getCursor();
      tuiState.cmdSuggestIdx = 0;
      renderAll();
    }
    return;
  }

  // 20. Line Navigation & Editing shortcuts
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

  // 21. Printable characters & Multi-byte UTF-8
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
