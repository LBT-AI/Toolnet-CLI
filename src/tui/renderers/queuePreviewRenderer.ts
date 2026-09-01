import { A, T } from "../../term";
import { stripAnsi, truncate } from "../layout";
import type { QueuedMessage } from "../../lib/messageQueue";

/**
 * Renders a dimmed/muted preview of queued messages above the input bar.
 */
export function renderQueuedMessagesPreview(
  cols: number,
  queued: QueuedMessage[]
): string {
  if (queued.length === 0) return "";

  const lines: string[] = [];
  const count = queued.length;
  const countLabel = count === 1 ? "1 queued message" : `${count} queued messages`;

  // Header line: e.g. "2 queued messages"
  const headerText = ` ${A.dim}${A.fgSubtext}${countLabel}:${A.reset}`;
  const headerPad = Math.max(0, cols - stripAnsi(headerText).length);
  lines.push(T.clearLine + headerText + " ".repeat(headerPad) + "\r\n");

  // Show up to 3 preview tasks
  const previewCount = Math.min(3, count);
  for (let i = 0; i < previewCount; i++) {
    const item = queued[i];
    const maxTextLen = Math.max(10, cols - 8);
    const cleanText = truncate(item.text.replace(/\r?\n/g, " ↵ "), maxTextLen);
    const previewLine = `   ${A.dim}${A.fgMuted}› ${cleanText}${A.reset}`;
    const pad = Math.max(0, cols - stripAnsi(previewLine).length);
    lines.push(T.clearLine + previewLine + " ".repeat(pad) + "\r\n");
  }

  // If more than 3, show "+X more"
  if (count > 3) {
    const moreText = `   ${A.dim}${A.fgMuted}+${count - 3} more (type /queue to view all)${A.reset}`;
    const pad = Math.max(0, cols - stripAnsi(moreText).length);
    lines.push(T.clearLine + moreText + " ".repeat(pad) + "\r\n");
  }

  return lines.join("");
}
