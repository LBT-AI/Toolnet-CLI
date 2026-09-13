/**
 * Phase 84 §6 — THE provider CredentialStore.
 *
 * Exactly one. Holds ONLY typed secret payloads (`CredentialData`), keyed by
 * canonical profile id. Profile METADATA lives in the AuthProfileRegistry, not
 * here; secrets never flow the other way either.
 *
 * Hardening is inherited from the Phase 78 MCP auth store pattern:
 *  - file mode 0600 (re-asserted on every write, verified on load),
 *  - atomic temp-write + rename (no half-written JSON, no permissive temp),
 *  - serialized mutations (no lost updates under concurrency),
 *  - corruption → quarantine (rename aside, warn, start empty — never log
 *    contents, never silently overwrite),
 *  - symlink on the target path is refused.
 *
 * The store never logs, never returns secrets to diagnostics, and registers
 * nothing itself — redaction registration is the CredentialResolver's job so
 * there is exactly one registration point.
 */

import fs from "node:fs";
import path from "node:path";
import { getToolnetHome, ensureToolnetDir } from "../../lib/toolnetHome";
import {
  CredentialStoreCorruptError,
  CredentialStoreError,
  CredentialPermissionError,
} from "./errors";
import type { CredentialData } from "./types";

const STORE_VERSION = 1;

export interface CredentialStoreOptions {
  filePath?: string;
  onWarn?: (message: string) => void;
}

export interface CredentialQuarantine {
  originalPath: string;
  quarantinedPath: string;
  reason: string;
  at: number;
}

interface StoreFile {
  version: number;
  credentials: Record<string, CredentialData>;
}

/** Default location: <toolnet home>/auth-credentials.json (mode 0600). */
export function getCredentialStorePath(): string {
  return path.join(getToolnetHome(), "auth-credentials.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural validation — an untyped/foreign entry is corruption, not data. */
function isValidCredential(value: unknown): value is CredentialData {
  if (!isRecord(value)) return false;
  const type = value.type;
  if (type === "env") return typeof value.envName === "string" && value.envName.length > 0;
  if (type === "api_key") return typeof value.secret === "string" && value.secret.length > 0;
  if (type === "oauth_exchanged_key") {
    return (
      typeof value.secret === "string" &&
      value.secret.length > 0 &&
      typeof value.oauthProvider === "string" &&
      typeof value.obtainedAt === "number"
    );
  }
  return false;
}

export class CredentialStore {
  private readonly explicitPath?: string;
  private readonly onWarn: (message: string) => void;
  private resolvedPath: string | null = null;
  private credentials: Record<string, CredentialData> | null = null;
  private lastQuarantine: CredentialQuarantine | null = null;

  constructor(options: CredentialStoreOptions = {}) {
    this.explicitPath = options.filePath;
    this.onWarn = options.onWarn ?? ((message) => console.error(`[auth] ${message}`));
  }

  /**
   * The store path is resolved LAZILY (first use), not at construction, so the
   * canonical singleton follows whatever `TOOLNETCLI_CONFIG_DIR`/HOME is in
   * effect when the process actually runs — the same behaviour as the config
   * owner. An explicit path is always honored verbatim.
   */
  private path(): string {
    if (this.resolvedPath) return this.resolvedPath;
    this.resolvedPath = this.explicitPath ?? getCredentialStorePath();
    return this.resolvedPath;
  }

  getPath(): string {
    return this.path();
  }

  /**
   * Drop the memoized path AND the in-memory snapshot. Used by tests and by
   * doctor flows that must re-read the file from disk after external changes.
   * Never invoked on a normal request path.
   */
  resetCache(): void {
    this.resolvedPath = null;
    this.credentials = null;
    this.lastQuarantine = null;
  }

  /** Non-fatal record of the most recent quarantine (diagnostics). */
  getQuarantine(): CredentialQuarantine | null {
    return this.lastQuarantine;
  }

  /**
   * Mutation core. Persistence is fully synchronous (writeFileSync + rename),
   * so each call's read-modify-write is atomic within the single-threaded
   * runtime: two concurrent `set()` calls can never interleave or lose an
   * update (§24 is proven by the concurrency tests, which fire overlapping
   * async invocations at these methods). Async read-modify-write sequences
   * (e.g. OAuth flows) must go through `mutate()` to stay serialized.
   */
  private mutate<T>(fn: (credentials: Record<string, CredentialData>) => T): T {
    const credentials = this.load();
    const result = fn(credentials);
    this.persist(credentials);
    return result;
  }

  /**
   * Serialized async mutation for multi-step flows (login/login races,
   * setActive+remove races): the callback may await, sees the freshest map,
   * and the final map is persisted exactly once when it resolves.
   */
  private async withLock<T>(fn: (credentials: Record<string, CredentialData>) => T | Promise<T>): Promise<T> {
    // Chain behind the previous async mutation to keep ordering.
    const run = this.queue.then(async () => {
      const credentials = this.load();
      const result = await fn(credentials);
      this.persist(credentials);
      return result;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private queue: Promise<void> = Promise.resolve();

  private load(): Record<string, CredentialData> {
    if (this.credentials) return this.credentials;

    let raw: string;
    try {
      raw = fs.readFileSync(this.path(), "utf8");
    } catch {
      this.credentials = {};
      return this.credentials;
    }

    // §25 — a store that exists but is broader than 0600 is repaired before
    // its contents are trusted (doctor also reports this).
    try {
      const stat = fs.statSync(this.path());
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
        fs.chmodSync(this.path(), 0o600);
        this.onWarn(`credential store permissions tightened to 0600 (${this.path()})`);
      }
    } catch {
      /* stat failures are handled by the read below */
    }

    try {
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !isRecord(parsed.credentials)) {
        throw new Error("unexpected credential store shape");
      }
      const credentials: Record<string, CredentialData> = {};
      for (const [id, value] of Object.entries(parsed.credentials)) {
        if (!isValidCredential(value)) {
          throw new Error(`credential entry '${id}' has an unknown shape`);
        }
        credentials[id] = value;
      }
      this.credentials = credentials;
    } catch (error) {
      // §26 — quarantine, do not log contents, continue empty.
      const quarantinedPath = `${this.path()}.corrupt-${Date.now()}`;
      let moved = false;
      try {
        fs.renameSync(this.path(), quarantinedPath);
        moved = true;
      } catch {
        /* if even the rename fails, leave the file untouched on disk */
      }
      this.lastQuarantine = {
        originalPath: this.path(),
        quarantinedPath: moved ? quarantinedPath : this.path(),
        reason: error instanceof Error ? error.message : "unparseable credential store",
        at: Date.now(),
      };
      this.onWarn(
        "credential store was corrupt and has been quarantined — contents were not read or logged; re-authenticate to rebuild",
      );
      this.credentials = {};
    }
    return this.credentials;
  }

  private persist(credentials: Record<string, CredentialData>): void {
    const dir = path.dirname(this.path());
    ensureToolnetDir(dir);

    // §6 — refuse to write through a symlink planted on the target path.
    try {
      const target = fs.lstatSync(this.path());
      if (target.isSymbolicLink()) {
        throw new CredentialStoreError("credential store path is a symlink — refusing to write");
      }
    } catch (error) {
      if (error instanceof CredentialStoreError) throw error;
      /* ENOENT is the normal case */
    }

    const tmp = `${this.path()}.tmp-${process.pid}-${Date.now()}`;
    const file: StoreFile = { version: STORE_VERSION, credentials };
    try {
      fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
      // writeFileSync applies `mode` only on creation — re-assert it.
      try {
        fs.chmodSync(tmp, 0o600);
      } catch {
        /* non-unix filesystems may not support chmod */
      }
      fs.renameSync(tmp, this.path());
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw new CredentialStoreError(
        `failed to persist credential store: ${error instanceof Error ? error.message : "unknown"}`,
        error,
      );
    }
  }

  /** Upsert one typed credential. Registers nothing; returns nothing secret. */
  async set(profileId: string, data: CredentialData): Promise<void> {
    await this.withLock((credentials) => {
      credentials[profileId] = data;
      return undefined;
    });
  }

  /**
   * Serialized async mutation exposed for flows that compose several store
   * operations atomically (OAuth login transaction: store credential + clear
   * pending verifier/state in one locked step).
   */
  mutateAsync<T>(fn: (credentials: Record<string, CredentialData>) => T | Promise<T>): Promise<T> {
    return this.withLock(fn);
  }

  /** Read one credential (resolver-only consumption; never for display). */
  get(profileId: string): CredentialData | undefined {
    const value = this.load()[profileId];
    return value ? { ...value } : undefined;
  }

  has(profileId: string): boolean {
    return Boolean(this.load()[profileId]);
  }

  /** Type-only view for status/doctor — no secret leaves the store. */
  describe(profileId: string): { type: CredentialData["type"] } | undefined {
    const value = this.load()[profileId];
    return value ? { type: value.type } : undefined;
  }

  profileIds(): string[] {
    return Object.keys(this.load());
  }

  async remove(profileId: string): Promise<boolean> {
    return this.withLock((credentials) => {
      if (!(profileId in credentials)) return false;
      delete credentials[profileId];
      return true;
    });
  }

  /**
   * Verify the store file mode for doctor. Returns "ok", "repaired" (fixed
   * to 0600), or "missing". Never reports file contents.
   */
  checkPermissions(): "ok" | "repaired" | "missing" {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.path());
    } catch {
      return "missing";
    }
    if (process.platform === "win32") return "ok";
    if ((stat.mode & 0o077) !== 0) {
      try {
        fs.chmodSync(this.path(), 0o600);
        return "repaired";
      } catch (error) {
        throw new CredentialPermissionError(this.path(), error);
      }
    }
    return "ok";
  }
}

/** Process-wide canonical credential store. */
export const credentialStore = new CredentialStore();
