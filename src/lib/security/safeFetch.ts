/**
 * Layer 4 — Phase 4: Safe HTTP fetch wrapper.
 *
 * Hardening contract:
 *  1. URL schemes: only http: and https: are accepted. file:, javascript:,
 *     data:, ftp: and malformed URLs are rejected with a typed error.
 *     http://localhost / 127.0.0.1 / ::1 is allowed only via the
 *     explicit `allowLocalhost` flag.
 *  2. Timeouts: a hard request timeout (default 20s) is enforced.
 *  3. Redirects: hop limit (default 3). Each hop is re-validated against
 *     the same URL guard. The Authorization, Cookie, and X-API-Key
 *     request headers are NEVER forwarded across an origin change
 *     (host OR port OR scheme).
 *  4. Auth header redaction: the returned error / diagnostic path
 *     redacts any Authorization / Cookie / Bearer / X-API-Key values
 *     to [REDACTED_*] placeholders before they reach logs / errors /
 *     tool output.
 *  5. Network policy: callers may pass a `networkPolicy` hook. If the
 *     hook returns false, the request is refused (no SSRF bypass).
 */

import { redactSecrets } from "./secretGuard";

const DEFAULT_MAX_HOPS = 3;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;

const FORBIDDEN_SCHEMES = new Set([
  "file:",
  "javascript:",
  "data:",
  "ftp:",
  "vbscript:",
  "jar:",
  "blob:",
  "about:",
]);

const REDACTED_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "proxy-authorization",
]);

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxHops?: number;
  allowLocalhost?: boolean;
  /** Header policy: which header names are allowed to be forwarded. */
  allowHeaders?: string[];
  /** Network policy hook (returns true if the URL is OK to call). */
  networkPolicy?: (url: URL) => boolean;
  /** Optional signal to cancel. */
  signal?: AbortSignal;
  /** Maximum response body size in bytes (default 512 KiB). */
  maxResponseBytes?: number;
}

export interface SafeFetchResponse {
  status: number;
  statusText: string;
  url: string;
  headers: Headers;
  body: string;
  redirected: boolean;
  hops: number;
  /** True if the request was redirected and headers were NOT forwarded. */
  crossOrigin: boolean;
}

export class SafeFetchError extends Error {
  readonly code: string;
  readonly redacted: boolean;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.redacted = true;
  }
}

function isLocalhost(hostname: string): boolean {
  const lower = (hostname || "").toLowerCase();
  return lower === "localhost" || lower === "127.0.0.1" || lower === "::1" || lower === "[::1]";
}

function originOf(u: URL): string {
  return `${u.protocol}//${u.host}`;
}

function revalidateUrl(input: string, allowLocalhost: boolean): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new SafeFetchError("INVALID_URL", `Malformed URL: ${redactSecrets(input)}`);
  }
  const proto = parsed.protocol.toLowerCase();
  if (FORBIDDEN_SCHEMES.has(proto)) {
    throw new SafeFetchError("FORBIDDEN_SCHEME", `Forbidden URL scheme: ${proto}`);
  }
  if (proto !== "http:" && proto !== "https:") {
    throw new SafeFetchError("FORBIDDEN_SCHEME", `URL scheme not allowed: ${proto}`);
  }
  if (isLocalhost(parsed.hostname) && !allowLocalhost) {
    throw new SafeFetchError("LOCALHOST_DENIED", `Localhost destinations are not allowed by policy.`);
  }
  return parsed;
}

function redactHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    if (REDACTED_HEADERS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = v;
    }
  });
  return out;
}

export async function safeFetch(
  url: string,
  options: SafeFetchOptions & { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<SafeFetchResponse> {
  const allowLocalhost = options.allowLocalhost ?? false;
  const maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowHeaders = options.allowHeaders ?? ["User-Agent", "Accept", "Accept-Language"];
  const networkPolicy = options.networkPolicy;
  const maxResponseBytes = Number.isFinite(options.maxResponseBytes) && (options.maxResponseBytes || 0) > 0
    ? Math.floor(options.maxResponseBytes as number)
    : DEFAULT_MAX_RESPONSE_BYTES;

  let currentUrl = revalidateUrl(url, allowLocalhost);
  if (networkPolicy && !networkPolicy(currentUrl)) {
    throw new SafeFetchError("NETWORK_POLICY_DENIED", `Network policy denied request to ${currentUrl.hostname}`);
  }

  const initialOrigin = originOf(currentUrl);
  let hops = 0;
  let redirected = false;
  let lastResponse: Response | null = null;

  // Build the header policy: only the explicit allow-list is forwarded.
  const initialHeaders: Record<string, string> = {};
  for (const k of allowHeaders) {
    if (options.headers && options.headers[k]) {
      initialHeaders[k] = options.headers[k];
    }
  }
  // Always include a User-Agent fallback.
  if (!initialHeaders["User-Agent"]) {
    initialHeaders["User-Agent"] = "Mozilla/5.0 (compatible; ToolNet-CLI/1.0)";
  }

  // Follow redirects manually to enforce per-hop policy.
  for (let attempt = 0; attempt <= maxHops; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", abortFromCaller, { once: true });
    }
    try {
      lastResponse = await fetch(currentUrl.toString(), {
        method: options.method || "GET",
        headers: initialHeaders,
        body: options.body,
        signal: controller.signal,
        redirect: "manual",
      });
    } catch (err: any) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
      const msg = redactSecrets(err?.message || String(err));
      if (err?.name === "AbortError") {
        throw new SafeFetchError("TIMEOUT", `Request timed out after ${timeoutMs}ms: ${msg}`);
      }
      throw new SafeFetchError("NETWORK_ERROR", `Fetch failed: ${msg}`);
    }
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);

    // 3xx — manual redirect handling.
    if (lastResponse.status >= 300 && lastResponse.status < 400) {
      const loc = lastResponse.headers.get("location");
      if (!loc) {
        // No Location header — treat as terminal response.
        break;
      }
      // Resolve relative redirects.
      const next = new URL(loc, currentUrl);
      redirected = true;
      hops++;
      if (hops > maxHops) {
        throw new SafeFetchError("REDIRECT_LIMIT", `Exceeded ${maxHops} redirect hops.`);
      }
      try {
        currentUrl = revalidateUrl(next.toString(), allowLocalhost);
      } catch (e: any) {
        if (e instanceof SafeFetchError) {
          throw new SafeFetchError("REDIRECT_BLOCKED", `Redirect blocked: ${e.message}`);
        }
        throw e;
      }
      if (networkPolicy && !networkPolicy(currentUrl)) {
        throw new SafeFetchError("NETWORK_POLICY_DENIED", `Network policy denied redirect to ${currentUrl.hostname}`);
      }
      // Cross-origin? Do not forward any custom headers (defense in depth).
      if (originOf(currentUrl) !== initialOrigin) {
        for (const k of Object.keys(initialHeaders)) {
          if (k.toLowerCase() !== "user-agent" && k.toLowerCase() !== "accept" && k.toLowerCase() !== "accept-language") {
            delete initialHeaders[k];
          }
        }
      }
      continue;
    }

    // Terminal response.
    break;
  }

  if (!lastResponse) {
    throw new SafeFetchError("NO_RESPONSE", `No response received from ${redactSecrets(url)}`);
  }

  // Read and redact the body under a hard byte cap before it can reach logs,
  // tool output, or model context. This is intentionally independent of the
  // upstream Content-Length header, which is untrusted.
  let body = "";
  const reader = lastResponse.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      while (totalBytes < maxResponseBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        const remaining = maxResponseBytes - totalBytes;
        const chunk = value.length > remaining ? value.subarray(0, remaining) : value;
        chunks.push(chunk);
        totalBytes += chunk.length;
        if (chunk.length < value.length) break;
      }
    } finally {
      try { await reader.cancel(); } catch {}
    }
    const merged = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    body = new TextDecoder().decode(merged);
    if (totalBytes >= maxResponseBytes) body += `\n[Response truncated at ${maxResponseBytes} bytes]`;
  } else {
    body = await lastResponse.text();
  }
  body = redactSecrets(body);
  // Final response headers are redacted in the returned object.
  const safeHeaders = new Headers();
  for (const [k, v] of Object.entries(redactHeaders(lastResponse.headers))) {
    safeHeaders.set(k, v);
  }

  return {
    status: lastResponse.status,
    statusText: lastResponse.statusText,
    url: currentUrl.toString(),
    headers: safeHeaders,
    body,
    redirected,
    hops,
    crossOrigin: redirected && originOf(currentUrl) !== initialOrigin,
  };
}

/** Redact any leaked auth header values from a string (e.g. error message). */
export function redactAuthInText(text: string): string {
  return redactSecrets(text);
}
