import fs from "node:fs";
import path from "node:path";

interface HistoryEntry {
  filePath: string;
  before: string | null;
  after: string | null;
  timestamp: number;
  description: string;
}

const MAX_HISTORY = 100;
const history: HistoryEntry[] = [];
let historyIndex = -1;

let _onChange: (() => void) | null = null;

export function onHistoryChange(fn: () => void) {
  _onChange = fn;
}

function notify() {
  if (_onChange) _onChange();
}

export function pushSnapshot(filePath: string, description: string): void {
  const absPath = path.resolve(filePath);
  let before: string | null = null;
  try {
    if (fs.existsSync(absPath)) {
      before = fs.readFileSync(absPath, "utf8");
    }
  } catch {}

  if (historyIndex < history.length - 1) {
    history.length = historyIndex + 1;
  }

  history.push({ filePath: absPath, before, after: null, timestamp: Date.now(), description });
  if (history.length > MAX_HISTORY) history.shift();
  historyIndex = history.length - 1;
}

export function commitSnapshot(filePath: string): void {
  const absPath = path.resolve(filePath);
  if (historyIndex >= 0 && historyIndex < history.length) {
    const entry = history[historyIndex];
    if (entry.filePath === absPath) {
      try {
        if (fs.existsSync(absPath)) {
          entry.after = fs.readFileSync(absPath, "utf8");
        } else {
          entry.after = null;
        }
      } catch {
        entry.after = null;
      }
      notify();
    }
  }
}

export function undo(): { success: boolean; error?: string; entry?: HistoryEntry } {
  if (historyIndex < 0 || history.length === 0) {
    return { success: false, error: "Nothing to undo" };
  }

  const entry = history[historyIndex];
  try {
    if (entry.before !== null) {
      fs.writeFileSync(entry.filePath, entry.before, "utf8");
    } else if (fs.existsSync(entry.filePath)) {
      fs.unlinkSync(entry.filePath);
    }
    historyIndex--;
    notify();
    return { success: true, entry };
  } catch (err: unknown) {
    return { success: false, error: `Undo error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function redo(): { success: boolean; error?: string; entry?: HistoryEntry } {
  if (historyIndex >= history.length - 1) {
    return { success: false, error: "Nothing to redo" };
  }

  const entry = history[historyIndex + 1];
  try {
    if (entry.after !== null) {
      fs.writeFileSync(entry.filePath, entry.after, "utf8");
    } else if (fs.existsSync(entry.filePath)) {
      fs.unlinkSync(entry.filePath);
    }
    historyIndex++;
    notify();
    return { success: true, entry };
  } catch (err: unknown) {
    return { success: false, error: `Redo error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function canUndo(): boolean {
  return historyIndex >= 0 && history.length > 0;
}

export function canRedo(): boolean {
  return historyIndex < history.length - 1;
}

export function getUndoDescription(): string {
  if (canUndo()) return history[historyIndex].description;
  return "";
}

export function getRedoDescription(): string {
  if (canRedo()) return history[historyIndex + 1].description;
  return "";
}

export function getHistoryStats(): string {
  return `${history.length} changes, ${historyIndex + 1} current, ${canUndo() ? "can undo" : "at start"}, ${canRedo() ? "can redo" : "at end"}`;
}
