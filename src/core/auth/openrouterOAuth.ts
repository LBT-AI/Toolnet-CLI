/**
 * Phase 84 §11/§12/§33 — OpenRouter OAuth via PKCE (S256).
 *
 * Protocol implemented exactly as documented (read at
 * https://openrouter.ai/docs/guides/overview/auth/oauth during this phase):
 *
 *   1. GET  https://openrouter.ai/auth?callback_url=...&code_challenge=...
 *           &code_challenge_method=S256
 *   2. user authorizes; browser is redirected to the callback with `?code=`
 *      (or, headless, the code is displayed on screen)
 *   3. POST https://openrouter.ai/api/v1/auth/keys
 *           { code, code_verifier, code_challenge_method } → { key }
 *
 * Hard rules enforced here:
 *
 *  - `code_verifier` and `state` come from `crypto.randomBytes` (never a weak
 *    PRNG, never reused);
 *  - the challenge is the **base64url SHA-256** of the verifier (S256);
 *  - the loopback callback binds **127.0.0.1 only** on an ephemeral port and
 *    carries `state` in the PATH (`/callback/<state>`) so a redirect that
 *    appends `?code=` cannot corrupt or drop it;
 *  - `state` is validated BEFORE the exchange; a mismatch stores NOTHING;
 *  - a flow is single-use: the same state/verifier can never complete twice
 *    (§24 — "Attempt A cannot complete Attempt B");
 *  - failures (mismatch, timeout, HTTP error) store nothing.
 *
 * OpenRouter's exchange returns an API KEY, not a refreshable token pair, so
 * the result is modeled as `OAuthExchangedKeyCredential` and is never called
 * "refreshable" (§4).
 */

import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { OAuthCallbackTimeoutError, OAuthExchangeError, OAuthStateMismatchError } from "./errors";

export const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
export const OPENROUTER_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
export const OPENROUTER_OAUTH_PROVIDER = "openrouter";

/** Code lifetime documented by OpenRouter (10 minutes) — we never exceed it. */
export const OPENROUTER_CODE_TTL_MS = 10 * 60 * 1000;

export interface PkcePair {
  /** Random 43-128 char verifier kept local until exchange. */
  codeVerifier: string;
  /** base64url(SHA-256(verifier)) — the S256 challenge. */
  codeChallenge: string;
}

/** §11 — PKCE generation. Verifier is random; challenge is S256. */
export function generatePkce(): PkcePair {
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

/** §11 — one-time, unguessable state. */
export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Constant-time state comparison. Returns false rather than throwing so the
 * caller owns the "store nothing" decision.
 */
export function statesMatch(expected: string, received: string): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface AuthorizationUrlOptions {
  codeChallenge: string;
  /** Loopback callback URL, or omit for headless mode. */
  callbackUrl?: string;
  /** Headless only: the app label OpenRouter shows next to the code. */
  keyLabel?: string;
}

/**
 * §11/§12 — build the authorization URL.
 * With no `callbackUrl` this is the documented HEADLESS form, which requires a
 * `code_challenge` because the code is displayed on screen.
 */
export function buildAuthorizationUrl(options: AuthorizationUrlOptions): string {
  if (!options.callbackUrl && !options.codeChallenge) {
    throw new OAuthExchangeError(400, "headless mode requires a code_challenge");
  }
  const url = new URL(OPENROUTER_AUTH_URL);
  if (options.callbackUrl) url.searchParams.set("callback_url", options.callbackUrl);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (!options.callbackUrl && options.keyLabel) {
    url.searchParams.set("key_label", options.keyLabel);
  }
  return url.toString();
}

/** A single in-flight authorization attempt. */
export interface PendingFlow {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
  createdAt: number;
  /** Terminal once consumed — a flow can never complete twice. */
  consumed: boolean;
  flowId: string;
}

/**
 * §24 — pending-flow bookkeeping. Each attempt owns its own state + verifier,
 * so two concurrent logins cannot complete each other's callback.
 *
 * Kept in memory (never persisted): the verifier must not survive the process
 * that created it, which is also what makes it useless to an attacker who
 * lands the code out-of-band.
 */
export class PendingFlowRegistry {
  private readonly flows = new Map<string, PendingFlow>();
  private counter = 0;

  create(options: { codeVerifier?: string; codeChallenge?: string } = {}): PendingFlow {
    const pkce = options.codeVerifier
      ? { codeVerifier: options.codeVerifier, codeChallenge: options.codeChallenge ?? challengeFor(options.codeVerifier) }
      : generatePkce();
    const flow: PendingFlow = {
      state: generateState(),
      codeVerifier: pkce.codeVerifier,
      codeChallenge: pkce.codeChallenge,
      createdAt: Date.now(),
      consumed: false,
      flowId: `flow-${++this.counter}`,
    };
    this.flows.set(flow.state, flow);
    return flow;
  }

  /** Look up a flow without consuming it (used for CLI display/validation). */
  peek(state: string): PendingFlow | undefined {
    return this.flows.get(state);
  }

  size(): number {
    return this.flows.size;
  }

  /**
   * Validate `state` and consume the flow. Throws OAuthStateMismatchError when
   * the state is unknown, already consumed, or expired — in which case NOTHING
   * is returned and the caller must store nothing.
   */
  consume(state: string, now = Date.now()): PendingFlow {
    if (!state) throw new OAuthStateMismatchError();
    let match: PendingFlow | undefined;
    for (const flow of this.flows.values()) {
      if (statesMatch(flow.state, state)) {
        match = flow;
        break;
      }
    }
    if (!match) throw new OAuthStateMismatchError();
    if (match.consumed || now - match.createdAt > OPENROUTER_CODE_TTL_MS) {
      this.flows.delete(match.state);
      throw new OAuthStateMismatchError();
    }
    match.consumed = true;
    this.flows.delete(match.state);
    return match;
  }

  clear(): void {
    this.flows.clear();
  }
}

function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export interface LoopbackServer {
  /** e.g. http://127.0.0.1:51423/callback/<state> */
  callbackUrl: string;
  port: number;
  close(): Promise<void>;
}

/**
 * §11 — loopback callback server.
 *
 * Binds `127.0.0.1` explicitly (never 0.0.0.0), uses an ephemeral port unless
 * one is requested, and encodes the state in the path so a redirect that
 * appends `?code=` cannot disturb it.
 */
export async function startLoopbackServer(options: {
  state: string;
  /** 0 = OS-assigned ephemeral port. */
  port?: number;
  timeoutMs: number;
  onCode: (code: string, state: string) => void;
  onError: (error: Error) => void;
  pathPrefix?: string;
}): Promise<LoopbackServer> {
  const pathPrefix = options.pathPrefix ?? "/callback";
  const expectedPath = `${pathPrefix}/${encodeURIComponent(options.state)}`;
  let server: http.Server | undefined;
  let settled = false;

  const finish = (error: Error | undefined, code: string | undefined) => {
    if (settled) return;
    settled = true;
    if (error) options.onError(error);
    else if (code !== undefined) options.onCode(code, options.state);
    server?.close();
  };

  const timer = setTimeout(() => {
    finish(new OAuthCallbackTimeoutError(options.timeoutMs), undefined);
  }, options.timeoutMs);
  timer.unref?.();

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== expectedPath) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }
    // Query-level state is ALSO accepted when present, and always validated.
    const queryState = url.searchParams.get("state");
    if (queryState && !statesMatch(options.state, queryState)) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("State mismatch");
      finish(new OAuthStateMismatchError(), undefined);
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Missing code");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("Authorization received. You can close this tab and return to the terminal.");
    clearTimeout(timer);
    finish(undefined, code);
  });

  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(options.port ?? 0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);
  return {
    callbackUrl: `http://127.0.0.1:${port}${expectedPath}`,
    port,
    close: async () => {
      clearTimeout(timer);
      await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    },
  };
}

export interface ExchangeResult {
  /** User-controlled OpenRouter API key. NEVER log this. */
  key: string;
}

/**
 * §11 — exchange an authorization code for a user-controlled API key.
 *
 * `state` is validated by the caller BEFORE this is invoked. A non-2xx
 * response never yields a credential: the error detail is redacted by the
 * shared redactor (which the resolver populated) and the response body is
 * never echoed wholesale.
 */
export async function exchangeCodeForApiKey(input: {
  code: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}): Promise<ExchangeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(OPENROUTER_EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: input.code,
        code_verifier: input.codeVerifier,
        code_challenge_method: "S256",
      }),
    });
  } catch (error) {
    throw new OAuthExchangeError(0, "network error during code exchange");
  }

  if (!response.ok) {
    // Only the documented, non-sensitive error codes are surfaced.
    const detail =
      response.status === 400
        ? "invalid code_challenge_method"
        : response.status === 403
          ? "invalid or expired code / code_verifier"
          : response.status === 405
            ? "method not allowed (POST + HTTPS required)"
            : `unexpected status ${response.status}`;
    throw new OAuthExchangeError(response.status, detail);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OAuthExchangeError(response.status, "malformed exchange response");
  }
  const key = (payload as { key?: unknown } | null)?.key;
  if (typeof key !== "string" || !key.trim()) {
    throw new OAuthExchangeError(response.status, "exchange response contained no API key");
  }
  return { key: key.trim() };
}
