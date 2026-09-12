/**
 * Phase 78.2/78.17 — Remote MCP configuration + header policy.
 *
 * Remote entries are USER INPUT that name a network destination, so they are
 * validated before anything is constructed:
 *
 *   - `url` must parse and be http:/https: (no file:, data:, ws:, javascript:)
 *   - `timeout` must be a positive finite number
 *   - `headers` must be a flat string→string map
 *   - `oauth` must be an object; its `clientId`/`clientSecret` are read but
 *     NEVER logged
 *
 * Header policy is explicit: user-supplied headers are merged FIRST and the
 * transport's auth headers win. A user header that tries to set a reserved
 * auth-bearing name is dropped (with a warning) instead of silently
 * overriding the OAuth token.
 */

export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
  callbackPort?: number;
  /** Extra scopes are not supported in Phase 78 (kept out on purpose). */
}

export interface McpRemoteConfig {
  type: "remote";
  url: string;
  enabled: boolean;
  /** Connect timeout in ms. Tool-call and callback timeouts are separate. */
  timeout: number;
  headers: Record<string, string>;
  oauth?: McpOAuthConfig;
}

export const DEFAULT_REMOTE_CONNECT_TIMEOUT_MS = 30_000;
export const DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 30_000;

export type RemoteConfigResult =
  | { ok: true; value: McpRemoteConfig }
  | { ok: false; reason: string };

/** Redirect / credential-bearing headers a user config may never set. */
const RESERVED_HEADER_PATTERNS: RegExp[] = [
  /^authorization$/i,
  /^cookie$/i,
  /^proxy-authorization$/i,
  /^x-api-key$/i,
  /-token$/i,
  /-secret$/i,
  /^x-auth-token$/i,
];

/** Header names whose VALUES must never reach a log, event, or tool result. */
export function isRedactedHeaderName(name: string): boolean {
  return RESERVED_HEADER_PATTERNS.some((pattern) => pattern.test(name.trim()));
}

/** True when a header name is a credential name a user config must not set. */
export function isReservedHeaderName(name: string): boolean {
  return isRedactedHeaderName(name) || /^mcp-session-id$/i.test(name.trim());
}

/** `{ Authorization: "Bearer …" }` → `{ Authorization: "[REDACTED]" }`. */
export function redactHeaderValues(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isRedactedHeaderName(name) ? "[REDACTED]" : value;
  }
  return out;
}

/** Header NAMES only — never values. Used by diagnostics and audit. */
export function headerNames(headers: Record<string, string>): string[] {
  return Object.keys(headers).sort();
}

/**
 * Validate a raw config object that was declared as remote (either
 * `type: "remote"` or a bare `url` with no command).
 */
export function parseRemoteServerConfig(raw: unknown): RemoteConfigResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "remote MCP config must be an object" };
  }
  const record = raw as Record<string, unknown>;

  if (typeof record.url !== "string" || !record.url.trim()) {
    return { ok: false, reason: "remote MCP config requires a 'url'" };
  }

  const urlCheck = validateRemoteUrl(record.url);
  if (!urlCheck.ok) return { ok: false, reason: urlCheck.reason };

  let timeout = DEFAULT_REMOTE_CONNECT_TIMEOUT_MS;
  if (record.timeout !== undefined) {
    if (typeof record.timeout !== "number" || !Number.isFinite(record.timeout) || record.timeout <= 0) {
      return { ok: false, reason: "remote MCP 'timeout' must be a positive number of milliseconds" };
    }
    timeout = Math.floor(record.timeout);
  }

  const headers: Record<string, string> = {};
  if (record.headers !== undefined) {
    if (!record.headers || typeof record.headers !== "object" || Array.isArray(record.headers)) {
      return { ok: false, reason: "remote MCP 'headers' must be an object of string values" };
    }
    for (const [name, value] of Object.entries(record.headers as Record<string, unknown>)) {
      if (typeof value !== "string") {
        return { ok: false, reason: `remote MCP header '${name}' must be a string` };
      }
      headers[name] = value;
    }
  }

  let oauth: McpOAuthConfig | undefined;
  if (record.oauth !== undefined) {
    if (record.oauth === false) {
      oauth = undefined;
    } else if (!record.oauth || typeof record.oauth !== "object" || Array.isArray(record.oauth)) {
      return { ok: false, reason: "remote MCP 'oauth' must be an object" };
    } else {
      const oauthRecord = record.oauth as Record<string, unknown>;
      const asString = (key: string): string | undefined => {
        const value = oauthRecord[key];
        return typeof value === "string" && value.trim() ? value : undefined;
      };
      oauth = {
        clientId: asString("clientId"),
        clientSecret: asString("clientSecret"),
        scope: asString("scope"),
        redirectUri: asString("redirectUri"),
      };
      if (oauthRecord.callbackPort !== undefined) {
        if (
          typeof oauthRecord.callbackPort !== "number" ||
          !Number.isInteger(oauthRecord.callbackPort) ||
          oauthRecord.callbackPort < 0 ||
          oauthRecord.callbackPort > 65535
        ) {
          return { ok: false, reason: "remote MCP oauth.callbackPort must be a port number (0–65535)" };
        }
        oauth.callbackPort = oauthRecord.callbackPort;
      }
    }
  }

  return {
    ok: true,
    value: {
      type: "remote",
      url: urlCheck.url,
      enabled: record.enabled === false ? false : true,
      timeout,
      headers,
      oauth,
    },
  };
}

export type UrlCheckResult = { ok: true; url: string } | { ok: false; reason: string };

/** http:/https: only. A bare hostname is rejected (no implicit scheme guessing). */
export function validateRemoteUrl(input: string): UrlCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return { ok: false, reason: `remote MCP url is not a valid URL: ${input.trim().slice(0, 80)}` };
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return { ok: false, reason: `remote MCP url must use http: or https: (got '${protocol}')` };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * Merge policy (Phase 78.17):
 *   user config headers → reserved names dropped → transport/auth headers win.
 * Returns the effective header set plus the names that were dropped so the
 * caller can warn without ever printing a value.
 */
export function mergeRemoteHeaders(
  userHeaders: Record<string, string> | undefined,
  authHeaders: Record<string, string> = {},
): { headers: Record<string, string>; droppedReserved: string[] } {
  const headers: Record<string, string> = {};
  const droppedReserved: string[] = [];

  for (const [name, value] of Object.entries(userHeaders ?? {})) {
    if (isReservedHeaderName(name)) {
      droppedReserved.push(name);
      continue;
    }
    headers[name] = value;
  }

  // Transport-managed credentials always win.
  for (const [name, value] of Object.entries(authHeaders)) {
    headers[name] = value;
  }

  return { headers, droppedReserved };
}

/** Normalize an error message whose text may contain a credential. */
export function redactRemoteError(message: string): string {
  return message
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/([?&](?:access_token|refresh_token|code|client_secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/((?:access|refresh|id)_token"?\s*[:=]\s*"?)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]");
}
