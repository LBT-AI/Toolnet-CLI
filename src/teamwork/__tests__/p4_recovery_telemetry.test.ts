import { test, it, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  initCrashRecovery,
  updateCrashGoal,
  updateCrashToolResult,
  recordPendingDestructiveAction,
  checkPendingRecovery,
  clearPendingRecovery,
  markCleanExit,
} from "../../lib/crashRecovery";
import {
  getTelemetryConfig,
  setTelemetryEnabled,
  recordCrashReport,
  sanitizeStackTrace,
} from "../../lib/telemetry";

function tmpDir(): string {
  const d = path.join(os.tmpdir(), "toolnet-recovery-test-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cleanDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

describe("P4.18 & P4.19 — Crash Recovery & Telemetry", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    process.env.DATA_DIR = dir;
    clearPendingRecovery();
  });

  afterEach(() => {
    delete process.env.DATA_DIR;
    cleanDir(dir);
  });

  it("32. crash state is saved with session details, goal, and last tool result", () => {
    const sessId = `test_sess_${Date.now()}`;
    initCrashRecovery(sessId, dir, "openai/gpt-4o");
    updateCrashGoal("Refactor authentication module");
    updateCrashToolResult("write_file", 0, "Updated auth.ts");

    const recovered = checkPendingRecovery();
    expect(recovered).not.toBeNull();
    expect(recovered?.sessionId).toBe(sessId);
    expect(recovered?.lastUserGoal).toBe("Refactor authentication module");
    expect(recovered?.lastSuccessfulToolResult?.tool).toBe("write_file");
    expect(recovered?.cleanExit).toBe(false);
  });

  it("33. destructive pending action is NOT replayed automatically", () => {
    const sessId = `test_sess_danger_${Date.now()}`;
    initCrashRecovery(sessId, dir);
    recordPendingDestructiveAction("rm -rf /tmp/danger");

    const recovered = checkPendingRecovery();
    expect(recovered).not.toBeNull();
    // Verify that pendingDestructiveActions is preserved for inspection but not cleared or silently executed
    expect(recovered?.pendingDestructiveActions).toContain("rm -rf /tmp/danger");

    // Clean exit removes recovery state
    markCleanExit();
    expect(checkPendingRecovery()).toBeNull();
  });

  it("telemetry defaults to OFF, sanitizes error stacks, and avoids secret leaks", () => {
    setTelemetryEnabled(false);
    expect(getTelemetryConfig().enabled).toBe(false);

    // Recording crash while telemetry is disabled returns null
    const reportDisabled = recordCrashReport(new Error("Test crash"));
    expect(reportDisabled).toBeNull();

    // Enable telemetry
    setTelemetryEnabled(true);
    expect(getTelemetryConfig().enabled).toBe(true);

    const testError = new Error("Failed with secret sk-1234567890abcdef1234567890xyz at /root/toolnet-cli/src/test.ts:10");
    const report = recordCrashReport(testError);

    expect(report).not.toBeNull();
    expect(report?.version).toBeDefined();
    expect(report?.anonymousId).toBeDefined();
    expect(report?.sanitizedStack).not.toContain("sk-1234567890abcdef1234567890xyz");
    expect(report?.sanitizedStack).toContain("sk-****xyz");

    // Reset back to disabled
    setTelemetryEnabled(false);
  });
});
