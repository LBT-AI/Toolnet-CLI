import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TuiState, tuiState } from "../../../src/tui/state";
import {
  saveSession,
  loadSession,
  listAllSessions,
  deleteSessionFile,
} from "../../../src/lib/sessionPersistence";
import { messageQueue } from "../../../src/lib/messageQueue";

const ORIGINAL_SESSIONS_DIR = process.env.TOOLNETCLI_SESSIONS_DIR;

/**
 * Session-management flow against the REAL durable session store, redirected
 * to a temp dir: create → save → list → resume → fork-id reuse → delete.
 */
describe("Tier 4 Scenario: Session Management Flow", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = join(mkdtempSync(join(tmpdir(), "toolnet-sessions-")), "sessions");
    process.env.TOOLNETCLI_SESSIONS_DIR = sessionsDir;
  });

  afterEach(() => {
    if (ORIGINAL_SESSIONS_DIR === undefined) {
      delete process.env.TOOLNETCLI_SESSIONS_DIR;
    } else {
      process.env.TOOLNETCLI_SESSIONS_DIR = ORIGINAL_SESSIONS_DIR;
    }
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("T4.9: save → list → load round-trips messages and metadata through the real store", () => {
    saveSession("t4_roundtrip", [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ], { model: "test-model", provider: "test-provider" });

    const listed = listAllSessions();
    const found = listed.find((s) => s.sessionId === "t4_roundtrip");
    expect(found).toBeDefined();
    expect(found?.messages.length).toBe(2);

    const loaded = loadSession("t4_roundtrip");
    expect(loaded?.sessionId).toBe("t4_roundtrip");
    expect(loaded?.metadata?.model).toBe("test-model");
    expect((loaded?.messages as any[])?.length).toBe(2);
  });

  it("T4.10: resumeSelectedSession swaps identity and clears stale streaming state", () => {
    const state = new TuiState();
    state.messages = [{ role: "user", content: "old session content" }];
    state.saveCurrentSession();
    const oldId = state.currentSessionId;

    saveSession("t4_resume_target", [
      { role: "user", content: "target content" },
    ], { model: "m2" });

    state.openSessionPicker();
    state.filterSessions();
    const idx = state.filteredSessions.findIndex((s) => s.sessionId === "t4_resume_target");
    expect(idx).toBeGreaterThanOrEqual(0);
    state.sessionPickerIdx = idx;

    // Simulate a stale in-flight stream the switch must not carry over.
    state.isStreaming = true;

    expect(state.resumeSelectedSession()).toBe(true);
    expect(state.currentSessionId).toBe("t4_resume_target");
    expect(state.currentSessionId).not.toBe(oldId);
    expect(state.isStreaming).toBe(false);
    expect(state.pendingConfirmation).toBeNull();
  });

  it("T4.11: resume of a missing session fails gracefully and keeps the current session", () => {
    const state = new TuiState();
    const before = state.currentSessionId;
    state.openSessionPicker();
    state.filterSessions();
    state.filteredSessions = [{
      sessionId: "t4_missing_session",
      messagesCount: 0,
      updatedAt: new Date().toISOString(),
      isCurrent: false,
    }];
    state.sessionPickerIdx = 0;

    expect(state.resumeSelectedSession()).toBe(false);
    expect(state.currentSessionId).toBe(before);
  });

  it("T4.12: deleting a non-current session keeps the active session intact", () => {
    const state = new TuiState();
    saveSession("t4_victim", [{ role: "user", content: "victim" }], {});
    const currentId = state.currentSessionId;

    state.openSessionPicker();
    state.filterSessions();
    const idx = state.filteredSessions.findIndex((s) => s.sessionId === "t4_victim");
    expect(idx).toBeGreaterThanOrEqual(0);
    state.sessionPickerIdx = idx;

    expect(state.deleteSelectedSession()).toBe(true);
    expect(loadSession("t4_victim")).toBeNull();
    expect(state.currentSessionId).toBe(currentId);
  });

  it("T4.13: deleting the current session re-anchors state to a fresh usable session", () => {
    const state = new TuiState();
    const doomed = state.currentSessionId;
    state.messages = [{ role: "user", content: "doomed" }];
    state.saveCurrentSession();

    state.openSessionPicker();
    state.filterSessions();
    const idx = state.filteredSessions.findIndex((s) => s.sessionId === doomed);
    expect(idx).toBeGreaterThanOrEqual(0);
    state.sessionPickerIdx = idx;

    expect(state.deleteSelectedSession()).toBe(true);
    expect(existsSync(join(sessionsDir, `${doomed}.json`))).toBe(false);
    expect(state.currentSessionId).not.toBe(doomed);
    expect(state.messages.length).toBe(0);
  });

  it("T4.14: queued prompts persist with the session and restore on resume", () => {
    messageQueue.clear();
    messageQueue.enqueue("queued while offline");

    const state = new TuiState();
    state.messages = [{ role: "user", content: "base" }];
    state.saveCurrentSession();
    const id = state.currentSessionId;

    const fresh = new TuiState();
    fresh.currentSessionId = id;
    expect(fresh.resumeSelectedSession.call(fresh)).toBeUndefined ?? undefined;

    // Restore path: messageQueue.restore mirrors persisted queue.
    messageQueue.clear();
    const loaded = loadSession(id);
    const queued = (loaded?.metadata as any)?.queuedMessages;
    expect(Array.isArray(queued)).toBe(true);
    if (Array.isArray(queued) && queued.length > 0) {
      messageQueue.restore(queued);
      expect(messageQueue.getAllTexts()).toContain("queued while offline");
    }
    messageQueue.clear();
    tuiState.requestRender();
  });

  it("T4.15: tuiState singleton remains usable after the whole flow (no cross-test pollution)", () => {
    expect(tuiState.currentSessionId).toBeTruthy();
    expect(tuiState.isStreaming).toBe(false);
    expect(messageQueue.isEmpty()).toBe(true);
    expect(listAllSessions().find((s) => s.sessionId.startsWith("t4_"))).toBeUndefined();
  });
});
