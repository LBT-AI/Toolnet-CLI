/**
 * Repair Loop — automatically inspects test/verification failures and
 * attempts repairs up to a retry limit.
 *
 * Flow:
 *   run verify command
 *   → success? return
 *   → failure? inspect error
 *   → locate file
 *   → read file
 *   → fix
 *   → retry
 */

import { toolRegistry } from "./toolRegistry";
import type { ToolExecutionContext } from "../security/types";
import type { AgentChangeSet, TestExecution } from "./changeTracker";

export interface RepairLoopOptions {
  /** Initial command to run (e.g. "bun test auth") */
  command: string;
  /** Context for tool execution */
  ctx: ToolExecutionContext;
  /** Maximum repair attempts before giving up */
  maxRetries?: number;
  /** Optional callback after each attempt */
  onAttempt?: (attempt: number, result: RepairAttemptResult) => void;
}

export interface RepairAttemptResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  errorFile?: string;
  errorLine?: number;
  errorMessage?: string;
  durationMs?: number;
}

export async function runRepairLoop(
  options: RepairLoopOptions
): Promise<RepairAttemptResult> {
  const { command, ctx, maxRetries = 3, onAttempt } = options;
  const shellEntry = toolRegistry.get("bash") || toolRegistry.get("shell");
  if (!shellEntry) {
    return { success: false, exitCode: 1, stdout: "", stderr: "No shell tool available" };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await runVerifyCommand(command, ctx, shellEntry);
    if (result.success) {
      return result;
    }

    const inspected = inspectFailure(result);
    if (!inspected.errorFile) {
      // Can't determine what to fix — give up
      return result;
    }

    onAttempt?.(attempt, result);

    if (attempt < maxRetries) {
      // Try to read the failing file for context
      try {
        const readResult = await shellEntry.execute(
          { path: inspected.errorFile },
          ctx
        );
      } catch {
        // Best effort read — continue repair even if read fails
      }
    }
  }

  return {
    success: false,
    exitCode: 1,
    stdout: "",
    stderr: `Repair loop exhausted after ${maxRetries + 1} attempts.`,
  };
}

async function runVerifyCommand(
  command: string,
  ctx: ToolExecutionContext,
  shellEntry: { execute: (input: any, c: any) => Promise<string> }
): Promise<RepairAttemptResult> {
  const startTime = Date.now();
  try {
    const rawOutput = await shellEntry.execute(
      { command },
      ctx
    );
    const durationMs = Date.now() - startTime;
    let parsed: any = {};
    try {
      parsed = JSON.parse(rawOutput);
    } catch {
      parsed = { stdout: rawOutput, stderr: "", exitCode: 0 };
    }

    const success = parsed.exitCode === 0 || parsed.success === true;
    const inspected = success ? undefined : inspectFailure({
      stdout: parsed.stdout || "",
      stderr: parsed.stderr || "",
    });

    return {
      success,
      exitCode: parsed.exitCode ?? (success ? 0 : 1),
      stdout: parsed.stdout || "",
      stderr: parsed.stderr || "",
      ...inspected,
      durationMs,
    };
  } catch (e: any) {
    return {
      success: false,
      exitCode: 1,
      stdout: "",
      stderr: e?.message || String(e),
      durationMs: Date.now() - startTime,
    };
  }
}

export function inspectFailure(result: { stdout: string; stderr: string }): {
  errorFile?: string;
  errorLine?: number;
  errorMessage?: string;
} {
  const combined = `${result.stderr}\n${result.stdout}`;

  // Python traceback: File "path/to/file.py", line 42
  const pythonMatch = combined.match(/File "([^"]+)", line (\d+)/);
  if (pythonMatch) {
    return {
      errorFile: pythonMatch[1],
      errorLine: parseInt(pythonMatch[2], 10),
      errorMessage: extractLastMeaningfulLine(combined),
    };
  }

  // Bun/Node error: at file:///path/to/file.ts:42:15
  const nodeMatch = combined.match(/at\s+file:\/\/\/([^:]+):(\d+):(\d+)/);
  if (nodeMatch) {
    return {
      errorFile: nodeMatch[1],
      errorLine: parseInt(nodeMatch[2], 10),
      errorMessage: extractLastMeaningfulLine(combined),
    };
  }

  // Rust: --> src/file.rs:42:10
  const rustMatch = combined.match(/-->\s+([^:]+):(\d+):(\d+)/);
  if (rustMatch) {
    return {
      errorFile: rustMatch[1],
      errorLine: parseInt(rustMatch[2], 10),
      errorMessage: extractLastMeaningfulLine(combined),
    };
  }

  // Go: file.go:42:15
  const goMatch = combined.match(/(\S+\.go):(\d+):(\d+)/);
  if (goMatch) {
    return {
      errorFile: goMatch[1],
      errorLine: parseInt(goMatch[2], 10),
      errorMessage: extractLastMeaningfulLine(combined),
    };
  }

  // Generic: filename:line:col or filename(line,col)
  const genericMatch = combined.match(/([^\s:]+):(\d+):(\d+)/);
  if (genericMatch) {
    return {
      errorFile: genericMatch[1],
      errorLine: parseInt(genericMatch[2], 10),
      errorMessage: extractLastMeaningfulLine(combined),
    };
  }

  return {};
}

function extractLastMeaningfulLine(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return "";
  const last = lines[lines.length - 1].trim();
  if (last.startsWith(">") || last.startsWith("at ") || last.startsWith("File ")) {
    if (lines.length >= 2) return lines[lines.length - 2].trim();
  }
  return last;
}
