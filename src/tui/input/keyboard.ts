import { store } from "../store";

// Callback interfaces so the keyboard module doesn't depend directly on the main file
export interface KeyboardCallbacks {
  renderAll: () => void;
  setStatus: (msg: string) => void;
  sendMessage: (text: string) => void;
  exitApp: () => void;
  openModelPicker: () => void;
  updateModelSearch: () => void;
  stopSpinner: () => void;
  providerPickerHandleKey?: (hex: string, opts: any) => void;
}

export function handleKey(data: Buffer, cb: KeyboardCallbacks) {
  const s = data.toString("utf8");
  const hex = data.toString("hex");

  // Model picker navigation
  if (store.showModelPicker) {
    if (hex === "1b5b41" || hex === "1b4f41") { // Up
      store.modelPickerIdx = store.modelPickerIdx <= 0 ? store.filteredModels.length - 1 : store.modelPickerIdx - 1;
      cb.renderAll();
    } else if (hex === "1b5b42" || hex === "1b4f42") { // Down
      store.modelPickerIdx = store.modelPickerIdx >= store.filteredModels.length - 1 ? 0 : store.modelPickerIdx + 1;
      cb.renderAll();
    } else if (hex === "0d" || hex === "0a") { // Enter
      const sel = store.filteredModels[store.modelPickerIdx];
      if (sel && !sel.includes("No models") && !sel.includes("Gateway offline") && !sel.includes("Error") && !sel.includes("No matches")) {
        store.currentModel = sel;
        cb.setStatus("Model: " + store.currentModel);
      }
      store.showModelPicker = false;
      cb.renderAll();
    } else if (hex === "1b") { // Esc
      store.showModelPicker = false;
      cb.setStatus("");
      cb.renderAll();
    } else if (hex === "7f" || hex === "08") { // Backspace
      if (store.modelSearchQuery.length > 0) {
        store.modelSearchQuery = store.modelSearchQuery.slice(0, -1);
        cb.updateModelSearch();
      }
    } else if (s.length === 1 && s >= " " && s <= "~") { // Printable
      store.modelSearchQuery += s;
      cb.updateModelSearch();
    }
    return;
  }

  // Help toggle
  if (store.showHelp && (hex === "1b" || s === "?")) {
    store.showHelp = false;
    cb.renderAll();
    return;
  }

  // Ctrl+C
  if (hex === "03") {
    if (store.isStreaming) {
      store.abortController?.abort();
      cb.stopSpinner();
      cb.setStatus("Cancelled");
      cb.renderAll();
      return;
    }
    store.ctrlCCount++;
    if (store.ctrlCCount >= 2) {
      cb.exitApp();
    } else {
      cb.setStatus("Press Ctrl+C again to exit  (or type /exit)");
      cb.renderAll();
      if (store.ctrlCTimer) clearTimeout(store.ctrlCTimer);
      store.ctrlCTimer = setTimeout(() => { store.ctrlCCount = 0; cb.setStatus(""); cb.renderAll(); }, 2000);
    }
    return;
  }

  // Esc — close popups or cancel stream, NEVER exit
  if (hex === "1b") {
    if (store.showHelp) { store.showHelp = false; cb.renderAll(); return; }
    if (store.showModelPicker) { store.showModelPicker = false; cb.renderAll(); return; }
    if (store.isStreaming) {
      store.abortController?.abort();
      cb.stopSpinner();
      cb.setStatus("Cancelled");
      cb.renderAll();
    }
    return;
  }

  // Ctrl+K / Ctrl+M — model picker
  if (s === "\x0b") { cb.openModelPicker(); return; } // Ctrl+K
  if (s === "\x0e") { cb.openModelPicker(); return; } // Ctrl+N alternate

  // Tab — toggle mode (only if not autocompleting)
  if (hex === "09") {
    store.agentMode = store.agentMode === "Build" ? "Plan" : "Build";
    cb.setStatus("Mode: " + store.agentMode);
    cb.renderAll();
    return;
  }

  // ? — help
  if (s === "?" && store.inputBuffer === "") {
    store.showHelp = !store.showHelp;
    cb.renderAll();
    return;
  }

  // Page Up/Down — scroll
  if (hex === "1b5b357e") { store.scrollOffset += 5; cb.renderAll(); return; } // PgUp
  if (hex === "1b5b367e") { store.scrollOffset = Math.max(0, store.scrollOffset - 5); cb.renderAll(); return; } // PgDn
  if (hex === "1b5b41") { store.scrollOffset++; cb.renderAll(); return; } // Up arrow (scroll)
  if (hex === "1b5b42") { store.scrollOffset = Math.max(0, store.scrollOffset - 1); cb.renderAll(); return; } // Down arrow

  // Enter — send message
  if (hex === "0d" || hex === "0a") {
    if (store.isStreaming) return;
    const text = store.inputBuffer;
    store.inputBuffer = "";
    store.cursorPos = 0;
    store.cmdSuggestIdx = 0;
    cb.setStatus("");
    cb.renderAll();
    if (text.trim()) cb.sendMessage(text);
    return;
  }

  // Backspace
  if (hex === "7f" || hex === "08") {
    const chars = Array.from(store.inputBuffer);
    if (store.cursorPos > 0) {
      // Find the character index mapping to the current cursorPos
      // For simplicity, we assume cursorPos is the Unicode character index now
      // This requires updating how we increment/decrement cursorPos
      // But if we just treat cursorPos as character count:
      chars.splice(store.cursorPos - 1, 1);
      store.inputBuffer = chars.join('');
      store.cursorPos--;
      store.cmdSuggestIdx = 0;
      cb.renderAll();
    }
    return;
  }

  // Delete key
  if (hex === "1b5b337e") {
    const chars = Array.from(store.inputBuffer);
    if (store.cursorPos < chars.length) {
      chars.splice(store.cursorPos, 1);
      store.inputBuffer = chars.join('');
      store.cmdSuggestIdx = 0;
      cb.renderAll();
    }
    return;
  }

  // Left/Right arrows in input
  const chars = Array.from(store.inputBuffer);
  if (hex === "1b5b44") { store.cursorPos = Math.max(0, store.cursorPos - 1); cb.renderAll(); return; }
  if (hex === "1b5b43") { store.cursorPos = Math.min(chars.length, store.cursorPos + 1); cb.renderAll(); return; }
  if (hex === "1b5b48" || hex === "1b4f48") { store.cursorPos = 0; cb.renderAll(); return; } // Home
  if (hex === "1b5b46" || hex === "1b4f46") { store.cursorPos = chars.length; cb.renderAll(); return; } // End

  // Ctrl+U — clear line
  if (hex === "15") { store.inputBuffer = ""; store.cursorPos = 0; cb.renderAll(); return; }

  // Ctrl+W — delete word back
  if (hex === "17") {
    const before = chars.slice(0, store.cursorPos).join("");
    const after = chars.slice(store.cursorPos).join("");
    const trimmed = before.replace(/\S+\s*$/, "");
    store.inputBuffer = trimmed + after;
    store.cursorPos = Array.from(trimmed).length;
    store.cmdSuggestIdx = 0;
    cb.renderAll();
    return;
  }

  // Shift+Enter / Ctrl+J — newline in input
  if (hex === "0a" || (s.length === 1 && s.charCodeAt(0) === 10)) {
    chars.splice(store.cursorPos, 0, "\n");
    store.inputBuffer = chars.join("");
    store.cursorPos++;
    cb.renderAll();
    return;
  }

  // Printable characters
  if (s.length === 1 && s.charCodeAt(0) >= 32) {
    chars.splice(store.cursorPos, 0, s);
    store.inputBuffer = chars.join("");
    store.cursorPos++;
    store.cmdSuggestIdx = 0;
    cb.renderAll();
    return;
  }

  // Multi-byte UTF-8
  if (data.length > 1 && !s.startsWith("\x1b")) {
    const newChars = Array.from(s);
    chars.splice(store.cursorPos, 0, ...newChars);
    store.inputBuffer = chars.join("");
    store.cursorPos += newChars.length;
    store.cmdSuggestIdx = 0;
    cb.renderAll();
    return;
  }
}
