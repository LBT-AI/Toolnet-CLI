import { A, T } from "../../term";
import { stripAnsi, truncate } from "../layout";
import type { QueuedMessage } from "../../lib/messageQueue";

export interface QueueManagerModalState {
  queue: QueuedMessage[];
  queueIdx: number;
  editing: { index: number; buffer: string; cursor: number } | null;
}

/**
 * Renders the interactive /queue Manager Modal popup.
 */
export function renderQueueManagerBox(
  cols: number,
  rows: number,
  state: QueueManagerModalState
): string {
  const { queue, queueIdx, editing } = state;
  const boxW = Math.min(80, Math.max(50, cols - 6));
  const boxH = Math.min(20, Math.max(10, rows - 4));
  const startCol = Math.max(1, Math.floor((cols - boxW) / 2));
  const startRow = Math.max(2, Math.floor((rows - boxH) / 2));

  const out: string[] = [];
  let curRow = startRow;

  const pushLine = (content: string) => {
    out.push(T.goto(curRow++, startCol));
    const stripped = stripAnsi(content);
    const pad = Math.max(0, boxW - 2 - stripped.length);
    out.push(
      A.fgBorder + "│" + A.reset +
      content +
      " ".repeat(pad) +
      A.fgBorder + "│" + A.reset
    );
  };

  // Header Title
  const countLabel = queue.length > 0 ? ` (${queue.length} tasks)` : " (empty)";
  const titleText = ` Queue${countLabel} `;
  const titleBarLen = Math.max(0, boxW - 4 - stripAnsi(titleText).length);
  const topBorder =
    A.fgBorder + "┌─" + A.bold + A.fgCyan + titleText + A.reset + A.fgBorder + "─".repeat(titleBarLen) + "┐" + A.reset;
  out.push(T.goto(curRow++, startCol) + topBorder);

  // Edit mode vs List mode
  if (editing) {
    pushLine(` ${A.bold}${A.fgYellow}Editing Task #${editing.index + 1}:${A.reset}`);
    pushLine("");

    const maxInputLen = boxW - 6;
    const buf = editing.buffer;
    const cur = editing.cursor;
    const before = buf.slice(0, cur);
    const atCursor = buf[cur] || " ";
    const after = buf.slice(cur + 1);

    const fullVisual = before + `\x1b[7m${atCursor}\x1b[27m` + after;
    pushLine(`  ${A.fgCyan}>${A.reset} ${truncate(fullVisual, maxInputLen + 10)}`);
    pushLine("");

    const remainingRows = startRow + boxH - 2 - curRow;
    for (let i = 0; i < remainingRows; i++) {
      pushLine("");
    }

    const editFooter = " Enter Save │ Esc Cancel edit ";
    const botBarLen = Math.max(0, boxW - 2 - stripAnsi(editFooter).length);
    const bottomBorder =
      A.fgBorder + "└" + A.fgSubtext + editFooter + A.fgBorder + "─".repeat(botBarLen) + "┘" + A.reset;
    out.push(T.goto(curRow, startCol) + bottomBorder);
    return out.join("");
  }

  // Subheader / instructions
  const subheader = queue.length > 0
    ? ` ${A.fgSubtext}Queued tasks (executed in FIFO order):${A.reset}`
    : ` ${A.fgMuted}No queued messages. Type during active task to enqueue.${A.reset}`;
  pushLine(subheader);

  // Divider
  out.push(T.goto(curRow++, startCol));
  out.push(A.fgBorder + "├" + "─".repeat(boxW - 2) + "┤" + A.reset);

  const listRows = Math.max(1, startRow + boxH - 2 - curRow);

  if (queue.length === 0) {
    pushLine(`   ${A.fgMuted}(Queue is currently empty)${A.reset}`);
    for (let i = 1; i < listRows; i++) pushLine("");
  } else {
    // Windowed scrolling for queue list
    const visibleCount = listRows;
    let viewStart = 0;
    if (queueIdx >= visibleCount) {
      viewStart = queueIdx - visibleCount + 1;
    }
    const viewEnd = Math.min(queue.length, viewStart + visibleCount);

    for (let i = viewStart; i < viewEnd; i++) {
      const isSel = i === queueIdx;
      const q = queue[i];
      const bullet = isSel ? `${A.fgGreen}●${A.reset}` : ` `;
      const idxStr = `${A.fgSubtext}${i + 1}.${A.reset}`;
      const prefix = ` ${bullet} ${idxStr} `;
      const maxTextLen = boxW - 12;
      const textTrunc = truncate(q.text.replace(/\r?\n/g, " ↵ "), maxTextLen);
      const textStyled = isSel
        ? `${A.bold}${A.fgText}${textTrunc}${A.reset}`
        : `${A.fgSubtext}${textTrunc}${A.reset}`;

      pushLine(`${prefix}${textStyled}`);
    }

    const rendered = viewEnd - viewStart;
    for (let i = rendered; i < listRows; i++) {
      pushLine("");
    }
  }

  // Footer bar with shortcuts
  const footerText = " ↑↓ Navigate │ Enter Edit │ D Delete │ Ctrl+↑/↓ Reorder │ Esc Close ";
  const botBarLen = Math.max(0, boxW - 2 - stripAnsi(footerText).length);
  const bottomBorder =
    A.fgBorder + "└" + A.fgSubtext + footerText + A.fgBorder + "─".repeat(botBarLen) + "┘" + A.reset;
  out.push(T.goto(curRow, startCol) + bottomBorder);

  return out.join("");
}
