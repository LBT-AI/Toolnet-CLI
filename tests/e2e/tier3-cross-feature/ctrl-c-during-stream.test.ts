import { describe, it, expect } from "bun:test";
import {
  getPermissionInterruptManager,
  requestApprovalModal,
  cancelPendingApproval,
} from "../../../src/tui/permissions/permissionModal";
import { tuiState } from "../../../src/tui/state";
import type { PermissionChoice } from "../../../src/tui/permissions/interruptManager";

describe("Tier 3 Cross-Feature: Ctrl+C During Stream / Approval", () => {
  it("T3.5: Ctrl+C while an approval dialog is open denies the head and unwinds the awaiting backend", async () => {
    const manager = getPermissionInterruptManager();
    const seen: Array<{ tool: string; approved: boolean }> = [];

    // Simulate the backend awaiting the tool approval while the stream runs.
    const awaiting = requestApprovalModal({ toolName: "shell", args: {}, reason: "run rm -rf" });
    void awaiting.then((approved) => seen.push({ tool: "shell", approved }));
    await new Promise((r) => setTimeout(r, 5));
    expect(tuiState.pendingConfirmation).not.toBeNull();

    // Ctrl+C abort path: deny + unwind instead of being swallowed.
    expect(cancelPendingApproval()).toBe(true);
    await new Promise((r) => setTimeout(r, 5));

    expect(tuiState.pendingConfirmation).toBeNull();
    expect(seen).toEqual([{ tool: "shell", approved: false }]);
    expect(manager.hasPending()).toBe(false);

    // Empty queue afterwards is a no-op, not a crash.
    expect(cancelPendingApproval()).toBe(false);
  });

  it("T3.6: Ctrl+C promotes the next queued approval instead of losing it", async () => {
    const manager = getPermissionInterruptManager();
    const outcomes: boolean[] = [];

    const first = requestApprovalModal({ toolName: "shell", args: {}, reason: "first ask" });
    const second = requestApprovalModal({ toolName: "shell", args: {}, reason: "second ask" });
    void first.then((ok) => outcomes.push(ok));
    void second.then((ok) => outcomes.push(ok));
    await new Promise((r) => setTimeout(r, 5));

    expect(manager.pendingCount).toBe(2);
    expect(tuiState.pendingConfirmation?.prompt).toBe("first ask");

    // Abort during the first dialog denies it…
    expect(cancelPendingApproval()).toBe(true);
    await new Promise((r) => setTimeout(r, 5));

    // …and the FIFO queue promotes the second ask to the screen.
    expect(manager.pendingCount).toBe(1);
    expect(tuiState.pendingConfirmation?.prompt).toBe("second ask");

    // The user can still answer the promoted dialog normally.
    expect(tuiState.pendingConfirmation?.onDecision).toBeDefined();
    tuiState.pendingConfirmation!.onDecision!("n");
    tuiState.pendingConfirmation!.resolve(false);
    await second;
    await first;
    expect(outcomes).toEqual([false, false]);
    expect(manager.hasPending()).toBe(false);
  });

  it("T3.7: abort during pending permission never leaves the manager with silent residue", async () => {
    const manager = getPermissionInterruptManager();
    let denied = false;

    const p = requestApprovalModal({ toolName: "edit", args: {}, reason: "deny-me" });
    void p.then(() => undefined).catch(() => undefined);
    void p.then((approved) => {
      denied = !approved;
    });
    await new Promise((r) => setTimeout(r, 5));

    cancelPendingApproval();
    await new Promise((r) => setTimeout(r, 5));

    expect(denied).toBe(true);
    expect(manager.pendingCount).toBe(0);
    expect(tuiState.pendingConfirmation).toBeNull();
  });

  it("T3.8: reply choice taxonomy covers every dialog key with explicit semantics", async () => {
    const manager = getPermissionInterruptManager();
    const received: PermissionChoice[] = [];

    const req = {
      id: "taxonomy-1",
      tool: "shell",
      args: {},
      reason: "choice taxonomy",
      resolve: () => undefined,
      reject: () => undefined,
    };
    manager.enqueue({
      ...req,
      resolve: (approved: boolean) => {
        received.push(approved ? "yes" : "no");
      },
      reject: () => undefined,
    });

    // Deny choice: resolved false, dequeued after ack.
    await manager.replyCurrent("no");
    expect(received).toEqual(["no"]);
    expect(manager.pendingCount).toBe(0);

    // Approve + always choices both resolve true.
    for (const choice of ["yes", "always"] as PermissionChoice[]) {
      manager.enqueue({
        ...req,
        id: `taxonomy-${choice}`,
        resolve: (approved: boolean) => {
          received.push(approved ? "yes" : "no");
        },
      });
      await manager.replyCurrent(choice);
      expect(received[received.length - 1]).toBe("yes");
    }
    expect(manager.pendingCount).toBe(0);
  });
});
