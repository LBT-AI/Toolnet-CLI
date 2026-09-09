import { describe, it, expect, afterEach } from "bun:test";
import {
  ModalAnimationEngine,
  OPENING_DURATION_MS,
  CLOSING_DURATION_MS,
  SELECTION_DURATION_MS,
  easeOutCubic,
  progressOf,
} from "../modalAnimation";
import type { PendingConfirmation } from "../../types";

const confirmation = (): PendingConfirmation => ({
  prompt: "Do you trust the folder /root/workspace?",
  selectedIndex: 0,
  resolve: () => {},
});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("Workspace Access modal animation engine", () => {
  const previous = process.env.TOOLNETCLI_ANIMATIONS;

  afterEach(() => {
    if (previous === undefined) delete process.env.TOOLNETCLI_ANIMATIONS;
    else process.env.TOOLNETCLI_ANIMATIONS = previous;
  });

  it("uses elapsed time and easing for opening, then stops its timer", async () => {
    delete process.env.TOOLNETCLI_ANIMATIONS;
    const engine = new ModalAnimationEngine();
    let renders = 0;
    engine.syncOpening(confirmation(), () => { renders++; });

    const initial = engine.getRenderState()!;
    expect(initial.animation.phase).toBe("opening");
    expect(initial.progress).toBeLessThan(1);
    expect(progressOf({ phase: "opening", startedAt: performance.now() - OPENING_DURATION_MS, duration: OPENING_DURATION_MS })).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(engine.getTimer()).not.toBeNull();

    await wait(OPENING_DURATION_MS + 80);
    expect(engine.getRenderState()!.animation.phase).toBe("open");
    expect(engine.getTimer()).toBeNull();
    expect(renders).toBeGreaterThan(0);
  });

  it("animates only the old/new selection rows and cleans up after 50ms", async () => {
    process.env.TOOLNETCLI_ANIMATIONS = "1";
    const engine = new ModalAnimationEngine();
    const conf = confirmation();
    engine.syncOpening(conf, () => {});
    await wait(OPENING_DURATION_MS + 30);

    conf.selectedIndex = 1;
    engine.beginSelection(0, 1, conf, () => {});
    const state = engine.getRenderState()!;
    expect(state.selectionFrom).toBe(0);
    expect(state.selectionTo).toBe(1);
    expect(state.selectionProgress).toBeLessThan(1);

    await wait(SELECTION_DURATION_MS + 50);
    expect(engine.getRenderState()!.selectionFrom).toBeUndefined();
    expect(engine.getTimer()).toBeNull();
  });

  it("keeps the closing snapshot until the closing animation finishes", async () => {
    process.env.TOOLNETCLI_ANIMATIONS = "1";
    const engine = new ModalAnimationEngine();
    const conf = confirmation();
    engine.syncOpening(conf, () => {});
    await wait(OPENING_DURATION_MS + 30);

    let finished = false;
    engine.beginClosing(conf, () => {}, () => { finished = true; });
    expect(engine.getRenderState()!.animation.phase).toBe("closing");
    expect(engine.getSnapshot()).toBe(conf);
    await wait(CLOSING_DURATION_MS + 70);
    expect(finished).toBe(true);
    expect(engine.getSnapshot()).toBeNull();
    expect(engine.getTimer()).toBeNull();
  });

  it("disables all animation timers with TOOLNETCLI_ANIMATIONS=0", () => {
    process.env.TOOLNETCLI_ANIMATIONS = "0";
    const engine = new ModalAnimationEngine();
    const conf = confirmation();
    engine.syncOpening(conf, () => {});
    expect(engine.getRenderState()!.animation.phase).toBe("open");
    expect(engine.getTimer()).toBeNull();

    let finished = false;
    engine.beginClosing(conf, () => {}, () => { finished = true; });
    expect(finished).toBe(true);
    expect(engine.getSnapshot()).toBeNull();
  });
});
