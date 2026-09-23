/**
 * Conversation viewport scroll model — follow-tail + stable message anchors.
 *
 * `topRow` is the first visible content row while detached and 0 while pinned to
 * the tail. Layout is measured once per frame; callers render, resolve, then
 * paint. Stream, tool-progress, timer, and resize renders reuse the same
 * message-ID anchor instead of assuming that a numeric row still names the same
 * message.
 */

export type LineMessageIds = readonly (string | null)[];

export interface ChatViewportState {
  /** First visible content row while detached; 0 while pinned to the tail. */
  topRow: number;
  /** Sticky-tail: keep the newest content in view while it streams. */
  followTail: boolean;
  /** Total content rows observed at the last resolve (diagnostics/tests). */
  lastContentHeight: number;
  /** Transcript message visible at the user's anchor row, when available. */
  anchorMessageId: string | null;
  /** Zero-based row within anchorMessageId preserved across rewraps. */
  anchorRowOffset: number;
}

/** Distance (rows) from the bottom within which the tail still counts as visible. */
export const TAIL_EPSILON = 2;

export function createChatViewport(): ChatViewportState {
  return {
    topRow: 0,
    followTail: true,
    lastContentHeight: 0,
    anchorMessageId: null,
    anchorRowOffset: 0,
  };
}

/**
 * Should the viewport stick to the tail for the incoming chunk?
 * True when the user is at — or within TAIL_EPSILON rows of — the bottom.
 */
export function shouldFollowTail(
  viewport: ChatViewportState,
  totalRows: number,
  viewportRows: number,
): boolean {
  const bottom = viewport.topRow + viewportRows;
  return totalRows - bottom <= TAIL_EPSILON;
}

function firstVisibleRow(viewport: ChatViewportState, totalRows: number, viewportRows: number): number {
  const maxTop = Math.max(0, totalRows - viewportRows);
  if (viewport.followTail) return maxTop;
  return Math.max(0, Math.min(viewport.topRow, maxTop));
}

function findFirst(lines: LineMessageIds | undefined, messageId: string): number {
  if (!lines) return -1;
  return lines.findIndex((id) => id === messageId);
}

function findLast(lines: LineMessageIds | undefined, messageId: string): number {
  if (!lines) return -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === messageId) last = i;
  }
  return last;
}

function captureAnchor(
  viewport: ChatViewportState,
  row: number,
  lineMessageIds: LineMessageIds | undefined,
): void {
  const messageId = lineMessageIds?.[row] ?? null;
  if (!messageId) {
    viewport.anchorMessageId = null;
    viewport.anchorRowOffset = 0;
    viewport.topRow = row;
    return;
  }

  const first = findFirst(lineMessageIds, messageId);
  viewport.anchorMessageId = messageId;
  viewport.anchorRowOffset = Math.max(0, row - first);
  viewport.topRow = row;
}

/**
 * User scrolled up one row — reveal earlier content. Detaches from the tail and
 * freezes the message ID plus intra-message row currently moving off-screen.
 */
export function scrollUp(
  viewport: ChatViewportState,
  totalRows: number,
  viewportRows: number,
  lineMessageIds?: LineMessageIds,
): void {
  const maxTop = Math.max(0, totalRows - viewportRows);
  if (maxTop === 0) {
    viewport.anchorMessageId = null;
    viewport.anchorRowOffset = 0;
    return;
  }

  const targetRow = Math.max(0, firstVisibleRow(viewport, totalRows, viewportRows) - 1);
  viewport.followTail = false;
  captureAnchor(viewport, targetRow, lineMessageIds);
}

/**
 * User scrolled down one row. Only an edge scroll that reaches the bottom
 * re-arms follow-tail; page-down remains a history navigation action.
 */
export function scrollDown(
  viewport: ChatViewportState,
  totalRows: number,
  viewportRows: number,
  lineMessageIds?: LineMessageIds,
): void {
  if (viewport.followTail) return;
  const current = resolveViewport(viewport, totalRows, viewportRows, lineMessageIds);
  const maxTop = Math.max(0, totalRows - viewportRows);
  const targetRow = Math.min(maxTop, current.start + 1);
  if (targetRow >= maxTop) {
    pinToTail(viewport);
    return;
  }
  captureAnchor(viewport, targetRow, lineMessageIds);
}

/**
 * Page up (dir=1) / page down (dir=-1). Paging detaches from the tail and never
 * re-arms it; only row-by-row scrolling to the bottom edge does.
 */
export function scrollPage(
  viewport: ChatViewportState,
  totalRows: number,
  viewportRows: number,
  dir: 1 | -1,
  lineMessageIds?: LineMessageIds,
): void {
  const maxTop = Math.max(0, totalRows - viewportRows);
  const page = Math.max(1, viewportRows - 2);
  if (viewport.followTail) {
    if (dir === -1) return;
    viewport.followTail = false;
    captureAnchor(viewport, Math.max(0, maxTop - page), lineMessageIds);
    return;
  }

  const current = firstVisibleRow(viewport, totalRows, viewportRows);
  const target = dir === 1
    ? Math.max(0, current - page)
    : Math.min(maxTop, current + page);
  captureAnchor(viewport, target, lineMessageIds);
}

/**
 * Resolve the visible window for a freshly measured layout. Called once per
 * frame with the new content height; returns the [start, end) slice bounds.
 */
export function resolveViewport(
  viewport: ChatViewportState,
  totalRows: number,
  viewportRows: number,
  lineMessageIds?: LineMessageIds,
): { start: number; end: number; followTail: boolean } {
  viewport.lastContentHeight = totalRows;
  const maxTop = Math.max(0, totalRows - viewportRows);

  if (viewport.followTail) {
    viewport.topRow = 0;
    viewport.anchorMessageId = null;
    viewport.anchorRowOffset = 0;
    return { start: maxTop, end: totalRows, followTail: true };
  }

  let start = Math.max(0, Math.min(viewport.topRow, maxTop));
  if (viewport.anchorMessageId && lineMessageIds) {
    const first = findFirst(lineMessageIds, viewport.anchorMessageId);
    if (first >= 0) {
      const last = findLast(lineMessageIds, viewport.anchorMessageId);
      const rowOffset = Math.max(0, Math.min(viewport.anchorRowOffset, last - first));
      start = Math.max(0, Math.min(first + rowOffset, maxTop));
    }
  }

  viewport.topRow = start;
  return { start, end: Math.min(totalRows, start + viewportRows), followTail: false };
}

/** Force re-pin to the tail (new prompt submitted or explicit jump-to-bottom). */
export function pinToTail(viewport: ChatViewportState): void {
  viewport.followTail = true;
  viewport.topRow = 0;
  viewport.anchorMessageId = null;
  viewport.anchorRowOffset = 0;
}
