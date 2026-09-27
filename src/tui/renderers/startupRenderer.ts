import { A } from "../../term";
import { truncate, visibleWidth } from "../layout";

export interface StartupState {
  /** Active model id, if any. */
  model?: string;
  /** Workspace path shown as context. */
  workspace?: string;
}

/**
 * Startup empty state — a short, bright welcome shown ONLY while the transcript
 * is empty. It is pure chrome: it is never appended to `messages`, never saved
 * to the session, and disappears on the first real turn. Kept to a handful of
 * rows so it stays legible on a 52x20 phone terminal.
 */
export function renderStartupEmptyState(cols: number, state: StartupState = {}): string[] {
  const inner = Math.max(20, cols - 4);
  const out: string[] = [];

  out.push("");
  out.push("  " + A.fgAccent + A.bold + "✦ ToolNet" + A.reset + A.fgMuted + "  coding agent" + A.reset);

  const model = state.model && !/^(none|default|not selected)$/i.test(state.model) ? state.model : "no model selected";
  const ws = state.workspace || "";
  out.push(
    "  " + A.fgViolet + "model" + A.reset + A.fgMuted + " " + truncate(model, Math.max(8, inner - 8)) + A.reset,
  );
  if (ws) {
    out.push("  " + A.fgCyan + "cwd  " + A.reset + A.fgSubtext + truncate(ws, Math.max(8, inner - 6)) + A.reset);
  }

  out.push("");
  out.push("  " + A.fgText + "Describe a task and I'll read, edit and run it." + A.reset);
  out.push("  " + A.fgMuted + "/ for commands   ·   Tab switches Build/Plan" + A.reset);
  out.push("");
  out.push(A.fgBorder + "  " + "─".repeat(Math.max(4, cols - 4)) + A.reset);

  // Guard: never paint a row wider than the chat column.
  return out.map((line) => (visibleWidth(line) > cols ? truncate(line, cols) : line));
}
