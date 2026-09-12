/**
 * Phase 78.3/78.18 — Guarded fetch for remote MCP traffic.
 *
 * The MCP transports need protocol headers (`Accept:
 * application/json, text/event-stream`, `Mcp-Session-Id`) that `safeFetch`'s
 * allow-list would strip, so remote MCP uses this narrower guard instead. It is
 * the ONLY fetch implementation a remote transport, OAuth exchange, or client
 * registration is allowed to receive:
 *
 *   - http:/https: only; `file:`, `data:`, `ws:`, `javascript:` are refused
 *   - loopback is allowed ONLY when the config explicitly targets loopback
 *     (self-hosted MCP servers are a first-class use case, arbitrary SSRF via a
 *     captured redirect is not)
 *   - redirects are followed MANUALLY with per-hop revalidation and a hop cap;
 *     a redirect that changes origin drops every credential header
 *   - a hard per-request timeout is enforced through an AbortSignal
 *   - error text is redacted, so a token can never reach a log or tool result
 */

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { redactRemoteError, validateRemoteUrl } from "./remoteConfig";

export const REMOTE_FETCH_DEFAULT_TIMEOUT_MS = 30_000;
export const REMOTE_FETCH_MAX_HOPS = 3;

export interface GuardedFetchOptions {
  /** Per-request timeout. Defaults to 30s. */
  timeoutMs?: number;
  /** Extra signal (e.g. connect cancellation) merged into each request. */
  signal?: AbortSignal;
  onWarn?: (message: string) => void;
}

export class RemoteFetchError extends Error {
  readonly code: "INVALID_URL" | "FORBIDDEN_SCHEME" | "TIMEOUT" | "REDIRECT_LIMIT" | "NETWORK_ERROR";
  constructor(code: RemoteFetchError["code"], message: string) {
    super(message);
    this.name = "RemoteFetchError";
    this.code = code;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const host = (hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function originOf(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization", "x-api-key"];

/**
 * Build a `FetchLike` bound to one server. `allowLoopback` is derived from the
 * configured target, not from the request URL, so a redirect into loopback
 * cannot smuggle a credentialed request back to the local machine.
 */
export function createGuardedFetch(
  targetUrl: string,
  options: GuardedFetchOptions = {},
): FetchLike {
  const timeoutMs = options.timeoutMs ?? REMOTE_FETCH_DEFAULT_TIMEOUT_MS;
  const allowLoopback = (() => {
    try {
      return isLoopbackHostname(new URL(targetUrl).hostname);
    } catch {
      return false;
    }
  })();

  return async function guardedFetch(input: string | URL, init?: RequestInit): Promise<Response> {
    let current = revalidate(typeof input === "string" ? input : input.toString(), allowLoopback);

    const initialHeaders = new Headers(init?.headers ?? undefined);
    let body = init?.body ?? undefined;
    let method = init?.method ?? "GET";

    for (let hop = 0; hop <= REMOTE_FETCH_MAX_HOPS; hop++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abortFromCaller = () => controller.abort();
      if (options.signal) {
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener("abort", abortFromCaller, { once: true });
      }

      let response: Response;
      try {
        response = await fetch(current.toString(), {
          method,
          headers: initialHeaders,
          body: body as BodyInit | undefined,
          signal: controller.signal,
          redirect: "manual",
        });
      } catch (error) {
        const message = redactRemoteError(error instanceof Error ? error.message : String(error));
        if ((error as { name?: string })?.name === "AbortError") {
          throw new RemoteFetchError("TIMEOUT", `remote MCP request timed out after ${timeoutMs}ms`);
        }
        throw new RemoteFetchError("NETWORK_ERROR", `remote MCP request failed: ${message}`);
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abortFromCaller);
      }

      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop === REMOTE_FETCH_MAX_HOPS) {
          throw new RemoteFetchError("REDIRECT_LIMIT", `remote MCP endpoint exceeded ${REMOTE_FETCH_MAX_HOPS} redirect hops`);
        }
        const next = revalidate(new URL(location, current).toString(), allowLoopback);
        // Never forward credentials across an origin change.
        if (originOf(next) !== originOf(current)) {
          for (const name of CREDENTIAL_HEADERS) initialHeaders.delete(name);
          options.onWarn?.(
            `remote MCP redirect changed origin to ${next.host}; credential headers were not forwarded`,
          );
        }
        current = next;
        // A 303 (and 301/302 for POST in practice) downgrades to GET.
        if (response.status === 303 || (response.status === 301 && method === "POST")) {
          method = "GET";
          body = undefined;
        }
        continue;
      }

      return response;
    }

    throw new RemoteFetchError("REDIRECT_LIMIT", `remote MCP endpoint exceeded ${REMOTE_FETCH_MAX_HOPS} redirect hops`);
  };
}

/**
 * Validate one hop. Loopback is permitted only when the configured target
 * itself is loopback, so a redirect into 127.0.0.1 from a public server is
 * still refused (SSRF guard).
 */
export function revalidateRemoteHop(input: string, allowLoopback: boolean): URL {
  const check = validateRemoteUrl(input);
  if (!check.ok) {
    // validateRemoteUrl already restricts the scheme; distinguish malformed vs forbidden.
    const forbidden = /^\s*(file|data|javascript|ws|wss|ftp|blob|about):/i.test(input);
    throw new RemoteFetchError(
      forbidden ? "FORBIDDEN_SCHEME" : "INVALID_URL",
      redactRemoteError(check.reason),
    );
  }
  const url = new URL(check.url);
  if (isLoopbackHostname(url.hostname) && !allowLoopback) {
    throw new RemoteFetchError("FORBIDDEN_SCHEME", "remote MCP request to loopback was blocked by policy");
  }
  return url;
}

function revalidate(input: string, allowLoopback: boolean): URL {
  return revalidateRemoteHop(input, allowLoopback);
}
