import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  saveSession,
  loadSession,
  getLastSessionId,
  parseSessionArgs,
  getSessionsDir,
  listAllSessions,
  deleteSessionFile,
  renameSessionFile,
  createNewSession
} from "../../lib/sessionPersistence";

describe("Session Persistence Tests", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-test-sessions-"));
    process.env.TOOLNETCLI_SESSIONS_DIR = testDir;
  });

  afterEach(() => {
    delete process.env.TOOLNETCLI_SESSIONS_DIR;
    delete process.env.TOOLNETAPI_SESSIONS_DIR;
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("getSessionsDir respects TOOLNETCLI_SESSIONS_DIR environment variable and defaults to .toolnetcli", () => {
    expect(getSessionsDir()).toBe(testDir);
    const savedDataDir = process.env.DATA_DIR;
    delete process.env.DATA_DIR;
    delete process.env.TOOLNETCLI_SESSIONS_DIR;
    expect(getSessionsDir()).toBe(path.join(os.homedir(), ".toolnetcli", "sessions"));
    if (savedDataDir) process.env.DATA_DIR = savedDataDir;
    process.env.TOOLNETCLI_SESSIONS_DIR = testDir;
  });

  test("saveSession saves session messages and metadata to JSON file", () => {
    const sessionId = "session_test_001";
    const messages = [
      { role: "user", content: "Hello AI" },
      {
        role: "assistant",
        content: "Running tool...",
        tool_calls: [{ id: "tc_1", type: "function", function: { name: "search", arguments: "{}" } }]
      },
      { role: "tool", tool_call_id: "tc_1", name: "search", content: "Result data" }
    ];
    const metadata = { model: "gpt-4o", agentMode: "Build" };

    saveSession(sessionId, messages, metadata);

    const filePath = path.join(testDir, `${sessionId}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    expect(data.sessionId).toBe(sessionId);
    expect(data.messages.length).toBe(3);
    expect(data.messages[0]).toEqual({ role: "user", content: "Hello AI" });
    expect(data.messages[1].tool_calls).toEqual([{ id: "tc_1", type: "function", function: { name: "search", arguments: "{}" } }]);
    expect(data.messages[2]).toEqual({ role: "tool", tool_call_id: "tc_1", name: "search", content: "Result data" });
    expect(data.metadata).toMatchObject(metadata);
  });

  test("loadSession loads an existing session and handles non-existent session", () => {
    const sessionId = "session_test_002";
    const messages = [{ role: "user", content: "Test query" }];

    saveSession(sessionId, messages);

    const loaded = loadSession(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded?.sessionId).toBe(sessionId);
    expect(loaded?.messages.length).toBe(1);
    expect(loaded?.messages[0].content).toBe("Test query");

    const nonExistent = loadSession("non_existent_id");
    expect(nonExistent).toBeNull();
  });

  test("getLastSessionId returns the last saved session", () => {
    expect(getLastSessionId()).toBeNull();

    saveSession("session_a", [{ role: "user", content: "A" }]);
    expect(getLastSessionId()).toBe("session_a");

    saveSession("session_b", [{ role: "user", content: "B" }]);
    expect(getLastSessionId()).toBe("session_b");
  });

  test("getLastSessionId falls back to newest JSON file if last_session.txt is missing", () => {
    saveSession("session_old", [{ role: "user", content: "Old" }]);
    saveSession("session_new", [{ role: "user", content: "New" }]);

    const lastSessionFile = path.join(testDir, "last_session.txt");
    if (fs.existsSync(lastSessionFile)) {
      fs.unlinkSync(lastSessionFile);
    }

    const lastId = getLastSessionId();
    expect(lastId).not.toBeNull();
    expect(["session_old", "session_new"].includes(lastId!)).toBe(true);
  });

  test("parseSessionArgs correctly parses command line flags", () => {
    expect(parseSessionArgs([])).toEqual({ resume: false, sessionId: undefined });
    expect(parseSessionArgs(["--resume"])).toEqual({ resume: true, sessionId: undefined });
    expect(parseSessionArgs(["--session", "sess_123"])).toEqual({ resume: false, sessionId: "sess_123" });
    expect(parseSessionArgs(["--session=sess_456"])).toEqual({ resume: false, sessionId: "sess_456" });
    expect(parseSessionArgs(["--resume", "--session", "sess_789"])).toEqual({ resume: true, sessionId: "sess_789" });
  });

  test("listAllSessions, deleteSessionFile, renameSessionFile, and createNewSession operate on disk", () => {
    const s1 = createNewSession("First Session");
    expect(s1.sessionId).toBeTruthy();
    expect(s1.metadata?.name).toBe("First Session");

    saveSession(s1.sessionId, [{ role: "user", content: "Hello" }], s1.metadata);

    const s2 = createNewSession("Second Session");
    saveSession(s2.sessionId, [{ role: "user", content: "World" }], s2.metadata);

    const all = listAllSessions().filter(s => s.sessionId === s1.sessionId || s.sessionId === s2.sessionId);
    expect(all.length).toBe(2);

    const renamed = renameSessionFile(s1.sessionId, "Renamed Session");
    expect(renamed).toBe(true);
    const loadedRenamed = loadSession(s1.sessionId);
    expect(loadedRenamed?.metadata?.name).toBe("Renamed Session");

    const deleted = deleteSessionFile(s2.sessionId);
    expect(deleted).toBe(true);
    expect(loadSession(s2.sessionId)).toBeNull();
    const remaining = listAllSessions().filter(s => s.sessionId === s1.sessionId || s.sessionId === s2.sessionId);
    expect(remaining.length).toBe(1);
  });
});
