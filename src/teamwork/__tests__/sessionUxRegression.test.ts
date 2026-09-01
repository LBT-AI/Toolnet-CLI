import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  saveSession,
  loadSession,
  listAllSessions,
  deleteSessionFile,
  createNewSession,
  parseSessionArgs,
  formatExitMessage,
} from "../../lib/sessionPersistence";
import { tuiState } from "../../tui/state";
import { handleKey } from "../../tui/input/inputHandler";
import { sessionCommand } from "../../commands/session";
import { messageQueue } from "../../lib/messageQueue";
import { renderSessionPickerBox } from "../../tui/renderers/sessionPickerRenderer";
import { stripAnsi } from "../../tui/layout";

function tmpDir(): string {
  const d = path.join(os.tmpdir(), "toolnet-session-ux-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe("Session UX & Interactive Manager Regression Suite", () => {
  let tmpConfigDir: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    origEnv = { ...process.env };
    tmpConfigDir = tmpDir();
    process.env.TOOLNETCLI_SESSIONS_DIR = path.join(tmpConfigDir, "sessions");
    process.env.DATA_DIR = tmpConfigDir;

    messageQueue.clear();
    messageQueue.setIsProcessing(false);

    tuiState.messages = [];
    tuiState.isStreaming = false;
    tuiState.showSessionPicker = false;
    tuiState.sessionPickerIdx = 0;
    tuiState.sessionSearchQuery = "";
    tuiState.inputBuffer = "";
    tuiState.cursorPos = 0;
    tuiState.currentSessionId = `sess_test_${Date.now()}`;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    } catch {}
    delete process.env.TOOLNETCLI_SESSIONS_DIR;
    delete process.env.DATA_DIR;
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) {
        delete process.env[k];
      }
    }
    Object.assign(process.env, origEnv);
  });

  it("1. New session gets a stable persistent ID and not a temporary turbo ID", () => {
    const s = createNewSession("Feature Auth");
    expect(s.sessionId).toMatch(/^sess_\d+_[a-f0-9]+$/);
    expect(s.sessionId).not.toContain("turbo-");
    expect(s.metadata?.name).toBe("Feature Auth");

    const loaded = loadSession(s.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded?.sessionId).toBe(s.sessionId);
  });

  it("2. Exit formats exact resume command when session has content", () => {
    const msg = formatExitMessage("sess_1772429481234_abc123", true);
    expect(msg).toContain("Session saved.");
    expect(msg).toContain("Resume with:");
    expect(msg).toContain("toolnet resume sess_1772429481234_abc123");
    expect(msg).toContain("Goodbye!");
  });

  it("3. Empty session does not print fake resume command on exit", () => {
    const msg = formatExitMessage("sess_1772429481234_abc123", false);
    expect(msg.trim()).toBe("Goodbye!");
    expect(msg).not.toContain("Resume with:");
    expect(msg).not.toContain("Session saved.");
  });

  it("4. Temporary turbo IDs are not treated as resumable sessions", () => {
    // formatExitMessage for turbo ID
    const msg = formatExitMessage("turbo-request-9999", true);
    expect(msg.trim()).toBe("Goodbye!");
    expect(msg).not.toContain("Resume with:");

    // save turbo file
    saveSession("turbo-req-temp", [{ role: "user", content: "temp prompt" }]);
    const sessions = listAllSessions();
    const foundTurbo = sessions.find(s => s.sessionId.startsWith("turbo-"));
    expect(foundTurbo).toBeUndefined();
  });

  it("5. parseSessionArgs correctly parses positional 'toolnet resume <id>' and flags", () => {
    expect(parseSessionArgs(["resume", "sess_custom_456"])).toEqual({
      resume: true,
      sessionId: "sess_custom_456",
    });

    expect(parseSessionArgs(["resume"])).toEqual({
      resume: true,
      sessionId: undefined,
    });

    expect(parseSessionArgs(["--resume"])).toEqual({
      resume: true,
      sessionId: undefined,
    });

    expect(parseSessionArgs(["--session", "sess_flag_789"])).toEqual({
      resume: false,
      sessionId: "sess_flag_789",
    });

    expect(parseSessionArgs(["--session=sess_eq_101"])).toEqual({
      resume: false,
      sessionId: "sess_eq_101",
    });
  });

  it("6. listAllSessions returns sessions sorted newest first with metadata", () => {
    const s1 = `sess_${Date.now() - 10000}_1`;
    const s2 = `sess_${Date.now() - 5000}_2`;
    const s3 = `sess_${Date.now()}_3`;

    saveSession(s1, [{ role: "user", content: "Oldest task" }], { model: "gpt-4o", provider: "toolnet" });
    saveSession(s2, [{ role: "user", content: "Middle task" }], { model: "claude-3-5", provider: "anthropic" });
    saveSession(s3, [{ role: "user", content: "Newest task" }], { model: "gemini-2.5", provider: "google" });

    // Set distinct updatedAt timestamps to verify newest-first sorting
    const dir = process.env.TOOLNETCLI_SESSIONS_DIR!;
    const f1 = JSON.parse(fs.readFileSync(path.join(dir, `${s1}.json`), "utf8"));
    f1.updatedAt = new Date(Date.now() - 100000).toISOString();
    fs.writeFileSync(path.join(dir, `${s1}.json`), JSON.stringify(f1));

    const f2 = JSON.parse(fs.readFileSync(path.join(dir, `${s2}.json`), "utf8"));
    f2.updatedAt = new Date(Date.now() - 50000).toISOString();
    fs.writeFileSync(path.join(dir, `${s2}.json`), JSON.stringify(f2));

    const f3 = JSON.parse(fs.readFileSync(path.join(dir, `${s3}.json`), "utf8"));
    f3.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(dir, `${s3}.json`), JSON.stringify(f3));

    const list = listAllSessions();
    expect(list.length).toBe(3);
    // Newest first order
    expect(list[0].sessionId).toBe(s3);
    expect(list[1].sessionId).toBe(s2);
    expect(list[2].sessionId).toBe(s1);
  });

  it("7. Interactive session picker allows navigation, search filter, resume, and delete", () => {
    const s1 = `sess_${Date.now() - 5000}_alpha`;
    const s2 = `sess_${Date.now()}_beta`;
    saveSession(s1, [{ role: "user", content: "Build login" }], { model: "gpt-4o", provider: "toolnet", workspace: "/root/frontend" });
    saveSession(s2, [{ role: "user", content: "Fix database bug" }], { model: "claude-3-5", provider: "anthropic", workspace: "/root/backend" });

    // Open session picker
    tuiState.openSessionPicker();
    expect(tuiState.showSessionPicker).toBe(true);
    expect(tuiState.availableSessions.length).toBe(2);
    expect(tuiState.filteredSessions.length).toBe(2);

    const cb = { renderAll: () => {} };

    // Search filter: type "alpha"
    handleKey("alpha", cb);
    expect(tuiState.sessionSearchQuery).toBe("alpha");
    expect(tuiState.filteredSessions.length).toBe(1);
    expect(tuiState.filteredSessions[0].sessionId).toBe(s1);

    // Press Enter to resume s1
    handleKey(Buffer.from("0d", "hex"), cb);
    expect(tuiState.showSessionPicker).toBe(false);
    expect(tuiState.currentSessionId).toBe(s1);
    expect(tuiState.currentModel).toBe("gpt-4o");
    expect(tuiState.messages.length).toBe(1);
    expect(tuiState.messages[0].content).toBe("Build login");

    // Open picker again and delete index 0 (which is s1 after resume and save)
    tuiState.openSessionPicker();
    tuiState.sessionSearchQuery = "";
    tuiState.filterSessions();
    expect(tuiState.filteredSessions.length).toBe(2);

    // Press Delete ('d')
    handleKey("d", cb);
    expect(loadSession(s1)).toBeNull(); // s1 was deleted
    expect(tuiState.availableSessions.length).toBe(1);
    expect(loadSession(s2)).not.toBeNull(); // s2 remains

    // Esc closes picker
    handleKey(Buffer.from("1b", "hex"), cb);
    expect(tuiState.showSessionPicker).toBe(false);
  });

  it("8. /session current outputs structured session information without duplicate id lines", async () => {
    const sId = `sess_info_test_${Date.now()}`;
    tuiState.currentSessionId = sId;
    tuiState.currentModel = "openai/gpt-4o";
    tuiState.providerName = "toolnet";
    tuiState.messages = [
      { role: "user", content: "Check system health" },
      { role: "assistant", content: "All systems nominal." },
    ];
    messageQueue.enqueue("Subsequent queued task");
    tuiState.saveCurrentSession();

    let output = "";
    const ctx: any = {
      getCurrentSessionId: () => tuiState.currentSessionId,
      currentModel: () => tuiState.currentModel,
      provider: { name: "toolnet" },
      addMessage: (_role: string, msg: string) => {
        output += msg + "\n";
      },
    };

    await sessionCommand.handler(["current"], ctx);
    const stripped = stripAnsi(output);
    expect(stripped).toContain("Session Details");
    expect(stripped).toContain(`Session ID:    ${sId}`);
    expect(stripped).toContain("Provider:      toolnet");
    expect(stripped).toContain("Model:         openai/gpt-4o");
    expect(stripped).toContain("Messages:      2");
    expect(stripped).toContain("Queued tasks:  1");
    expect(stripped).toContain("toolnet resume " + sId);

    // Verify non-interactive list does NOT duplicate id line
    output = "";
    await sessionCommand.handler(["list"], ctx);
    const listStripped = stripAnsi(output);
    expect(listStripped).toContain("Sessions (1)");
    expect(listStripped).toContain(sId);
    expect(listStripped).not.toContain("id: " + sId); // No duplicate id: line
  });

  it("9. Queue and messages persist cleanly across session save and resume", () => {
    const sId = `sess_queue_persist_${Date.now()}`;
    tuiState.currentSessionId = sId;
    tuiState.messages = [{ role: "user", content: "Run analysis" }];
    messageQueue.enqueue("Step 1");
    messageQueue.enqueue("Step 2");
    tuiState.saveCurrentSession();

    // Reset memory state
    tuiState.messages = [];
    messageQueue.clear();
    tuiState.currentSessionId = "sess_other";

    // Switch/resume back to sId
    const loaded = loadSession(sId);
    expect(loaded).not.toBeNull();
    tuiState.currentSessionId = loaded!.sessionId;
    tuiState.messages = loaded!.messages as any;
    messageQueue.restore(loaded!.metadata?.queuedMessages);

    expect(tuiState.messages.length).toBe(1);
    expect(tuiState.messages[0].content).toBe("Run analysis");
    expect(messageQueue.size()).toBe(2);
    expect(messageQueue.getAllTexts()).toEqual(["Step 1", "Step 2"]);
  });

  it("10. renderSessionPickerBox renders without ANSI overflow and includes current badge", () => {
    const curId = `sess_ui_curr_${Date.now()}`;
    const box = renderSessionPickerBox(90, 20, {
      filteredSessions: [
        {
          sessionId: curId,
          model: "openai/gpt-4o",
          provider: "toolnet",
          messagesCount: 10,
          updatedAt: new Date().toISOString(),
          isCurrent: true,
          workspace: process.cwd(),
        },
      ],
      sessionPickerIdx: 0,
      sessionSearchQuery: "",
      currentSessionId: curId,
      currentWorkspace: process.cwd(),
    });

    const stripped = stripAnsi(box);
    expect(stripped).toContain("Sessions (1 session)");
    expect(stripped).toContain(curId);
    expect(stripped).toContain("(current)");
    expect(stripped).toContain("10 msgs");
    expect(stripped).toContain("Enter Resume");
  });
});
