/**
 * FIFO permission interrupt manager.
 *
 * The TUI must never fire-and-forget a permission reply: the dialog closes
 * only after the backend acknowledged the decision, and only one reply may be
 * in flight at a time. Incoming approval requests are queued in arrival order
 * so concurrent tool approvals never clobber or overwrite each other's modals.
 *
 * The manager is presentation-layer plumbing: it sequences requests and
 * awaits acknowledgment. It never decides whether an action is allowed —
 * that verdict stays with the security engine that produced the request.
 */

export interface PermissionRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
  resolve: (approved: boolean) => Promise<void> | void;
  reject: (err: Error) => void;
}

export type PermissionChoice = "yes" | "always" | "no";

export class NoPendingPermissionError extends Error {
  constructor() {
    super("No pending permission request to reply to");
    this.name = "NoPendingPermissionError";
  }
}

export class PermissionReplyInFlightError extends Error {
  constructor() {
    super("Permission reply mutation is already in flight");
    this.name = "PermissionReplyInFlightError";
  }
}

export class PermissionInterruptManager {
  private queue: PermissionRequest[] = [];
  private activeMutation = false;

  enqueue(req: PermissionRequest): void {
    this.queue.push(req);
  }

  /** The request whose dialog is (or should be) on screen. */
  current(): PermissionRequest | null {
    return this.queue.length > 0 ? this.queue[0] : null;
  }

  hasPending(): boolean {
    return this.queue.length > 0;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  /**
   * Resolve the head request and wait for backend acknowledgment before
   * dequeuing. Double-reply guarded: a second concurrent reply is rejected
   * rather than racing the first one to `resolve`.
   */
  async replyCurrent(choice: PermissionChoice): Promise<void> {
    if (this.queue.length === 0) {
      throw new NoPendingPermissionError();
    }
    if (this.activeMutation) {
      throw new PermissionReplyInFlightError();
    }

    this.activeMutation = true;
    const req = this.queue[0];

    try {
      const approved = choice === "yes" || choice === "always";
      // Await acknowledgment before dequeuing (zero fire-and-forget)
      await Promise.resolve(req.resolve(approved));
      this.queue.shift(); // Dequeue only after backend acknowledgment
    } finally {
      this.activeMutation = false;
    }
  }

  /** Cancel the head request (e.g. its tool call was aborted upstream). */
  cancelCurrent(err: Error): boolean {
    if (this.queue.length === 0 || this.activeMutation) return false;
    const req = this.queue.shift()!;
    req.reject(err);
    return true;
  }
}
