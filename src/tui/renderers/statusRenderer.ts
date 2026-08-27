import { A, T } from "../../term";
import { stripAnsi, truncate } from "../layout";
import { getCwdInfo } from "../../lib/codingAgent";
import { SPINNER } from "../state";

export function renderStatusBar(
  cols: number,
  state: {
    showHelp: boolean;
    isStreaming: boolean;
    spinnerIdx: number;
    statusText: string;
    elapsedDisplay: string;
    primaryColor: string;
  }
): string {
  let statusContent: string;
  if (state.showHelp) {
    statusContent = A.fgYellow + " Shortcuts: Tab (mode), Ctrl+K (models), Esc (cancel), / (commands)" + A.reset;
  } else if (state.isStreaming) {
    const spinner = A.fgYellow + A.bold + SPINNER[state.spinnerIdx] + A.reset;
    statusContent = spinner + " " + A.fgYellow + state.statusText + A.reset + A.fgSubtext + state.elapsedDisplay + A.reset;
  } else if (state.statusText) {
    const isErr = state.statusText.startsWith("Error") || state.statusText.startsWith("✖");
    const fg = isErr ? A.fgRed : state.statusText.startsWith("✔") ? A.fgGreen : state.primaryColor;
    statusContent = fg + A.bold + state.statusText + A.reset + A.fgSubtext + state.elapsedDisplay + A.reset;
  } else {
    statusContent = A.fgGreen + A.bold + "● Ready" + A.reset + A.fgSubtext + " │ Enter:send Shift+Enter:newline Tab:mode" + A.reset;
  }

  const { workspaceRoot, workspaceRoots, bypassPolicy } = getCwdInfo();
  const accessColor = bypassPolicy ? A.fgRed : A.fgCyan;
  const accessStr = bypassPolicy ? "System" : "Workspace";
  const rootCountStr = workspaceRoots && workspaceRoots.length > 1 ? ` (+${workspaceRoots.length - 1} roots)` : "";
  const cwdDisplay = ` [Workspace: ${truncate(workspaceRoot, 25)}${rootCountStr} | Access: ${accessColor}${accessStr}${A.fgSubtext}]`;

  const statusStripped = stripAnsi(statusContent);
  const rightStripped = stripAnsi(cwdDisplay);
  const statusPad = Math.max(0, cols - statusStripped.length - rightStripped.length);

  return A.bgSurface + statusContent + " ".repeat(statusPad) + A.fgSubtext + cwdDisplay + A.reset;
}

export function renderInputArea(
  cols: number,
  inputBuffer: string,
  primaryColor: string
): string {
  const isTyping = inputBuffer.length > 0;
  const borderCol = isTyping ? primaryColor : A.fgSubtext + A.dim;
  const borderLine = borderCol + "─".repeat(cols) + A.reset + "\r\n";

  const prompt = isTyping ? primaryColor + A.bold + " ❯ " + A.reset : A.fgSubtext + A.bold + " ❯ " + A.reset;
  const promptWidth = 3;

  // Single or multiline display for input bar
  const firstLine = inputBuffer.includes("\n") ? inputBuffer.split("\n")[0] + " ↵" : inputBuffer;
  const inputVisible = firstLine.length > cols - promptWidth - 4
    ? "…" + firstLine.slice(-(cols - promptWidth - 5))
    : firstLine;

  const placeholder = inputBuffer === ""
    ? A.fgSubtext + A.dim + "Ask anything... (/help for commands, Shift+Enter for newline)" + A.reset
    : A.fgText + inputVisible + A.reset;

  const inputLine = T.clearLine + prompt + placeholder + A.reset + "\r\n";
  return borderLine + inputLine;
}
