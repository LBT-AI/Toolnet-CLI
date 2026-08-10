import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  restoreTerminal,
  getIsRestored,
  resetTerminalState,
  isRestored,
  writeCrashLog,
  wrapErrorBoundary
} from "../../lib/terminalLifecycle";
import { T, A } from "../../term";

describe("Terminal Lifecycle Management & Cleanup Tests", () => {
  let stdoutSpy: any;

  beforeEach(() => {
    resetTerminalState();
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  test("restoreTerminal() is idempotent (5 consecutive calls throw zero errors & sets isRestored = true)", () => {
    expect(getIsRestored()).toBe(false);
    expect(isRestored).toBe(false);

    // Call restoreTerminal 5 times consecutively
    expect(() => {
      for (let i = 0; i < 5; i++) {
        restoreTerminal();
      }
    }).not.toThrow();

    // Verify isRestored is set to true
    expect(getIsRestored()).toBe(true);
    expect(isRestored).toBe(true);

    // Verify terminal write sequence occurred exactly ONCE despite 5 calls
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
  });

  test("Crash log creation when an uncaught exception is thrown", () => {
    const testError = new Error("Uncaught exception test trigger");
    const logPath = writeCrashLog(testError, "uncaughtException");

    expect(typeof logPath).toBe("string");
    expect(logPath.length).toBeGreaterThan(0);
    expect(fs.existsSync(logPath)).toBe(true);

    const logContent = fs.readFileSync(logPath, "utf-8");
    expect(logContent).toContain("Crash Report (uncaughtException)");
    expect(logContent).toContain("Error: Uncaught exception test trigger");
    expect(logContent).toContain("Stack Trace:");

    // Clean up created log file
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }
  });

  test("Crash log creation with non-Error object payload", () => {
    const stringError = "Critical string error payload";
    const logPath = writeCrashLog(stringError, "uncaughtException");

    expect(fs.existsSync(logPath)).toBe(true);
    const logContent = fs.readFileSync(logPath, "utf-8");
    expect(logContent).toContain("Error: Critical string error payload");
    expect(logContent).toContain("No stack trace available");

    // Clean up created log file
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath);
    }
  });

  test("wrapErrorBoundary catches exception, restores terminal, and writes error log", () => {
    let customErrorLogged = false;
    const failingFn = () => {
      throw new Error("Render exception in UI component");
    };

    const result = wrapErrorBoundary(failingFn, (err) => {
      customErrorLogged = true;
    });

    expect(result).toBeUndefined();
    expect(customErrorLogged).toBe(true);
    expect(getIsRestored()).toBe(true);
    expect(isRestored).toBe(true);
  });

  test("Terminal reset sequence formatting (T.show, T.altOff, A.reset)", () => {
    // Check individual ANSI sequence escape code strings
    expect(T.show).toBe("\x1b[?25h");
    expect(T.hide).toBe("\x1b[?25l");
    expect(T.altOn).toBe("\x1b[?1049h");
    expect(T.altOff).toBe("\x1b[?1049l");
    expect(A.reset).toBe("\x1b[0m");

    // Expected full reset sequence string written during terminal restoration
    const expectedSequence = T.show + T.altOff + "\x1b[?2004l" + A.reset;
    expect(expectedSequence).toBe("\x1b[?25h\x1b[?1049l\x1b[?2004l\x1b[0m");

    restoreTerminal();

    // Verify stdout received the exact formatted sequence
    expect(stdoutSpy).toHaveBeenCalledWith(expectedSequence);
  });
});
