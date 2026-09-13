import { describe, expect, it } from "bun:test";
import {
  NoPendingPermissionError,
  PermissionInterruptManager,
  PermissionReplyInFlightError,
} from "../interruptManager";
import type { PermissionRequest } from "../interruptManager";

function makeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: `req-${Math.random().toString(36).slice(2)}`,
    tool: "shell",
    args: { command: "ls" },
    reason: "run ls",
    resolve: () => {},
    reject: () => {},
    ...overrides,
  };
}

/** White-box twin of the e2e FIFO/ack suite, pinning the production class. */
describe("PermissionInterruptManager", () => {
  it("keeps arrival order across concurrent enqueue bursts", () => {
    const manager = new PermissionInterruptManager();
    for (const id of ["a", "b", "c"]) manager.enqueue(makeRequest({ id }));

    expect(manager.hasPending()).toBe(true);
    expect(manager.pendingCount).toBe(3);
    expect(manager.current()?.id).toBe("a");
  });

  it("dequeues only after the awaited acknowledgment settles", async () => {
    const manager = new PermissionInterruptManager();
    let acked = false;
    manager.enqueue(
      makeRequest({
        resolve: async () => {
          await new Promise((r) => setTimeout(r, 5));
          acked = true;
        },
      }),
    );

    const reply = manager.replyCurrent("yes");
    expect(manager.current()).not.toBeNull(); // still head until ack lands
    await reply;
    expect(acked).toBe(true);
    expect(manager.hasPending()).toBe(false);
  });

  it("rejects a second concurrent reply instead of double-resolving", async () => {
    const manager = new PermissionInterruptManager();
    const outcomes: boolean[] = [];
    manager.enqueue(makeRequest({ resolve: (ok) => void outcomes.push(ok) }));

    const first = manager.replyCurrent("yes");
    await expect(manager.replyCurrent("no")).rejects.toBeInstanceOf(
      PermissionReplyInFlightError,
    );
    await first;
    expect(outcomes).toEqual([true]);
  });

  it("maps 'no' to a denied outcome and preserves the queue", async () => {
    const manager = new PermissionInterruptManager();
    const outcomes: boolean[] = [];
    manager.enqueue(makeRequest({ id: "head", resolve: (ok) => void outcomes.push(ok) }));
    manager.enqueue(makeRequest({ id: "next" }));

    await manager.replyCurrent("no");
    expect(outcomes).toEqual([false]);
    expect(manager.current()?.id).toBe("next");
  });

  it("throws NoPendingPermissionError when replying to an empty queue", async () => {
    const manager = new PermissionInterruptManager();
    await expect(manager.replyCurrent("yes")).rejects.toBeInstanceOf(
      NoPendingPermissionError,
    );
  });

  it("cancelCurrent rejects the head without resolving it", () => {
    const manager = new PermissionInterruptManager();
    const rejected: Error[] = [];
    let resolved: boolean | undefined;
    manager.enqueue(
      makeRequest({
        resolve: (ok) => void (resolved = ok),
        reject: (err) => rejected.push(err),
      }),
    );

    expect(manager.cancelCurrent(new Error("aborted"))).toBe(true);
    expect(rejected).toHaveLength(1);
    expect(resolved).toBeUndefined();
    expect(manager.hasPending()).toBe(false);
  });
});
