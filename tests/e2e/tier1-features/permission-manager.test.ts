import { describe, it, expect } from "bun:test";
import { getPermissionInterruptManagerClass, type PermissionRequest } from "../harness/contractLoaders";

describe("Tier 1 Feature Coverage: FIFO Permission Interrupt Manager & Awaited Ack", () => {
  it("F10.1: Enqueue preserves FIFO ordering of incoming permission requests", async () => {
    const ManagerClass = await getPermissionInterruptManagerClass();
    const manager = new ManagerClass();

    const req1: PermissionRequest = {
      id: "req-1",
      tool: "bash",
      args: { command: "npm install" },
      reason: "Install dependencies",
      resolve: () => {},
      reject: () => {},
    };

    const req2: PermissionRequest = {
      id: "req-2",
      tool: "fs_write",
      args: { path: "package.json" },
      reason: "Write package file",
      resolve: () => {},
      reject: () => {},
    };

    manager.enqueue(req1);
    manager.enqueue(req2);

    expect(manager.hasPending()).toBe(true);
    expect(manager.current()?.id).toBe("req-1");
  });

  it("F9.1: Await backend acknowledgment before dequeuing permission modal (no fire-and-forget)", async () => {
    const ManagerClass = await getPermissionInterruptManagerClass();
    const manager = new ManagerClass();

    let ackCompleted = false;
    let approvedVal: boolean | null = null;

    const req: PermissionRequest = {
      id: "req-ack",
      tool: "bash",
      args: { command: "rm -rf /tmp/test" },
      reason: "Clean tmp",
      resolve: async (approved) => {
        approvedVal = approved;
        // Simulate backend async acknowledgment delay
        await new Promise((r) => setTimeout(r, 40));
        ackCompleted = true;
      },
      reject: () => {},
    };

    manager.enqueue(req);
    expect(manager.current()?.id).toBe("req-ack");

    // Reply
    const replyPromise = manager.replyCurrent("yes");

    // Modal must NOT be dequeued until backend acknowledgment settles
    expect(manager.hasPending()).toBe(true);
    expect(ackCompleted).toBe(false);

    await replyPromise;
    expect(ackCompleted).toBe(true);
    expect(approvedVal).toBe(true);
    // Only after settlement is modal dequeued
    expect(manager.hasPending()).toBe(false);
  });

  it("F9.2: Reply 'no' resolves approval as false and awaits backend acknowledgment", async () => {
    const ManagerClass = await getPermissionInterruptManagerClass();
    const manager = new ManagerClass();

    let approvedVal: boolean | null = null;

    const req: PermissionRequest = {
      id: "req-deny",
      tool: "shell_exec",
      args: { command: "cat /etc/passwd" },
      reason: "Security audit",
      resolve: (approved) => {
        approvedVal = approved;
      },
      reject: () => {},
    };

    manager.enqueue(req);
    await manager.replyCurrent("no");

    expect(approvedVal).toBe(false);
    expect(manager.hasPending()).toBe(false);
  });

  it("F10.2: Sequential processing: completing current advances queue to next pending item", async () => {
    const ManagerClass = await getPermissionInterruptManagerClass();
    const manager = new ManagerClass();

    const order: string[] = [];

    manager.enqueue({
      id: "first",
      tool: "t1",
      args: {},
      reason: "r1",
      resolve: () => {
        order.push("first");
      },
      reject: () => {},
    });

    manager.enqueue({
      id: "second",
      tool: "t2",
      args: {},
      reason: "r2",
      resolve: () => {
        order.push("second");
      },
      reject: () => {},
    });

    expect(manager.current()?.id).toBe("first");
    await manager.replyCurrent("yes");

    expect(manager.current()?.id).toBe("second");
    await manager.replyCurrent("always");

    expect(manager.hasPending()).toBe(false);
    expect(order).toEqual(["first", "second"]);
  });

  it("F10.3: Concurrency protection: duplicate in-flight reply attempts are rejected", async () => {
    const ManagerClass = await getPermissionInterruptManagerClass();
    const manager = new ManagerClass();

    manager.enqueue({
      id: "slow-req",
      tool: "slow_tool",
      args: {},
      reason: "slow",
      resolve: async () => {
        await new Promise((r) => setTimeout(r, 50));
      },
      reject: () => {},
    });

    const firstReply = manager.replyCurrent("yes");
    // Attempt second reply while first is in flight
    expect(manager.replyCurrent("yes")).rejects.toThrow(/already in flight/i);

    await firstReply;
    expect(manager.hasPending()).toBe(false);
  });
});
