import { describe, it, expect } from "bun:test";
import { MockSessionStore } from "../harness/mockSessionStore";

describe("Tier 1 Feature Coverage: Session Lifecycle UX", () => {
  it("F11.1: Session listing returns lightweight summaries without hydrating full transcripts", () => {
    const store = new MockSessionStore();
    const list = store.listSummaries();

    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const item of list) {
      expect(item.id).toBeDefined();
      expect(item.title).toBeDefined();
      expect(item.updatedAt).toBeDefined();
      expect(item.messageCount).toBeDefined();
      // Should not contain heavy full transcript payload in summary
      expect((item as any).transcript).toBeUndefined();
    }
  });

  it("F11.2: Session rename updates title and updatedAt timestamp", () => {
    const store = new MockSessionStore();
    const original = store.getSession("session-alpha");
    expect(original).not.toBeNull();

    const success = store.renameSession("session-alpha", "Renamed Alpha Session");
    expect(success).toBe(true);

    const updated = store.getSession("session-alpha");
    expect(updated?.title).toBe("Renamed Alpha Session");
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(original!.updatedAt);
  });

  it("F11.3: Session fork creates child session preserving history and linking parent id", () => {
    const store = new MockSessionStore();
    const forked = store.forkSession("session-alpha", "session-alpha-fork", "Forked Branch 1");

    expect(forked).not.toBeNull();
    expect(forked?.id).toBe("session-alpha-fork");
    expect(forked?.forkedFrom).toBe("session-alpha");
    expect(forked?.messageCount).toBe(12);

    const list = store.listSummaries();
    expect(list.some((s) => s.id === "session-alpha-fork")).toBe(true);
  });

  it("F11.4: Session deletion removes session from store", () => {
    const store = new MockSessionStore();
    const existsBefore = store.getSession("session-beta");
    expect(existsBefore).not.toBeNull();

    const deleted = store.deleteSession("session-beta");
    expect(deleted).toBe(true);

    const existsAfter = store.getSession("session-beta");
    expect(existsAfter).toBeNull();
  });

  it("F11.5: Delete confirmation workflow guards against accidental session destruction", () => {
    let confirmPromptOpen = false;
    let targetSessionToDelete: string | null = null;

    function requestDeleteSession(sessionId: string) {
      targetSessionToDelete = sessionId;
      confirmPromptOpen = true;
    }

    function confirmDelete(confirmed: boolean, store: MockSessionStore): boolean {
      if (!confirmPromptOpen || !targetSessionToDelete) return false;
      let res = false;
      if (confirmed) {
        res = store.deleteSession(targetSessionToDelete);
      }
      confirmPromptOpen = false;
      targetSessionToDelete = null;
      return res;
    }

    const store = new MockSessionStore();
    requestDeleteSession("session-alpha");
    expect(confirmPromptOpen).toBe(true);

    // Cancel deletion
    const cancelled = confirmDelete(false, store);
    expect(cancelled).toBe(false);
    expect(store.getSession("session-alpha")).not.toBeNull();

    // Confirm deletion
    requestDeleteSession("session-alpha");
    const confirmed = confirmDelete(true, store);
    expect(confirmed).toBe(true);
    expect(store.getSession("session-alpha")).toBeNull();
  });
});
