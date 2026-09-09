import type { PendingConfirmation } from "../types";

export type AnimationPhase = "opening" | "open" | "closing";

export interface ModalAnimation {
  phase: AnimationPhase;
  startedAt: number;
  duration: number;
}

export interface ModalAnimationRenderState {
  animation: ModalAnimation;
  progress: number;
  selectionFrom?: number;
  selectionTo?: number;
  selectionProgress?: number;
  /** One-shot cyan-to-blue sweep progress during opening. */
  sweepProgress?: number;
  closingSelectedIndex?: number;
}

export function progressOf(animation: ModalAnimation, now = performance.now()): number {
  if (animation.duration <= 0) return 1;
  const elapsed = now - animation.startedAt;
  return Math.min(1, Math.max(0, elapsed / animation.duration));
}

export function easeOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - Math.pow(1 - clamped, 3);
}

export const OPENING_DURATION_MS = 200;
export const CLOSING_DURATION_MS = 140;
export const SELECTION_DURATION_MS = 50;
export const ANIMATION_FPS = 30;

export function animationsEnabled(): boolean {
  return process.env.TOOLNETCLI_ANIMATIONS !== "0";
}

function clock(): number {
  return performance.now();
}

/**
 * Owns the only modal animation timer. The render tree remains responsible for
 * composing output; this engine only stores elapsed-time state and requests a
 * normal render while a transition is active.
 */
export class ModalAnimationEngine {
  private current: ModalAnimation | null = null;
  private snapshot: PendingConfirmation | null = null;
  private identity: PendingConfirmation | null = null;
  private selectionFrom: number | undefined;
  private selectionTo: number | undefined;
  private selectionStartedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private render: (() => void) | null = null;
  private onFinished: (() => void) | null = null;

  public syncOpening(snapshot: PendingConfirmation, render: () => void): void {
    this.render = render;
    if (this.identity === snapshot && this.current) return;

    this.identity = snapshot;
    this.snapshot = snapshot;
    this.selectionFrom = undefined;
    this.selectionTo = undefined;
    this.onFinished = null;

    if (!animationsEnabled()) {
      this.current = { phase: "open", startedAt: clock(), duration: 0 };
      this.stopTimer();
      return;
    }

    this.current = { phase: "opening", startedAt: clock(), duration: OPENING_DURATION_MS };
    this.startTimer();
  }

  public beginSelection(
    from: number,
    to: number,
    snapshot: PendingConfirmation,
    render: () => void,
  ): void {
    this.render = render;
    this.snapshot = snapshot;
    this.identity = snapshot;
    if (!animationsEnabled() || from === to) {
      this.selectionFrom = undefined;
      this.selectionTo = undefined;
      if (!this.current || this.current.phase === "open") this.stopTimer();
      return;
    }

    this.selectionFrom = from;
    this.selectionTo = to;
    this.selectionStartedAt = clock();
    this.startTimer();
  }

  public beginClosing(
    snapshot: PendingConfirmation,
    render: () => void,
    onFinished: () => void,
  ): void {
    this.render = render;
    this.snapshot = snapshot;
    this.identity = snapshot;
    this.selectionFrom = undefined;
    this.selectionTo = undefined;
    this.onFinished = onFinished;

    if (!animationsEnabled()) {
      this.current = null;
      this.stopTimer();
      this.snapshot = null;
      this.identity = null;
      this.onFinished = null;
      onFinished();
      return;
    }

    this.current = { phase: "closing", startedAt: clock(), duration: CLOSING_DURATION_MS };
    this.startTimer();
  }

  public getSnapshot(): PendingConfirmation | null {
    return this.snapshot;
  }

  public getRenderState(at = clock()): ModalAnimationRenderState | null {
    if (!this.current) return null;
    const progress = progressOf(this.current, at);
    const selectionProgress = this.selectionFrom === undefined || this.selectionTo === undefined
      ? undefined
      : Math.min(1, Math.max(0, (at - this.selectionStartedAt) / SELECTION_DURATION_MS));

    return {
      animation: { ...this.current },
      progress,
      selectionFrom: this.selectionFrom,
      selectionTo: this.selectionTo,
      selectionProgress,
      sweepProgress: this.current.phase === "opening" ? progress : undefined,
      closingSelectedIndex: this.snapshot?.selectedIndex ?? 0,
    };
  }

  public isAnimating(): boolean {
    const state = this.getRenderState();
    if (!state) return false;
    const selectionActive = state.selectionProgress !== undefined && state.selectionProgress < 1;
    return state.animation.phase !== "open" || selectionActive;
  }

  public getTimer(): ReturnType<typeof setInterval> | null {
    return this.timer;
  }

  public reset(): void {
    this.stopTimer();
    this.current = null;
    this.snapshot = null;
    this.identity = null;
    this.selectionFrom = undefined;
    this.selectionTo = undefined;
    this.onFinished = null;
    this.render = null;
  }

  private startTimer(): void {
    if (!this.timer && this.isAnimating()) {
      this.timer = setInterval(() => this.tick(), Math.round(1000 / ANIMATION_FPS));
    }
  }

  private tick(): void {
    if (!this.current) {
      this.stopTimer();
      return;
    }

    const at = clock();
    const phaseComplete = progressOf(this.current, at) >= 1;
    const selectionComplete = this.selectionFrom === undefined || this.selectionTo === undefined ||
      at - this.selectionStartedAt >= SELECTION_DURATION_MS;

    if (this.current.phase === "opening" && phaseComplete) {
      this.current = { ...this.current, phase: "open" };
    }

    if (!selectionComplete) {
      this.render?.();
      return;
    }

    this.selectionFrom = undefined;
    this.selectionTo = undefined;

    if (this.current.phase === "closing" && phaseComplete) {
      this.current = null;
      this.snapshot = null;
      this.identity = null;
      this.stopTimer();
      const onFinished = this.onFinished;
      this.onFinished = null;
      onFinished?.();
      this.render?.();
      return;
    }

    if (this.current.phase === "open") this.stopTimer();
    this.render?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export const workspaceAccessAnimation = new ModalAnimationEngine();
