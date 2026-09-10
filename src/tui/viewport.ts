/**
 * Conversation viewport scroll model — follow-tail + anchor.
 *
 * Scroll semantics (unchanged for existing callers): `topRow` is the number of
 * content rows scrolled PAST the bottom, i.e. 0 means "viewing the tail".
 * The sticky-follow behaviour lives entirely in this module:
 *
 *  - While the tail is visible (`followTail`), appended content keeps the view
 *    pinned to the bottom — expressed as topRow = 0, so content NEVER slides
 *    upward under the user's eyes; new rows enter at the bottom edge.
 *  - The moment the user scrolls up, followTail turns off and topRow grows to
 *    preserve the anchor row (the content row the user was looking at), so
 *    streamed appends no longer drag the viewport.
 *  - Scrolling back to the bottom re-arms followTail.
 *
 * Layout is computed ONCE per frame: callers measure total rows first, resolve
 * the window, then commit. Never layout → scroll → layout again.
 */

export interface ChatViewportState {
  /** Rows scrolled past the bottom (0 = pinned to tail). */
  topRow: number;
  /** Sticky-tail: auto-keep the newest content in view while it streams. */
  followTail: boolean;
  /** Total content rows observed at the last resolve (diagnostics/tests). */
  lastContentHeight: number;
}

/** Distance (rows) from the bottom within which the tail still counts as visible. */
export const TAIL_EPSILON = 2;

export function createChatViewport(): ChatViewportState {
  return { topRow: 0, followTail: true, lastContentHeight: 0 };
}

/**
 * Should the viewport stick to the tail for the incoming chunk?
 * True when the user is (still) at — or within TAIL_EPSILON rows of — the bottom.
 */
export function shouldFollowTail(
  viewport: ChatViewportState,
  totalRows: number,
  viewportRows: number,
): boolean {
  const bottom = viewport.topRow + viewportRows;
  return totalRows - bottom <= TAIL_EPSILON;
}

/**
 * User scrolled up one row — reveal earlier content. Detaches from the tail
 * and freezes the anchor at the window the user was looking at. Detaching is
 * a no-op while all content already fits (nothing to scroll up to).
 */
export function scrollUp(viewport: ChatViewportState, totalRows: number, viewportRows: number): void {
  const maxTop = Math.max(0, totalRows - viewportRows);
  if (viewport.followTail) {
    if (maxTop === 0) return; // content fits — nothing to scroll
    viewport.followTail = false;
    viewport.topRow = maxTop; // start from the window the tail was showing
  }
  viewport.topRow = Math.max(0, viewport.topRow - 1);
}

/**
 * User scrolled down one row — reveal later content. Reaching the bottom
 * re-arms follow-tail so subsequent streamed appends pin the view again.
 */
export function scrollDown(viewport: ChatViewportState, totalRows: number, viewportRows: number): void {
  if (viewport.followTail) return;
  const maxTop = Math.max(0, totalRows - viewportRows);
  viewport.topRow = Math.min(maxTop, viewport.topRow + 1);
  if (viewport.topRow >= maxTop) {
    viewport.followTail = true;
    viewport.topRow = 0;
  }
}

/**
 * Page up (dir=1) / page down (dir=-1). Paging detaches from the tail but —
 * unlike row-by-row scrolling — never re-arms it: only scrolling back down to
 * the bottom edge does.
 */
export function scrollPage(viewport: ChatViewportState, totalRows: number, viewportRows: number, dir: 1 | -1): void {
  const maxTop = Math.max(0, totalRows - viewportRows);
  const page = Math.max(1, viewportRows - 2);
  if (viewport.followTail) {
    if (dir === -1) return; // page-down at the tail is a no-op
    viewport.followTail = false;
    viewport.topRow = Math.max(0, maxTop - page);
    return;
  }
  if (dir === 1) {
    viewport.topRow = Math.max(0, viewport.topRow - page);
  } else {
    viewport.topRow = Math.min(maxTop, viewport.topRow + page);
  }
}

/**
 * Resolve the visible window for a freshly measured layout. Called ONCE per
 * frame with the new content height; mutates `viewport` to the committed top
 * row and returns the [start, end) slice bounds.
 */
export function resolveViewport(
  viewport: ChatViewportState,
  totalRows: number,
  viewportRows: number,
): { start: number; end: number; followTail: boolean } {
  viewport.lastContentHeight = totalRows;
  const maxTop = Math.max(0, totalRows - viewportRows);

  if (viewport.followTail) {
    viewport.topRow = 0;
    return { start: Math.max(0, totalRows - viewportRows), end: totalRows, followTail: true };
  }

  // Detached: keep the anchor steady as content grows above/below the window.
  if (viewport.topRow > maxTop) viewport.topRow = maxTop;
  const start = Math.max(0, Math.min(viewport.topRow, totalRows));
  return { start, end: Math.min(totalRows, start + viewportRows), followTail: false };
}

/** Force re-pin to the tail (new turn submitted, jump-to-bottom, resize). */
export function pinToTail(viewport: ChatViewportState): void {
  viewport.followTail = true;
  viewport.topRow = 0;
}
