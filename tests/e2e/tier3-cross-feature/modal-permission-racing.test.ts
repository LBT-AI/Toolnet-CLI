import { describe, it, expect } from "bun:test";
import {
  PermissionInterruptManager,
  NoPendingPermissionError,
  PermissionReplyInFlightError,
  type PermissionRequest,
} from "../../../src/tui/permissions/interruptManager";
import { createAsyncMutation } from "../../../src/tui/asyncMutation";
import { tuiState } from "../../../src/tui/state";
import {
  getPermissionInterruptManager,
  requestApprovalModal,
} from "../../../src/tui/permissions/permissionModal";

function makeRequest(id: string, onResolve?: (approved: boolean) => void): PermissionRequest {
  return {
    id,
    tool: "shell",
    args: {},
    reason: `ask ${id}`,
    resolve: (approved: boolean) => {
      onResolve?.(approved);
    },
    reject: () => undefined,
  };
}

describe("Tier 3 Cross-Feature: Modal-Permission Racing", () => {
  it("T3.15: five concurrent requests keep strict FIFO order and are answered one by one", async () => {
    const manager = new PermissionInterruptManager();
    const answered: string[] = [];

    for (let i = 0; i < 5; i++) {
      manager.enqueue(makeRequest(`r${i}`, () => answered.push(`r${i}`)));
    }
    expect(manager.pendingCount).toBe(5);
    expect(manager.current()!.id).toBe("r0");

    for (let i = 0; i < 5; i++) {
      expect(manager.current()!.id).toBe(`r${i}`);
      await manager.replyCurrent("yes");
    }
    expect(answered).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(manager.hasPending()).toBe(false);
  });

  it("T3.16: concurrent double reply is rejected instead of racing to resolve twice", async () => {
    const manager = new PermissionInterruptManager();
    let resolveCount = 0;

    // Gated acknowledgment keeps the reply "in flight" while the second fires.
    let releaseAck: (() => void) | null = null;
    const gate = new Promise<void>((r) => (releaseAck = r));
    manager.enqueue({
      ...makeRequest("slow"),
      resolve: (approved: boolean) => {
        resolveCount++;
        return gate;
      },
    } as unknown as PermissionRequest);

    const first = manager.replyCurrent("yes");
    await new Promise((r) => setTimeout(r, 5));
    await expect(manager.replyCurrent("yes")).rejects.toBeInstanceOf(PermissionReplyInFlightError);
    releaseAck!();
    await first;

    // Exactly one acknowledgment reached the backend.
    expect(resolveCount).toBe(1);
    expect(manager.pendingCount).toBe(0);
  });

  it("T3.17: cancel racing a reply cannot dequeue two requests", async () => {
    const manager = new PermissionInterruptManager();
    manager.enqueue(makeRequest("race-1"));
    manager.enqueue(makeRequest("race-2"));

    // Reply in flight (gated acknowledgment)…
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const head = manager.current()!;
    head.resolve = () => gate;
    const reply = manager.replyCurrent("no");
    await new Promise((r) => setTimeout(r, 5));

    // …cancel must be refused while the reply mutation is active.
    expect(manager.cancelCurrent(new Error("late cancel"))).toBe(false);

    release!();
    await reply;
    expect(manager.pendingCount).toBe(1);
    expect(manager.current()!.id).toBe("race-2");
  });

  it("T3.18: reply with an empty queue throws the typed no-pending error", () => {
    const manager = new PermissionInterruptManager();
    expect(manager.hasPending()).toBe(false);
    expect(manager.replyCurrent("yes")).rejects.toBeInstanceOf(NoPendingPermissionError);
  });

  it("T3.19: dialogs never answer while a mutation awaits them — mutation blocks until resolved", async () => {
    let mutationSettled = false;
    let approvedResult = false;

    // A consequential mutation whose backend awaits the approval dialog.
    const mutation = createAsyncMutation(async () => {
      const approved = await requestApprovalModal({ toolName: "shell", args: {}, reason: "mutate needs approval" });
      return approved;
    });

    const executing = mutation.execute(undefined);
    void executing.then((ok) => {
      approvedResult = ok;
      mutationSettled = true;
    });
    await new Promise((r) => setTimeout(r, 5));

    // Dialog is up; the mutation must still be pending.
    expect(tuiState.pendingConfirmation).not.toBeNull();
    expect(mutation.state).toBe("pending");
    expect(mutationSettled).toBe(false);

    // Approving releases the mutation.
    tuiState.pendingConfirmation!.onDecision!("y");
    tuiState.pendingConfirmation!.resolve(true);
    const approved = await executing;
    expect(approved).toBe(true);
    expect(approvedResult).toBe(true);
    expect(mutation.state).toBe("success");
  });

  it("T3.20: denial through the dialog resolves the mutation to a clean false, never a hang", async () => {
    const manager = getPermissionInterruptManager();

    const p = requestApprovalModal({ toolName: "shell", args: {}, reason: "deny this one" });
    await new Promise((r) => setTimeout(r, 5));
    expect(tuiState.pendingConfirmation?.prompt).toBe("deny this one");

    tuiState.pendingConfirmation!.onDecision!("n");
    tuiState.pendingConfirmation!.resolve(false);

    const approved = await Promise.race([
      p,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dialog hang")), 500)),
    ]);
    expect(approved).toBe(false);
    expect(manager.pendingCount).toBe(0);
  });

  it("T3.21: an answered request can never be answered twice through the manager", async () => {
    const manager = new PermissionInterruptManager();
    const seen: string[] = [];

    manager.enqueue({
      ...makeRequest("once", (approved) => {
        seen.push(approved ? "approved" : "denied");
      }),
    });

    // First reply dequeues the request.
    await manager.replyCurrent("yes");
    expect(seen).toEqual(["approved"]);
    expect(manager.pendingCount).toBe(0);

    // A racing duplicate reply therefore hits the empty-queue guard — the
    // answered request can never be resolved (or trust-recorded) a second time.
    await expect(manager.replyCurrent("yes")).rejects.toBeInstanceOf(NoPendingPermissionError);
    expect(seen).toEqual(["approved"]);
  });
});
