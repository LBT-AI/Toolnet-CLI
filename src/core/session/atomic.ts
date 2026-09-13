/**
 * Durable-write primitives for the session store.
 *
 * Session state must survive a kill at any instant, so writes are
 * temp-file + fsync + rename: a reader either sees the previous complete file or
 * the next complete file, never a half-written one. Appends to the event journal
 * use `appendFileDurable`, which is the one place a torn tail is tolerated (and
 * later recovered from).
 */

import fs from "node:fs";
import path from "node:path";

export function ensureDir(dir: string): void {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* concurrent creation is fine */
  }
}

export function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * Write a file atomically and durably. The temp file is created next to the
 * target (same filesystem, so rename is atomic) with restrictive permissions;
 * `fsync` on the file and the directory makes the rename survive a power loss,
 * not just a process death.
 */
export function writeFileAtomic(filePath: string, contents: string, mode = 0o600): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, "w", mode);
    fs.writeFileSync(fd, contents, "utf8");
    try {
      fs.fsyncSync(fd);
    } catch {
      /* some filesystems reject fsync; the rename is still atomic */
    }
    fs.closeSync(fd);
    fd = null;
    try {
      fs.chmodSync(tmp, mode);
    } catch {
      /* non-unix filesystems may not support chmod */
    }
    fs.renameSync(tmp, filePath);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw error;
  }
  // Persist the directory entry so the rename itself is durable.
  try {
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    /* best effort — not all platforms allow fsync on a directory */
  }
}

/**
 * Append one JSONL record. Each append is a single write of a complete line
 * (including its newline), so a crash leaves at most a torn final line — which
 * the reader detects and drops without discarding earlier valid records.
 */
export function appendLineDurable(filePath: string, line: string): void {
  ensureDir(path.dirname(filePath));
  const payload = line.endsWith("\n") ? line : `${line}\n`;
  const fd = fs.openSync(filePath, "a", 0o600);
  try {
    fs.writeFileSync(fd, payload, "utf8");
    try {
      fs.fsyncSync(fd);
    } catch {
      /* append ordering is still guaranteed by the OS for a single write */
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Read a file, returning null when it does not exist or cannot be read. */
export function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Move a damaged file aside instead of overwriting it, so an operator can still
 * inspect what was there. Returns the quarantine path, or null when the rename
 * itself failed (in which case the original is left untouched).
 */
export function quarantineFile(filePath: string, reason: string): string | null {
  if (!fileExists(filePath)) return null;
  const safeReason = reason.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "corrupt";
  const target = `${filePath}.${safeReason}-${Date.now()}`;
  try {
    fs.renameSync(filePath, target);
    return target;
  } catch {
    return null;
  }
}
