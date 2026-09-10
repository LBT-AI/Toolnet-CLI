/**
 * Filesystem postcondition verification for mutating tools.
 *
 * Correctness contract: a filesystem mutation is "successful" ONLY when a real
 * tool executed AND the filesystem postcondition actually holds. Tool output
 * alone is NOT proof — providers/gateways can return misleading payloads, and
 * models sometimes narrate success without ever calling a tool (which the
 * agent loop treats as a plain answer; there is nothing to verify there).
 *
 * Pure fs functions (no gateway, no sandbox) — they re-check the REAL state of
 * the filesystem after the mutating tool has run, workspace-resolved via
 * codingAgent.resolvePath (same traversal rules as the tools themselves).
 */

import * as fs from "node:fs";
import { resolvePath } from "./codingAgent";

export interface PostconditionResult {
  ok: boolean;
  error?: string;
}

function resolveWorkspacePath(p: unknown): string | null {
  if (!p || typeof p !== "string") return null;
  try {
    const abs = resolvePath(p);
    // resolvePath resolves against the active workspace cwd; a resolved path
    // that is not under the workspace is out of scope for verification.
    return abs || null;
  } catch {
    return null;
  }
}

/** write_file: file must exist, be a regular file, and be readable. */
export function verifyFileWritten(pathArg: unknown): PostconditionResult {
  const abs = resolveWorkspacePath(pathArg);
  if (!abs) return { ok: false, error: "write_file verification failed: missing or invalid path argument" };
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile()) {
      return { ok: false, error: `write_file verification failed: ${pathArg} is not a regular file` };
    }
    // Readability probe: a zero-byte write is legal, an unreadable file is not.
    const fd = fs.openSync(abs, "r");
    fs.closeSync(fd);
    return { ok: true };
  } catch {
    return { ok: false, error: `write_file reported success but the file does not exist: ${pathArg}` };
  }
}

/** edit_file / replace_all / apply_patch: file must still exist and have changed. */
export function verifyFileEdited(pathArg: unknown, beforeHash: string | undefined): PostconditionResult {
  const abs = resolveWorkspacePath(pathArg);
  if (!abs) return { ok: false, error: "edit verification failed: missing or invalid path argument" };
  if (!fs.existsSync(abs)) {
    return { ok: false, error: `edit reported success but the file does not exist: ${pathArg}` };
  }
  try {
    const afterHash = hashFile(abs);
    if (beforeHash && afterHash === beforeHash) {
      return { ok: false, error: `edit reported success but file content is unchanged: ${pathArg}` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: `edit verification failed (cannot read file): ${pathArg}` };
  }
}

/**
 * Snapshot the (sha256) content of a file before an edit — used to prove the
 * content actually changed. Returns undefined when the file doesn't exist yet.
 */
export function snapshotFileHash(pathArg: unknown): string | undefined {
  const abs = resolveWorkspacePath(pathArg);
  if (!abs || !fs.existsSync(abs)) return undefined;
  try {
    return hashFile(abs);
  } catch {
    return undefined;
  }
}

/** create_artifact/update_artifact: .artifacts/<name> must exist. */
export function verifyArtifactWritten(name: unknown): PostconditionResult {
  if (!name || typeof name !== "string") {
    return { ok: false, error: "artifact verification failed: missing artifact name" };
  }
  const abs = resolveWorkspacePath(`.artifacts/${name}`);
  if (!abs || !fs.existsSync(abs)) {
    return { ok: false, error: `artifact reported success but .artifacts/${name} does not exist` };
  }
  return { ok: true };
}

/** mkdir(-like) mutations (e.g. shell mkdir, future mkdir tool): dir must exist. */
export function verifyDirectoryExists(pathArg: unknown): PostconditionResult {
  const abs = resolveWorkspacePath(pathArg);
  if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    return { ok: false, error: `directory was not created: ${pathArg}` };
  }
  return { ok: true };
}

function hashFile(abs: string): string {
  // Lazy import keeps this module load-light for non-edit tools.
  const crypto = require("node:crypto") as typeof import("node:crypto");
  return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
}
