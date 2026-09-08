import { A } from "../../term";
import { stripAnsi, truncate } from "../layout";
import type { QueuedMessage } from "../../lib/messageQueue";
import { composeBox, computeBoxGeometry } from "./composeBox";

export interface QueueManagerModalState {
  queue: QueuedMessage[];
  queueIdx: number;
  editing: { index: number; buffer: string; cursor: number } | null;
}

const MAX_DISPLAY = 10;

export function renderQueueManagerBox(
  cols: number,
  rows: number,
  state: QueueManagerModalState
): string {
  const { queue, queueIdx, editing } = state;
  const isNarrow = cols < 60;
  const { boxW } = computeBoxGeometry(cols, rows, Math.min(queue.length, MAX_DISPLAY) + 2, true, isNarrow ? 46 : 58);
  const maxTextLen = Math.max(12, boxW - 14);

  const body: string[] = [];

  if (editing) {
    body.push(A.fgYellow + A.bold + "Editing task #" + (editing.index + 1) + A.reset);
    body.push("");
    const buf = editing.buffer;
    const cur = editing.cursor;
    const before = buf.slice(0, cur);
    const at = buf[cur] || " ";
    const after = buf.slice(cur + 1);
    const full = before + `\x1b[7m${at}\x1b[27m` + after;
    body.push(A.fgCyan + "> " + A.reset + truncate(full, maxTextLen + 10));
    body.push("");
    return composeBox(cols, rows, {
      title: "Edit queued task",
      body,
      footer: "enter save · esc cancel",
    }).join("");
  }

  if (queue.length === 0) {
    body.push(A.fgSubtext + "No queued messages." + A.reset);
    body.push(A.fgMuted + "Type during an active task to enqueue." + A.reset);
    return composeBox(cols, rows, {
      title: `Queue (empty)`,
      body,
      footer: "esc close",
    }).join("");
  }

  const title = `Queue (${queue.length} task${queue.length === 1 ? "" : "s"})`;

  const visibleCount = Math.min(MAX_DISPLAY, queue.length);
  let viewStart = 0;
  if (queueIdx >= visibleCount) viewStart = queueIdx - visibleCount + 1;
  viewStart = Math.max(0, Math.min(viewStart, queue.length - visibleCount));

  for (let i = viewStart; i < viewStart + visibleCount; i++) {
    const q = queue[i];
    const isSel = i === queueIdx;
    const prefix = ` ${isSel ? A.fgGreen + "●" + A.reset : " "} ${A.fgSubtext}${i + 1}.${A.reset} `;
    const textTrunc = truncate(q.text.replace(/\r?\n/g, " ↵ "), maxTextLen);
    const textStyled = isSel
      ? A.bold + A.fgText + textTrunc + A.reset
      : A.fgSubtext + textTrunc + A.reset;
    if (isSel) {
      body.push(A.bgOverlay + prefix + A.bgOverlay + textStyled + A.reset);
    } else {
      body.push(prefix + textStyled);
    }
  }

  if (queue.length > MAX_DISPLAY) {
    body.push(A.fgMuted + "… and " + (queue.length - MAX_DISPLAY) + " more" + A.reset);
  }

  return composeBox(cols, rows, {
    title,
    body,
    footer: "↑↓ navigate · enter edit · d delete · esc close",
  }).join("");
}