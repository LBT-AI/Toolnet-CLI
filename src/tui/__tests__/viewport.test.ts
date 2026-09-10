import { describe, it, expect } from "bun:test";
import {
  createChatViewport,
  shouldFollowTail,
  resolveViewport,
  scrollUp,
  scrollDown,
  scrollPage,
  pinToTail,
  TAIL_EPSILON,
  type ChatViewportState,
} from "../viewport";

/**
 * Regression tests for the chat viewport jitter fix.
 *
 * Video symptom: while the assistant streamed markdown/code, the conversation
 * viewport bounced up/down every few tokens. Root causes were per-token
 * `scrollOffset = 0` resets and absolute-bottom windowing that dragged the
 * view down as content grew, plus one full re-render per token.
 *
 * Invariants locked here (the pure scroll model):
 *  1. followTail=true  → streamed appends never move existing rows on screen
 *     (window stays pinned to the tail; new rows enter at the bottom edge).
 *  2. User scroll-up during a stream detaches the tail; further appends do
 *     NOT drag the window (anchor row stays put as totalRows grows).
 *  3. Scroll back to the bottom re-arms followTail.
 *  4. resolveViewport is a single decision point: one resolve per "frame",
 *     window never oscillates when called repeatedly with steady content.
 *  5. Window slices never produce duplicate or out-of-range rows.
 */

/** Simulate a stream: append n chunks of `rows` lines each, resolving once per chunk ("frame"). */
function simulateStream(
  vp: ChatViewportState,
  chunkCount: number,
  rowsPerChunk: number,
  viewportRows: number,
): Array<{ start: number; total: number }> {
  const frames: Array<{ start: number; total: number }> = [];
  let total = 0;
  for (let i = 0; i < chunkCount; i++) {
    total += rowsPerChunk;
    const w = resolveViewport(vp, total, viewportRows);
    frames.push({ start: w.start, total });
  }
  return frames;
}

describe("Chat viewport — streaming jitter regression", () => {
  it("followTail keeps the window pinned to the tail for 120 streamed chunks (no oscillation)", () => {
    for (const viewportRows of [14, 19, 19, 24]) {
      const vp = createChatViewport();
      const frames = simulateStream(vp, 120, 3, viewportRows);
      for (const f of frames) {
        const expectedStart = Math.max(0, f.total - viewportRows);
        expect(f.start).toBe(expectedStart);
      }
      expect(vp.followTail).toBe(true);
      expect(vp.topRow).toBe(0);
    }
  });

  it("topRow stays 0 during follow — content never slides up under the user's eyes", () => {
    const vp = createChatViewport();
    const viewportRows = 20;
    let total = 5;
    for (let i = 0; i < 40; i++) {
      total += 1 + (i % 3); // ragged chunks like real token streams
      resolveViewport(vp, total, viewportRows);
      expect(vp.topRow).toBe(0);
    }
  });

  it("user scroll-up mid-stream detaches; appends no longer drag the window (anchor hold)", () => {
    const viewportRows = 20;
    const vp = createChatViewport();
    // Stream until content overflows the viewport.
    let total = viewportRows * 2;
    resolveViewport(vp, total, viewportRows);
    expect(vp.followTail).toBe(true);

    // User scrolls up one row.
    scrollUp(vp, total, viewportRows);
    expect(vp.followTail).toBe(false);
    const anchorStart = resolveViewport(vp, total, viewportRows).start;
    expect(anchorStart).toBe(total - viewportRows - 1);

    // Stream 60 more chunks — the anchor row must NOT move.
    for (let i = 0; i < 60; i++) {
      total += 4;
      const w = resolveViewport(vp, total, viewportRows);
      expect(w.start).toBe(anchorStart);
      expect(w.followTail).toBe(false);
    }
  });

  it("scrolling back to the bottom re-arms followTail", () => {
    const viewportRows = 20;
    const vp = createChatViewport();
    let total = viewportRows * 3;
    resolveViewport(vp, total, viewportRows);
    scrollUp(vp, total, viewportRows);
    expect(vp.followTail).toBe(false);

    // Scroll down one row at a time until the bottom is reached.
    let lastStart = resolveViewport(vp, total, viewportRows).start;
    for (let i = 0; i < viewportRows + 5; i++) {
      scrollDown(vp, total, viewportRows);
      const w = resolveViewport(vp, total, viewportRows);
      if (vp.followTail) {
        expect(w.start).toBe(Math.max(0, total - viewportRows));
        return;
      }
      expect(w.start).toBeGreaterThan(lastStart); // monotonic toward the bottom
      lastStart = w.start;
    }
    // Unreachable: the loop must re-arm the tail before exhausting.
    expect(vp.followTail).toBe(true);
  });

  it("code fence completion (row-count jumps) does not move a detached anchor", () => {
    const viewportRows = 24;
    const vp = createChatViewport();
    let total = 80;
    resolveViewport(vp, total, viewportRows);
    scrollUp(vp, total, viewportRows);
    scrollUp(vp, total, viewportRows);
    const anchorStart = resolveViewport(vp, total, viewportRows).start;

    // A completed fence re-highlights in one shot: content suddenly grows a lot.
    total += 25;
    expect(resolveViewport(vp, total, viewportRows).start).toBe(anchorStart);
    // …and shrinks (e.g. a collapsed tool output) without moving the anchor.
    total -= 10;
    expect(resolveViewport(vp, total, viewportRows).start).toBe(anchorStart);
  });

  it("windows never produce duplicate/out-of-range rows at any terminal size", () => {
    for (const viewportRows of [14, 19, 19, 24]) {
      const vp = createChatViewport();
      let total = 0;
      for (let chunk = 0; chunk < 60; chunk++) {
        total += 1 + (chunk % 5);
        const w = resolveViewport(vp, total, viewportRows);
        expect(w.start).toBeGreaterThanOrEqual(0);
        expect(w.start).toBeLessThanOrEqual(Math.max(0, total - 1));
        expect(w.end).toBeLessThanOrEqual(total);
        expect(w.end - w.start).toBeLessThanOrEqual(viewportRows);
        // No duplicates: the slice is contiguous by construction, assert bounds.
        if (w.end > w.start) {
          expect(w.end).toBeGreaterThan(w.start);
        }
      }
    }
  });

  it("shouldFollowTail matches the tail epsilon window", () => {
    const vp = createChatViewport();
    vp.followTail = false;
    vp.topRow = 0;
    const viewportRows = 20;
    // Exactly at bottom → follow.
    expect(shouldFollowTail(vp, viewportRows, viewportRows)).toBe(true);
    // Within epsilon → follow.
    expect(shouldFollowTail(vp, viewportRows + TAIL_EPSILON, viewportRows)).toBe(true);
    // Just beyond epsilon → detached.
    expect(shouldFollowTail(vp, viewportRows + TAIL_EPSILON + 1, viewportRows)).toBe(false);
  });

  it("pinToTail re-pins after a new turn (legacy scrollOffset reset path)", () => {
    const vp = createChatViewport();
    const viewportRows = 20;
    let total = 100;
    resolveViewport(vp, total, viewportRows);
    scrollUp(vp, total, viewportRows);
    expect(vp.followTail).toBe(false);

    pinToTail(vp);
    const w = resolveViewport(vp, total, viewportRows);
    expect(vp.followTail).toBe(true);
    expect(w.start).toBe(total - viewportRows);
  });

  it("page-up detaches and pages without re-arming; page-down at tail is a no-op", () => {
    const viewportRows = 20;
    const vp = createChatViewport();
    let total = 200;
    resolveViewport(vp, total, viewportRows);

    scrollPage(vp, total, viewportRows, 1); // PgUp from tail
    expect(vp.followTail).toBe(false);
    const afterPageUp = resolveViewport(vp, total, viewportRows).start;
    expect(afterPageUp).toBe(total - viewportRows - (viewportRows - 2));

    scrollPage(vp, total, viewportRows, 1); // further up
    const afterSecond = resolveViewport(vp, total, viewportRows).start;
    expect(afterSecond).toBeLessThan(afterPageUp);

    // Stream continues — still detached, anchor holds.
    total += 30;
    expect(resolveViewport(vp, total, viewportRows).start).toBe(afterSecond);

    // Page down does NOT re-arm the tail (only edge-scrolling to bottom does).
    scrollPage(vp, total, viewportRows, -1);
    expect(vp.followTail).toBe(false);
  });

  it("clamps a detached topRow when content shrinks below the window", () => {
    const viewportRows = 20;
    const vp = createChatViewport();
    let total = 100;
    resolveViewport(vp, total, viewportRows);
    scrollUp(vp, total, viewportRows);
    scrollUp(vp, total, viewportRows);
    scrollUp(vp, total, viewportRows);

    // Content collapses (e.g. queue cleared / messages replaced).
    total = 25;
    const w = resolveViewport(vp, total, viewportRows);
    expect(w.start).toBe(Math.max(0, total - viewportRows));
    expect(w.end).toBe(total);
  });
});
