import { A } from "../../term";
import { runOutputWindow, type RunOutputViewerState } from "../state";
import { composeBox } from "./composeBox";

/**
 * Body rows `composeBox` will actually show at this height. The pager must use
 * the SAME number when it computes its window, or the "(x-y of N)" label and
 * the scroll step would disagree with what is on screen.
 */
export function runOutputViewerPageSize(rows: number): number {
  const maxViewport = Math.max(3, rows - 5);
  return Math.max(1, maxViewport - 3);
}

/**
 * Full-screen pager for a command's captured output.
 *
 * Design mirrors the other overlays (queue/session pickers) so it composites
 * identically over the main frame and never reflows the chat viewport. The
 * command's raw text is the source of truth; this only windows it.
 */
export function renderRunOutputViewerBox(
  cols: number,
  rows: number,
  viewer: RunOutputViewerState
): string[] {
  const pageSize = runOutputViewerPageSize(rows);
  const { start, end } = runOutputWindow(viewer, pageSize);

  const body: string[] = [];
  for (let i = start; i < end; i++) {
    const line = viewer.lines[i] ?? "";
    // Line numbers make a long log scannable; muted so they never compete
    // with content. Truncation is left to composeBox (cell-aware).
    body.push(A.fgMuted + String(i + 1).padStart(4) + A.reset + " " + line);
  }
  if (body.length === 0) {
    body.push(A.fgSubtext + "(no output)" + A.reset);
  }

  const total = viewer.lines.length;
  const range = total > 0 ? `${start + 1}-${end} of ${total}` : "0 of 0";
  const follow = viewer.running
    ? viewer.followTail
      ? " · following"
      : " · paused"
    : "";
  const footer = `(${range} lines${follow})  ↑↓ scroll · ⇞⇟ page · esc back`;

  return composeBox(cols, rows, {
    title: viewer.title,
    body,
    footer,
  });
}
