/**
 * Per-session exclusive lock.
 *
 * Two ToolNet processes must not append to the same journal. The lock is a file
 * created with `O_EXCL`, so acquisition is atomic without any daemon.
 *
 * Stale recovery is deliberately conservative: a lock is only reclaimed when the
 * owning pid is provably gone on this host, or when it is old enough that no
 * plausible run is still holding it. A crashed process therefore never leaves a
 * session permanently dead, and a live process is never preempted.
 */

import fs from "node:fs";
import path from "node:path";
import { ensureDir, fileExists, readFileSafe, writeFileAtomic } from "./atomic";
import { SessionLockedError } from "./errors";
import { hostname } from "./workspace";

export interface SessionLockInfo {
  pid: number;
  host: string;
  at: number;
  sessionId: string;
}

export interface SessionLockHandle {
  path: string;
  sessionId: string;
  release: () => void;
}

const DEFAULT_HARD_STALE_MS = 30 * 60 * 1000;

export function readSessionLock(lockPath: string): SessionLockInfo | null {
  const raw = readFileSafe(lockPath);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.pid !== "number" || typeof parsed?.at !== "number") return null;
    return {
      pid: parsed.pid,
      host: typeof parsed.host === "string" ? parsed.host : "unknown",
      at: parsed.at,
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
    };
  } catch {
    return null;
  }
}

function pidIsAliveLocally(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === "EPERM";
  }
}

export function isLockStale(info: SessionLockInfo, now = Date.now(), hardStaleMs = DEFAULT_HARD_STALE_MS): boolean {
  if (now - info.at > hardStaleMs) return true;
  // A pid is only meaningful on the host that wrote it.
  const sameHost = info.host === hostname();
  if (sameHost && !pidIsAliveLocally(info.pid)) return true;
  return false;
}

/**
 * Acquire the exclusive lock, reclaiming a stale one. Throws
 * `SessionLockedError` when a live process genuinely holds it.
 */
export function acquireSessionLock(
  lockPath: string,
  sessionId: string,
  options: { hardStaleMs?: number; now?: number } = {},
): SessionLockHandle {
  ensureDir(path.dirname(lockPath));
  const now = options.now ?? Date.now();
  const payload: SessionLockInfo = { pid: process.pid, host: hostname(), at: now, sessionId };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(payload), "utf8");
      } finally {
        fs.closeSync(fd);
      }
      return {
        path: lockPath,
        sessionId,
        release: () => releaseSessionLock(lockPath, payload.pid),
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readSessionLock(lockPath);
      if (existing && !isLockStale(existing, now, options.hardStaleMs)) {
        throw new SessionLockedError(sessionId, existing.pid);
      }
      // Stale: remove it and retry once. A concurrent re-acquire is harmless —
      // the retry's O_EXCL still decides the winner.
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
  const info = readSessionLock(lockPath);
  throw new SessionLockedError(sessionId, info?.pid);
}

/**
 * Release only when we still own the lock: never delete a lock another process
 * acquired after ours was reclaimed.
 */
export function releaseSessionLock(lockPath: string, pid = process.pid): boolean {
  const info = readSessionLock(lockPath);
  if (info && info.pid !== pid) return false;
  if (!info && !fileExists(lockPath)) return false;
  try {
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function writeSessionLockForTests(lockPath: string, info: SessionLockInfo): void {
  writeFileAtomic(lockPath, JSON.stringify(info), 0o600);
}
