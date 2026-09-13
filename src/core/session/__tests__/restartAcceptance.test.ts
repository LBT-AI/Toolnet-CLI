/**
 * Real restart acceptance.
 *
 * Three separate OS processes against one sessions directory:
 *
 *   1. create a session, checkpoint it, durably start a tool, then die
 *      (no release, no terminal event — the crash shape);
 *   2. a NEW process resumes it: the run must come back interrupted, the tool
 *      with an unknown outcome, and the transcript intact;
 *   3. a THIRD process confirms the continuation persisted exactly once — the
 *      interrupted tool was never replayed into a fabricated result.
 *
 * Nothing is mocked: each step is a real `bun` process using the production
 * store, so this covers the actual durability boundary rather than an in-process
 * simulation of it.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const STORE_ENTRY = path.join(ROOT, "src", "core", "session", "index.ts");

let tmpDir: string;

function runScript(code: string, env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["-e", code], {
    cwd: ROOT,
    env: {
      ...process.env,
      TOOLNETCLI_SESSIONS_DIR: tmpDir,
      TOOLNETCLI_CONFIG_DIR: tmpDir,
      ...env,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-session-restart-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("durable session restart", () => {
  test("a crashed run resumes as interrupted and continues without duplicating side effects", () => {
    // ── Process 1: create, checkpoint, start a mutating tool, crash ──────────
    const createScript = `
      const { sessionStore } = await import(${JSON.stringify(STORE_ENTRY)});
      const record = sessionStore.create({ title: "restart-acceptance" });
      sessionStore.save(
        record.id,
        [{ role: "user", content: "apply the fix" }],
        undefined,
        { status: "running", model: "anthropic/claude", provider: "openrouter", authProfileId: "openrouter/work", harness: "coding" },
      );
      sessionStore.appendSessionEvent(record.id, "tool.started", { callId: "t1", name: "edit_file" });
      process.stdout.write(record.id);
    `;
    const created = runScript(createScript, {});
    expect(created.status).toBe(0);
    const sessionId = created.stdout.trim();
    expect(sessionId).toMatch(/^sess_/);

    // The crash left the record claiming an active run with no terminal event.
    const recordPath = path.join(tmpDir, `${sessionId}.json`);
    expect(fs.existsSync(recordPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(recordPath, "utf8")).status).toBe("running");

    // ── Process 2: resume in a fresh process ────────────────────────────────
    const resumeScript = `
      const { sessionStore } = await import(${JSON.stringify(STORE_ENTRY)});
      const id = process.env.SESSION_ID;
      const resumed = sessionStore.resume(id, {});
      sessionStore.markInterrupted(id);
      process.stdout.write(JSON.stringify({
        status: resumed.status,
        messages: resumed.transcript.map((m) => m.role + ":" + m.content),
        interrupted: resumed.interruptedTools.map((t) => t.name),
        identity: resumed.identity,
        replayed: resumed.replayedEvents,
        warnings: resumed.warnings,
      }));
      // Continue the task in this process: append the next turn, then persist.
      sessionStore.appendSessionEvent(id, "assistant.message", { content: "fix applied" });
      sessionStore.save(
        id,
        resumed.transcript.concat([{ role: "assistant", content: "fix applied" }]),
        undefined,
        { status: "completed" },
      );
    `;
    const resumed = runScript(resumeScript, { SESSION_ID: sessionId });
    expect(resumed.status).toBe(0);
    const report = JSON.parse(resumed.stdout);

    expect(report.status).toBe("interrupted");
    expect(report.interrupted).toEqual(["edit_file"]);
    expect(report.identity.authProfileId).toBe("openrouter/work");
    expect(report.identity.model).toBe("anthropic/claude");
    expect(report.identity.harness).toBe("coding");
    // The interrupted tool produced no fabricated tool result.
    expect(report.messages.some((m: string) => m.startsWith("tool:"))).toBe(false);
    expect(report.warnings.join(" ")).toContain("interrupted");

    // ── Process 3: verify the continuation persisted exactly once ───────────
    const verifyScript = `
      const { sessionStore } = await import(${JSON.stringify(STORE_ENTRY)});
      const record = sessionStore.load(process.env.SESSION_ID);
      process.stdout.write(JSON.stringify({
        status: record.status,
        messages: record.messages.map((m) => m.role + ":" + m.content),
        checkpoint: record.checkpointHead,
      }));
    `;
    const verified = runScript(verifyScript, { SESSION_ID: sessionId });
    expect(verified.status).toBe(0);
    const final = JSON.parse(verified.stdout);

    expect(final.status).toBe("completed");
    expect(final.messages).toEqual(["user:apply the fix", "assistant:fix applied"]);
    // Exactly one user turn: the resumed transcript was not appended twice, and
    // the interrupted write was never replayed as a second side effect.
    expect(final.messages.filter((m: string) => m === "user:apply the fix").length).toBe(1);
    expect(final.checkpoint).toBeTruthy();
  });

  test("a second process refuses to resume a session held by a live owner", () => {
    const holdScript = `
      const { sessionStore } = await import(${JSON.stringify(STORE_ENTRY)});
      const record = sessionStore.create({ title: "locked" });
      sessionStore.save(record.id, [{ role: "user", content: "held" }]);
      sessionStore.acquire(record.id);
      process.stdout.write(record.id);
      // Stay alive briefly so the other process observes a live lock.
      await new Promise((r) => setTimeout(r, 2500));
    `;
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["-e", holdScript], {
      cwd: ROOT,
      env: { ...process.env, TOOLNETCLI_SESSIONS_DIR: tmpDir, TOOLNETCLI_CONFIG_DIR: tmpDir },
      stdio: ["ignore", "pipe", "pipe"],
    });

    return new Promise<void>((resolve, reject) => {
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const sessionId = stdout.trim();
        if (!sessionId.startsWith("sess_")) return;
        try {
          const attemptScript = `
            const { sessionStore } = await import(${JSON.stringify(STORE_ENTRY)});
            try {
              sessionStore.acquire(process.env.SESSION_ID);
              process.stdout.write("ACQUIRED");
            } catch (error) {
              process.stdout.write("LOCKED:" + (error && error.code));
            }
          `;
          const attempt = runScript(attemptScript, { SESSION_ID: sessionId });
          expect(attempt.stdout).toBe("LOCKED:SESSION_LOCKED");
          child.kill();
          resolve();
        } catch (error) {
          child.kill();
          reject(error);
        }
      });
      child.on("error", reject);
      child.on("exit", () => resolve());
    });
  });
});
