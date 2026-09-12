/**
 * Phase 78.11 — Loopback OAuth callback server.
 *
 * Binds 127.0.0.1 ONLY (never 0.0.0.0), on a dynamic or configured port, with a
 * bounded lifetime. It answers the canonical route and nothing else; the
 * authorization code it captures is handed to the caller, which is responsible
 * for validating `state` against the auth store before any token exchange.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export const OAUTH_CALLBACK_PATH = "/mcp/oauth/callback";
export const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;

export interface OAuthCallbackResult {
  code: string;
  state?: string;
}

export interface OAuthCallbackServerOptions {
  /** 0 (default) lets the OS pick a free port. */
  port?: number;
  /** Override the route; default `/mcp/oauth/callback`. */
  path?: string;
  timeoutMs?: number;
}

export interface OAuthCallbackServer {
  port: number;
  redirectUri: string;
  /** Resolves with the captured code, rejects on timeout/abort/error. */
  waitForCallback(): Promise<OAuthCallbackResult>;
  close(): Promise<void>;
}

/** HTML shown in the browser tab after a successful callback. */
const SUCCESS_HTML =
  "<!doctype html><meta charset=utf-8><title>ToolNet CLI</title>" +
  "<body style=\"font-family:system-ui;padding:2rem\"><h2>Authorization complete</h2>" +
  "<p>You can close this tab and return to ToolNet CLI.</p></body>";

export async function startOAuthCallbackServer(
  options: OAuthCallbackServerOptions = {},
): Promise<OAuthCallbackServer> {
  const route = options.path ?? OAUTH_CALLBACK_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;

  let resolveResult: (value: OAuthCallbackResult) => void = () => {};
  let rejectResult: (reason: Error) => void = () => {};
  const pending = new Promise<OAuthCallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Nothing may observe an unhandled rejection if the caller ignores the promise.
  pending.catch(() => {});

  let settled = false;
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    const error = requestUrl.searchParams.get("error");
    if (error) {
      // The provider reported a failure — surface the code, never the body.
      res.writeHead(400, { "content-type": "text/plain" });
      res.end(`authorization failed: ${error}`);
      settle(() => rejectResult(new Error(`OAuth authorization failed: ${error}`)));
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("missing authorization code");
      settle(() => rejectResult(new Error("OAuth callback did not include an authorization code")));
      return;
    }

    const state = requestUrl.searchParams.get("state") ?? undefined;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(SUCCESS_HTML);
    settle(() => resolveResult({ code, state }));
  });

  const timer = setTimeout(() => {
    settle(() =>
      rejectResult(
        new Error(`OAuth callback was not received within ${timeoutMs}ms — re-run 'toolnet mcp auth <server>'.`),
      ),
    );
  }, timeoutMs);
  // Never keep the process alive just for the callback window.
  timer.unref?.();

  await new Promise<void>((resolve, reject) => {
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    // 127.0.0.1 is explicit: binding 0.0.0.0 would expose the callback to the LAN.
    server.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? options.port ?? 0;

  const close = async (): Promise<void> => {
    clearTimeout(timer);
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
        // `close` does not drop keep-alive sockets; force them so teardown is bounded.
        server.closeAllConnections?.();
      } catch {
        resolve();
      }
    });
  };

  return {
    port,
    redirectUri: `http://127.0.0.1:${port}${route}`,
    waitForCallback: () => {
      const result = pending.finally(() => void close());
      // Mark handled immediately: a callback that is refused before the caller
      // attaches a handler must not surface as an unhandled rejection.
      result.catch(() => {});
      return result;
    },
    close,
  };
}
