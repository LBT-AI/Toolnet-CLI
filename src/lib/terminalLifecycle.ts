import fs from "node:fs";
import path from "node:path";
import { T, A, write } from "../term";

export let isRestored = false;
let isLifecycleSetup = false;

export function getIsRestored(): boolean {
  return isRestored;
}

export function resetTerminalState(): void {
  isRestored = false;
  isLifecycleSetup = false;
}

/**
 * Idempotent terminal cleanup function.
 * Restores raw mode (`setRawMode(false)`), cursor (`T.show`), alt screen (`T.altOff`),
 * bracketed paste (`\x1b[?2004l`), and ANSI reset (`A.reset`).
 */
export function restoreTerminal(): void {
  if (isRestored) return;
  isRestored = true;

  try {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
  } catch {
    // Ignore errors when disabling raw mode
  }

  try {
    write(T.show + T.altOff + "\x1b[?2004l" + A.reset);
  } catch {
    // Ignore errors writing to stdout during cleanup
  }
}

/**
 * Writes crash details to .logs/crash-<timestamp>.log cleanly.
 */
export function writeCrashLog(error: unknown, type: string = "crash"): string {
  try {
    const logsDir = path.join(process.cwd(), ".logs");
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const timestamp = Date.now();
    const logPath = path.join(logsDir, `crash-${timestamp}.log`);

    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : "";
    const logContent = `[${new Date().toISOString()}] Crash Report (${type})
Error: ${message}
Stack Trace:
${stack || "No stack trace available"}
`;

    fs.writeFileSync(logPath, logContent, "utf-8");
    return logPath;
  } catch (err) {
    console.error("Failed to write crash log:", err);
    return "";
  }
}

/**
 * Registers handlers for SIGINT, SIGTERM, uncaughtException, unhandledRejection, and exit.
 * Writes crash details to .logs/crash-<timestamp>.log cleanly on errors without crashing node.
 */
export function setupTerminalLifecycle(): void {
  if (isLifecycleSetup) return;
  isLifecycleSetup = true;

  process.on("exit", () => {
    restoreTerminal();
  });

  process.on("SIGINT", () => {
    restoreTerminal();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    restoreTerminal();
    process.exit(0);
  });

  process.on("uncaughtException", (error) => {
    restoreTerminal();
    writeCrashLog(error, "uncaughtException");
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    restoreTerminal();
    writeCrashLog(reason, "unhandledRejection");
    process.exit(1);
  });
}

/**
 * A wrapper that catches any synchronous render errors in TUI,
 * restores terminal, logs the crash to .logs/crash-...log, and exits cleanly.
 */
export function wrapErrorBoundary<T>(fn: () => T, onError?: (err: unknown) => void): T | undefined {
  try {
    return fn();
  } catch (error) {
    restoreTerminal();
    writeCrashLog(error, "renderError");
    if (onError) {
      onError(error);
    }
    return undefined;
  }
}
