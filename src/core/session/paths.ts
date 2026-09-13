/**
 * Session id validation and safe path resolution.
 *
 * Session ids are supplied by users (`toolnet session show <id>`), by subagent
 * identity code, and by external-harness namespacing, then used as file name
 * segments. Treating them as trusted text is a path-traversal bug, so every id
 * is validated here before it reaches the filesystem, and the resolved path is
 * re-checked to be inside the sessions directory.
 */

import path from "node:path";
import { getToolnetSessionsDir } from "../../lib/toolnetHome";
import { SessionInvalidIdError } from "./errors";

const MAX_ID_LENGTH = 200;
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/;

/** Namespaced external session ids stay their own identity type, but are still
 * safe to persist as a file segment. */
export function isValidSessionId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (id.length === 0 || id.length > MAX_ID_LENGTH) return false;
  if (id.startsWith(".")) return false;
  if (id.includes("..")) return false;
  if (id.includes("/") || id.includes("\\")) return false;
  if (id.includes("\0")) return false;
  // Control characters (including newlines) have no business in a file name.
  if (/[\u0000-\u001f\u007f]/.test(id)) return false;
  return SAFE_ID.test(id);
}

export function assertValidSessionId(id: unknown): string {
  if (typeof id === "string" && isValidSessionId(id)) return id;
  const shown = typeof id === "string" ? id.slice(0, 60) : String(id);
  throw new SessionInvalidIdError(shown, "must be a non-empty name without path separators or traversal");
}

/** Accepts `<id>` or `<id>.json`; rejects anything that is not a safe id. */
export function normalizeSessionId(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  const withoutExt = trimmed.endsWith(".json") ? trimmed.slice(0, -5) : trimmed;
  return assertValidSessionId(withoutExt);
}

/**
 * Canonical sessions directory. Kept in one place so the durable store, the
 * legacy persistence facade, and the CLI all agree — including the test
 * override, which must win over the ToolNet home.
 */
export function resolveSessionsDir(): string {
  if (process.env.TOOLNETCLI_SESSIONS_DIR) return process.env.TOOLNETCLI_SESSIONS_DIR;
  if (process.env.TOOLNETAPI_SESSIONS_DIR) return process.env.TOOLNETAPI_SESSIONS_DIR;
  if (process.env.DATA_DIR) return path.join(process.env.DATA_DIR, "sessions");
  return getToolnetSessionsDir();
}

export interface SessionPaths {
  dir: string;
  record: string;
  journal: string;
  checkpoints: string;
  lock: string;
}

/**
 * Every path a session owns. The final `path.relative` guard is defence in
 * depth: even if id validation were loosened later, a resolved path can never
 * escape the sessions directory.
 */
export function sessionPathsFor(sessionId: string, sessionsDir = resolveSessionsDir()): SessionPaths {
  assertValidSessionId(sessionId);
  const dir = path.resolve(sessionsDir);
  const base = path.join(dir, sessionId);
  const ensureInside = (candidate: string): string => {
    const rel = path.relative(dir, candidate);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new SessionInvalidIdError(sessionId, "resolved path escapes the sessions directory");
    }
    return candidate;
  };
  return {
    dir,
    record: ensureInside(`${base}.json`),
    journal: ensureInside(`${base}.events.jsonl`),
    checkpoints: ensureInside(`${base}.checkpoints.jsonl`),
    lock: ensureInside(`${base}.lock`),
  };
}

/** Index file — dot-prefixed so transcript scans never mistake it for a session. */
export function sessionIndexPath(sessionsDir = resolveSessionsDir()): string {
  return path.join(path.resolve(sessionsDir), ".index.json");
}

export function lastSessionPointerPath(sessionsDir = resolveSessionsDir()): string {
  return path.join(path.resolve(sessionsDir), "last_session.txt");
}
