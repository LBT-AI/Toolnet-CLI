/**
 * Phase 78.7/78.8/78.35/78.36 — Canonical MCP auth store.
 *
 * One file, one writer:
 *
 *   <toolnetHome>/mcp-auth.json        mode 0600
 *
 * Guarantees:
 *   - ATOMIC write (temp file + rename), so a crash never leaves a half file.
 *   - Every mutation is SERIALIZED through a promise chain; two close-together
 *     mutations (token refresh + client registration) cannot lose an update.
 *   - Credentials are BOUND to `name + serverUrl`. Re-pointing a server at a
 *     different URL does NOT inherit the old token (Phase 78.8) — that would
 *     hand a credential to whatever now answers at that host.
 *   - A corrupt file is QUARANTINED (renamed aside) and the store resets to
 *     empty instead of crashing startup. File contents are never logged.
 *
 * This module never prints, returns, or throws a token value.
 */

import fs from "node:fs";
import path from "node:path";
import { ensureToolnetDir, getToolnetHome } from "../../lib/toolnetHome";

export interface McpAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Derived from `expires_in` at exchange time. */
  expiresAt?: number;
  scope?: string;
}

export interface McpAuthClientInfo {
  clientId: string;
  clientSecret?: string;
  clientIdIssuedAt?: number;
  clientSecretExpiresAt?: number;
}

export interface McpAuthEntry {
  /** Server name the credentials belong to (config key). */
  name: string;
  /** The URL these credentials were issued for. Binding key for Phase 78.8. */
  serverUrl?: string;
  tokens?: McpAuthTokens;
  clientInfo?: McpAuthClientInfo;
  codeVerifier?: string;
  oauthState?: string;
  authorizationServerUrl?: string;
  resourceMetadataUrl?: string;
  updatedAt?: number;
}

export interface McpAuthStoreOptions {
  /** Override the file path (tests use a temp dir). */
  filePath?: string;
  onWarn?: (message: string) => void;
}

export function getMcpAuthStorePath(): string {
  return path.join(getToolnetHome(), "mcp-auth.json");
}

/** A read that could not be parsed — quarantined, never surfaced verbatim. */
export interface AuthStoreQuarantine {
  quarantinedPath: string;
  reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class McpAuthStore {
  private readonly filePath: string;
  private readonly onWarn: (message: string) => void;
  private entries: Record<string, McpAuthEntry> | null = null;
  /** Serializes every mutation (Phase 78.35). */
  private queue: Promise<void> = Promise.resolve();
  private lastQuarantine: AuthStoreQuarantine | null = null;

  constructor(options: McpAuthStoreOptions = {}) {
    this.filePath = options.filePath ?? getMcpAuthStorePath();
    this.onWarn = options.onWarn ?? ((message) => console.error(`[mcp-auth] ${message}`));
  }

  getPath(): string {
    return this.filePath;
  }

  /** Non-fatal record of the most recent quarantine (Phase 78.36). */
  getQuarantine(): AuthStoreQuarantine | null {
    return this.lastQuarantine;
  }

  /** Serialized mutation: the callback sees the freshest map. */
  private withLock<T>(fn: (entries: Record<string, McpAuthEntry>) => T): Promise<T> {
    const run = this.queue.then(() => {
      const entries = this.load();
      const result = fn(entries);
      this.persist(entries);
      return result;
    });
    // Keep the chain alive even when a caller rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private load(): Record<string, McpAuthEntry> {
    if (this.entries) return this.entries;

    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch {
      this.entries = {};
      return this.entries;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!isRecord(parsed)) throw new Error("root is not an object");
      const entries: Record<string, McpAuthEntry> = {};
      for (const [name, value] of Object.entries(parsed)) {
        if (isRecord(value)) entries[name] = { name, ...(value as Omit<McpAuthEntry, "name">) };
      }
      this.entries = entries;
    } catch {
      // Quarantine: keep the bytes for the operator, start clean, and NEVER
      // echo the contents — a parse error message can quote the file body, and
      // the file body can contain tokens.
      const reason = "file is not valid JSON";
      const quarantinedPath = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.filePath, quarantinedPath);
      } catch {
        try {
          fs.rmSync(this.filePath, { force: true });
        } catch {
          // Nothing else to do — the store still works in memory.
        }
      }
      this.lastQuarantine = { quarantinedPath, reason };
      this.onWarn(
        `MCP auth file was unreadable (${reason}); it was quarantined and auth state was reset. ` +
          `Re-authenticate with 'toolnet mcp auth <server>'.`,
      );
      this.entries = {};
    }
    return this.entries;
  }

  private persist(entries: Record<string, McpAuthEntry>): void {
    const dir = path.dirname(this.filePath);
    ensureToolnetDir(dir);
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { mode: 0o600 });
      // Re-assert the mode: writeFileSync only applies `mode` on creation.
      try {
        fs.chmodSync(tmp, 0o600);
      } catch {
        /* non-unix filesystems may not support chmod */
      }
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw new Error(`failed to persist MCP auth state: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }

  /** Read-only view. Never mutates the file. */
  get(name: string): McpAuthEntry | undefined {
    const entry = this.load()[name];
    return entry ? { ...entry } : undefined;
  }

  has(name: string): boolean {
    return Boolean(this.load()[name]);
  }

  listNames(): string[] {
    return Object.keys(this.load()).sort();
  }

  /** Shallow-merge a patch into one entry, creating it when absent. */
  async set(name: string, patch: Partial<Omit<McpAuthEntry, "name">>): Promise<McpAuthEntry> {
    return this.withLock((entries) => {
      const current = entries[name] ?? { name };
      const next: McpAuthEntry = { ...current, ...patch, name, updatedAt: Date.now() };
      if (patch.tokens === undefined && Object.prototype.hasOwnProperty.call(patch, "tokens")) {
        delete next.tokens;
      }
      entries[name] = next;
      return { ...next };
    });
  }

  /**
   * URL-bound token lookup (Phase 78.8).
   *
   * Credentials are only returned when the stored `serverUrl` matches the
   * current one. A server re-pointed from `https://one.example` to
   * `https://evil.example` therefore starts unauthenticated.
   */
  getTokensFor(name: string, serverUrl: string): McpAuthTokens | undefined {
    const entry = this.load()[name];
    if (!entry?.tokens) return undefined;
    if (!isSameServerUrl(entry.serverUrl, serverUrl)) return undefined;
    return { ...entry.tokens };
  }

  /** Token lookup that ignores URL binding — used only by explicit logout/status. */
  getTokens(name: string): McpAuthTokens | undefined {
    const entry = this.load()[name];
    return entry?.tokens ? { ...entry.tokens } : undefined;
  }

  getClientInfoFor(name: string, serverUrl: string): McpAuthClientInfo | undefined {
    const entry = this.load()[name];
    if (!entry?.clientInfo) return undefined;
    if (!isSameServerUrl(entry.serverUrl, serverUrl)) return undefined;
    return { ...entry.clientInfo };
  }

  async setTokens(name: string, serverUrl: string, tokens: McpAuthTokens): Promise<void> {
    await this.set(name, { serverUrl: normalizeServerUrl(serverUrl), tokens });
  }

  async clearTokens(name: string): Promise<void> {
    await this.withLock((entries) => {
      const entry = entries[name];
      if (entry) {
        delete entry.tokens;
        entry.updatedAt = Date.now();
      }
    });
  }

  /** Full removal — tokens, client info, verifier/state (Phase 78.16). */
  async remove(name: string): Promise<boolean> {
    return this.withLock((entries) => {
      if (!entries[name]) return false;
      delete entries[name];
      return true;
    });
  }

  /** Test/diagnostic helper: drop the in-memory cache and re-read from disk. */
  reload(): void {
    this.entries = null;
  }

  /** Await any in-flight mutation (teardown / tests). */
  async flush(): Promise<void> {
    await this.queue;
  }
}

function normalizeServerUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

/** Compare URLs ignoring a trailing slash (the same endpoint either way). */
export function isSameServerUrl(stored: string | undefined, current: string): boolean {
  if (!stored) return false;
  return normalizeServerUrl(stored) === normalizeServerUrl(current);
}

/** Compute an absolute expiry from an OAuth `expires_in` response. */
export function computeExpiresAt(expiresInSeconds: number | undefined, now = Date.now()): number | undefined {
  if (typeof expiresInSeconds !== "number" || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    return undefined;
  }
  return now + Math.floor(expiresInSeconds) * 1000;
}

/** True when the token is missing or expires within `skewMs`. */
export function isTokenExpired(tokens: McpAuthTokens | undefined, skewMs = 30_000, now = Date.now()): boolean {
  if (!tokens?.accessToken) return true;
  if (tokens.expiresAt === undefined) return false;
  return tokens.expiresAt - now <= skewMs;
}

/**
 * Process-wide store. Tests construct their own instance against a temp file so
 * registry/auth state stays isolated.
 */
export const mcpAuthStore = new McpAuthStore();
