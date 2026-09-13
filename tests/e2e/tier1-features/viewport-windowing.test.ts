import { describe, it, expect } from "bun:test";
import {
  createChatViewport,
  resolveViewport,
  scrollUp,
  scrollDown,
  scrollPage,
  pinToTail,
} from "../../../src/tui/viewport";

describe("Tier 1 Feature Coverage: Bounded Viewport Windowing & Tail Following", () => {
  it("F19.1: Viewport initializes with followTail enabled and topRow at zero", () => {
    const vp = createChatViewport();
    expect(vp.followTail).toBe(true);
    expect(vp.topRow).toBe(0);
  });

  it("F19.2: Streaming tokens with followTail keeps window pinned to tail without jitter", () => {
    const vp = createChatViewport();
    const viewportHeight = 20;

    // Simulate 50 streaming chunks
    for (let totalLines = 1; totalLines <= 100; totalLines += 2) {
      const window = resolveViewport(vp, totalLines, viewportHeight);
      const expectedStart = Math.max(0, totalLines - viewportHeight);
      expect(window.start).toBe(expectedStart);
      expect(window.end - window.start).toBeLessThanOrEqual(viewportHeight);
    }
  });

  it("F19.3: User scroll up detaches followTail so window does not move during stream", () => {
    const vp = createChatViewport();
    const viewportHeight = 15;
    const totalLines = 50;

    // First resolve at tail
    resolveViewport(vp, totalLines, viewportHeight);
    expect(vp.followTail).toBe(true);

    // User scrolls up (content > viewport, so scrollUp succeeds)
    scrollUp(vp, totalLines, viewportHeight);
    expect(vp.followTail).toBe(false);

    const initialWindow = resolveViewport(vp, totalLines, viewportHeight);

    // More lines stream in
    const nextWindow = resolveViewport(vp, totalLines + 10, viewportHeight);
    // Anchor row must stay stationary because user detached tail
    expect(nextWindow.start).toBe(initialWindow.start);
  });

  it("F19.4: Scrolling down back to bottom re-arms followTail", () => {
    const vp = createChatViewport();
    const viewportHeight = 10;
    const totalLines = 30;

    // Detach tail
    scrollUp(vp, totalLines, viewportHeight);
    expect(vp.followTail).toBe(false);

    // Scroll back down to the bottom
    for (let i = 0; i < 25; i++) {
      scrollDown(vp, totalLines, viewportHeight);
    }
    expect(vp.followTail).toBe(true);
  });

  it("F19.5: Page scroll shifts viewport by page height smoothly", () => {
    const vp = createChatViewport();
    const viewportHeight = 12;
    const totalLines = 100;

    resolveViewport(vp, totalLines, viewportHeight);
    // Page up (dir = 1)
    scrollPage(vp, totalLines, viewportHeight, 1);

    expect(vp.followTail).toBe(false);
    const window = resolveViewport(vp, totalLines, viewportHeight);
    expect(window.start).toBeLessThan(totalLines - viewportHeight);

    pinToTail(vp);
    expect(vp.followTail).toBe(true);
  });
});
