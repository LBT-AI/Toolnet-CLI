/**
 * Phase 83 §5 — Safe process execution for external harnesses.
 *
 * Hard rules enforced here (never in adapters):
 *  - the child is spawned from `executable + argv[]` — never through
 *    `sh -c` / `bash -c` / `eval`, so a prompt containing `;`, `&&`, `$()`,
 *    backticks, quotes or newlines is inert data;
 *  - the environment is the existing `scrubChildEnv` allowlist plus ONLY the
 *    adapter's declared env names, still filtered through the secret
 *    deny-list (§14 — no arbitrary env cloning, values never logged);
 *  - the working directory is validated against the sandbox before spawn;
 *  - abort/timeout kill the WHOLE process group (the harness may spawn its own
 *    children — killing only the direct child would orphan them);
 *  - stdout/stderr are bounded, so a chatty harness cannot exhaust memory.
 *
 * This module is mechanics only: it has no harness-specific knowledge.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { scrubChildEnv } from "../../lib/security/childEnv";
import { HarnessSpawnError } from "./errors";

/** stdout/stderr caps — a harness flooding output is truncated, not OOM-killed. */
export const MAX_STREAM_BYTES = 8 * 1024 * 1024;

export interface SafeSpawnSpec {
  executable: string;
  args: string[];
  cwd: string;
  /** Adapter-declared env names to pass through from the parent environment. */
  envAllowlist: string[];
  /** Extra operational env vars (values never logged). */
  env?: Record<string, string>;
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SafeSpawnOutcome {
  exitCode: number | null;
  /** True when the process was killed by abort or timeout. */
  killed: boolean;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderrTail: string;
  truncated: boolean;
  /** Spawn failed (ENOENT/EACCES) — the caller maps this to a typed error. */
  spawnError?: string;
}

/**
 * Validate and normalize the working directory: must exist, be a directory,
 * and resolve without symlink games. Sandbox-root containment is enforced by
 * the caller (which knows the active sandbox policy); this checks basic
 * filesystem sanity so a spawn never lands somewhere broken.
 */
export function normalizeCwd(cwd: string): string {
  if (!cwd || !cwd.trim()) throw new Error("cwd is required for harness execution");
  const resolved = path.resolve(cwd.trim());
  let real = resolved;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    throw new Error(`cwd '${resolved}' does not exist or is not accessible`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    throw new Error(`cwd '${real}' is not a directory`);
  }
  if (!stat.isDirectory()) throw new Error(`cwd '${real}' is not a directory`);
  return real;
}

/** Build the child environment: allowlist + adapter names, secret-filtered. */
export function harnessChildEnv(
  parentEnv: NodeJS.ProcessEnv,
  allowlist: string[],
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  const wanted = new Set(allowlist.map((name) => name.trim()).filter(Boolean));
  return scrubChildEnv(parentEnv, Object.fromEntries([...wanted].map((name) => [name, parentEnv[name] ?? extra?.[name] ?? ""])));
}

/**
 * Kill the entire process group of a detached child. POSIX: negative pid hits
 * the group (grandchildren included). Windows: `taskkill /T /F`.
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", detached: true });
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* best-effort by design */
  }
}

/** SIGTERM the group, then SIGKILL after a short grace if still alive. */
function gracefulKillTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    /* fall through to the hard kill below */
  }
  const timer = setTimeout(() => killProcessTree(child), 1500);
  timer.unref?.();
}

/**
 * Spawn the harness safely and wait for completion, normalizing abort,
 * timeout and output bounds. The returned `exitCode === null` always pairs
 * with `killed` or `spawnError`.
 */
export function safeSpawn(spec: SafeSpawnSpec): Promise<SafeSpawnOutcome> {
  const startedAt = Date.now();

  return new Promise<SafeSpawnOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: harnessChildEnv(process.env, spec.envAllowlist, spec.env),
        stdio: ["pipe", "pipe", "pipe"],
        // Own process group so the tree-kill reaches grandchildren.
        detached: process.platform !== "win32",
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        exitCode: null,
        killed: false,
        timedOut: false,
        durationMs: 0,
        stdout: "",
        stderrTail: "",
        truncated: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // Spawn errors surface asynchronously on POSIX.
    let spawnFailed: string | undefined;
    child.on("error", (error) => {
      spawnFailed = error.message;
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > MAX_STREAM_BYTES) {
        truncated = true;
        return;
      }
      stdoutBytes += chunk.length;
      stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes + chunk.length > MAX_STREAM_BYTES) {
        truncated = true;
        return;
      }
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
    });

    let killed = false;
    let timedOut = false;
    let settled = false;

    const cleanup = () => {
      spec.signal?.removeEventListener("abort", onAbort);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    };

    const onAbort = () => {
      if (settled || killed) return;
      killed = true;
      gracefulKillTree(child);
    };
    spec.signal?.addEventListener("abort", onAbort, { once: true });

    const timeoutTimer =
      spec.timeoutMs !== undefined
        ? setTimeout(() => {
            if (settled || killed) return;
            timedOut = true;
            killed = true;
            gracefulKillTree(child);
          }, Math.max(1, spec.timeoutMs))
        : null;
    timeoutTimer?.unref?.();

    if (spec.signal?.aborted) onAbort();
    if (spec.stdin !== undefined) {
      child.stdin?.write(spec.stdin);
    }
    child.stdin?.end();

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        exitCode: child.exitCode,
        killed,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderrTail: Buffer.concat(stderrChunks).toString("utf8").slice(-4000),
        truncated,
        ...(spawnFailed !== undefined && stdoutChunks.length === 0 ? { spawnError: spawnFailed } : {}),
      });
    };

    child.on("close", () => finish());
    child.on("error", () => {
      if (settled) return;
      // Give 'close' a tick to fire for the spawn-failure case, then finish.
      setTimeout(finish, 25);
    });
  });
}

/** Map a spawn failure to the typed error with a secret-free message. */
export function spawnErrorOf(harnessId: string, outcome: SafeSpawnOutcome): HarnessSpawnError | undefined {
  if (!outcome.spawnError) return undefined;
  return new HarnessSpawnError(harnessId, outcome.spawnError);
}
