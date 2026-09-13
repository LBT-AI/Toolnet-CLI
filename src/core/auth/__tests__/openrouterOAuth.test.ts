/**
 * — OpenRouter OAuth PKCE tests.
 *
 * The loopback tests use a REAL HTTP callback server; the exchange tests use an
 * injected fetch so no network or credential is required.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetAppConfigCache } from "../../../lib/appConfig";
import { CredentialStore } from "../credentialStore";
import { AuthProfileRegistry } from "../registry";
import {
  buildAuthorizationUrl,
  exchangeCodeForApiKey,
  generatePkce,
  generateState,
  PendingFlowRegistry,
  startLoopbackServer,
  statesMatch,
} from "../openrouterOAuth";
import { completeOpenRouterLogin, loginOpenRouter } from "../login";
import type { CredentialData } from "../types";
import { OAuthExchangeError, OAuthStateMismatchError } from "../errors";

let dir: string;
let previousConfigDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tn-auth-oauth-"));
  previousConfigDir = process.env.TOOLNETCLI_CONFIG_DIR;
  process.env.TOOLNETCLI_CONFIG_DIR = dir;
  resetAppConfigCache();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (previousConfigDir === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR;
  else process.env.TOOLNETCLI_CONFIG_DIR = previousConfigDir;
  resetAppConfigCache();
});

function harness() {
  const store = new CredentialStore({ filePath: path.join(dir, "creds.json"), onWarn: () => {} });
  const profiles = new AuthProfileRegistry({ store });
  return { store, profiles };
}

function okExchange(key: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ key }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

/** Secret of a credential, or undefined for env-backed entries. */
function secretOf(data: CredentialData | undefined): string | undefined {
  return data && "secret" in data ? data.secret : undefined;
}

describe("PKCE + state primitives", () => {
  test("challenge is base64url SHA-256 of the verifier (S256)", () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    expect(createHash("sha256").update(codeVerifier).digest("base64url")).toBe(codeChallenge);
    expect(codeChallenge).not.toContain("=");
    expect(codeChallenge).not.toContain("+");
    expect(codeChallenge).not.toContain("/");
  });

  test("two flows never share a verifier or state", () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(generateState()).not.toBe(generateState());
  });

  test("state comparison is exact and rejects empties", () => {
    expect(statesMatch("abc", "abc")).toBe(true);
    expect(statesMatch("abc", "abd")).toBe(false);
    expect(statesMatch("abc", "abcd")).toBe(false);
    expect(statesMatch("", "")).toBe(false);
    expect(statesMatch("abc", "")).toBe(false);
  });

  test("authorization URL carries S256 + challenge (loopback and headless)", () => {
    const loopback = new URL(
      buildAuthorizationUrl({ codeChallenge: "CH", callbackUrl: "http://127.0.0.1:1234/callback/S" }),
    );
    expect(loopback.origin + loopback.pathname).toBe("https://openrouter.ai/auth");
    expect(loopback.searchParams.get("callback_url")).toBe("http://127.0.0.1:1234/callback/S");
    expect(loopback.searchParams.get("code_challenge")).toBe("CH");
    expect(loopback.searchParams.get("code_challenge_method")).toBe("S256");

    const headless = new URL(buildAuthorizationUrl({ codeChallenge: "CH", keyLabel: "ToolNet CLI" }));
    expect(headless.searchParams.get("callback_url")).toBeNull();
    expect(headless.searchParams.get("key_label")).toBe("ToolNet CLI");
  });

  test("headless mode without a challenge is refused (documented requirement)", () => {
    expect(() => buildAuthorizationUrl({ codeChallenge: "" })).toThrow(OAuthExchangeError);
  });
});

describe("PendingFlowRegistry — one-time state and verifier", () => {
  test("consuming with the right state succeeds exactly once", () => {
    const registry = new PendingFlowRegistry();
    const flow = registry.create();
    const consumed = registry.consume(flow.state);
    expect(consumed.codeVerifier).toBe(flow.codeVerifier);
    expect(() => registry.consume(flow.state)).toThrow(OAuthStateMismatchError);
    expect(registry.size()).toBe(0);
  });

  test("a mismatched state is rejected and leaves the flow unconsumed", () => {
    const registry = new PendingFlowRegistry();
    const flow = registry.create();
    expect(() => registry.consume("some-other-state")).toThrow(OAuthStateMismatchError);
    // The real flow is still usable by its owner.
    expect(registry.consume(flow.state).codeVerifier).toBe(flow.codeVerifier);
  });

  test("an expired flow is rejected even with the correct state", () => {
    const registry = new PendingFlowRegistry();
    const flow = registry.create();
    const later = flow.createdAt + 11 * 60 * 1000;
    expect(() => registry.consume(flow.state, later)).toThrow(OAuthStateMismatchError);
  });

  test("two concurrent attempts cannot complete each other", () => {
    const registry = new PendingFlowRegistry();
    const a = registry.create();
    const b = registry.create();
    // Attempt B's callback can never consume attempt A's flow.
    expect(() => registry.consume(a.state)).not.toThrow();
    expect(() => registry.consume(a.state)).toThrow(OAuthStateMismatchError);
    // B is unaffected and still one-time.
    expect(() => registry.consume(b.state)).not.toThrow();
  });
});

describe("Loopback callback server", () => {
  test("delivers the code when the path state matches", async () => {
    const registry = new PendingFlowRegistry();
    const flow = registry.create();
    const received: { value: { code: string; state: string } | null } = { value: null };
    const server = await startLoopbackServer({
      state: flow.state,
      timeoutMs: 5_000,
      onCode: (code, state) => {
        received.value = { code, state };
      },
      onError: () => {},
    });
    expect(server.callbackUrl.startsWith("http://127.0.0.1:")).toBe(true);
    const response = await fetch(`${server.callbackUrl}?code=AUTHCODE123`);
    expect(response.status).toBe(200);
    // Give the callback a tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received.value).toEqual({ code: "AUTHCODE123", state: flow.state });
    await server.close();
  });

  test("a request to the wrong path is a 404 and does not deliver a code", async () => {
    const registry = new PendingFlowRegistry();
    const flow = registry.create();
    let called = false;
    const server = await startLoopbackServer({
      state: flow.state,
      timeoutMs: 5_000,
      onCode: () => {
        called = true;
      },
      onError: () => {},
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/wrong-path?code=X`);
    expect(response.status).toBe(404);
    expect(called).toBe(false);
    await server.close();
  });

  test("binds 127.0.0.1 only and times out with the structured error", async () => {
    const registry = new PendingFlowRegistry();
    const flow = registry.create();
    let error: Error | null = null;
    const server = await startLoopbackServer({
      state: flow.state,
      timeoutMs: 40,
      onCode: () => {},
      onError: (err) => {
        error = err;
      },
    });
    expect(server.callbackUrl).toContain("127.0.0.1");
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(error).toBeInstanceOf(Error);
    expect((error as unknown as { code: string }).code).toBe("OAUTH_CALLBACK_TIMEOUT");
    await server.close();
  });
});

describe("Code exchange", () => {
  test("returns the API key on success", async () => {
    const result = await exchangeCodeForApiKey({
      code: "CODE",
      codeVerifier: "VERIFIER",
      fetchImpl: okExchange("sk-or-v1-abcdefghijklmnop"),
    });
    expect(result.key).toBe("sk-or-v1-abcdefghijklmnop");
  });

  test("403 is a structured, non-retryable failure", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    try {
      await exchangeCodeForApiKey({ code: "C", codeVerifier: "V", fetchImpl });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(OAuthExchangeError);
      const typed = error as OAuthExchangeError;
      expect(typed.code).toBe("OAUTH_EXCHANGE_FAILED");
      expect(typed.retryable).toBe(false);
      expect(typed.message).toContain("invalid or expired");
    }
  });

  test("500 is classified retryable", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    try {
      await exchangeCodeForApiKey({ code: "C", codeVerifier: "V", fetchImpl });
      throw new Error("expected failure");
    } catch (error) {
      expect((error as OAuthExchangeError).retryable).toBe(true);
    }
  });

  test("a malformed body is a protocol failure, not a silent success", async () => {
    const fetchImpl = (async () =>
      new Response("{not-json", { status: 200 })) as unknown as typeof fetch;
    await expect(exchangeCodeForApiKey({ code: "C", codeVerifier: "V", fetchImpl })).rejects.toBeInstanceOf(
      OAuthExchangeError,
    );
  });

  test("a body without a key is refused", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    await expect(exchangeCodeForApiKey({ code: "C", codeVerifier: "V", fetchImpl })).rejects.toBeInstanceOf(
      OAuthExchangeError,
    );
  });
});

describe("loginOpenRouter — full lifecycle", () => {
  test("loopback login stores the credential and registers the profile", async () => {
    const { store, profiles } = harness();
    let callbackUrl = "";
    const result = await      loginOpenRouter({
        store,
        profiles,
        timeoutMs: 3_000,
        fetchImpl: okExchange("sk-or-v1-abcdefghijklmnopqrst"),
        onAuthorizationUrl: (url) => {
          callbackUrl = new URL(url).searchParams.get("callback_url") ?? "";
        // Fire the browser redirect asynchronously, like a real user would.
        void fetch(`${callbackUrl}?code=LOOPBACK_CODE`);
      },
    });
    expect(result.profileId).toBe("openrouter/default");
    expect(result.activated).toBe(true);
    expect(result.keyLength).toBe("sk-or-v1-abcdefghijklmnopqrst".length);
    expect(await store.get("openrouter/default")).toEqual({
      type: "oauth_exchanged_key",
      secret: "sk-or-v1-abcdefghijklmnopqrst",
      oauthProvider: "openrouter",
      obtainedAt: expect.any(Number),
    });
    expect(profiles.getActive("openrouter")?.id).toBe("openrouter/default");
    // The credential is NOT refreshable — OpenRouter returns an API key.
    const stored = await store.get("openrouter/default");
    expect(stored && "refreshToken" in stored).toBe(false);
  });

  test("a forged state query is rejected before any exchange", async () => {
    const { store, profiles } = harness();
    let exchangeCalled = false;
    const fetchImpl = (async () => {
      exchangeCalled = true;
      return new Response(JSON.stringify({ key: "should-not-happen" }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      loginOpenRouter({
        store,
        profiles,
        timeoutMs: 3_000,
        fetchImpl,
        onAuthorizationUrl: (url) => {
          const callback = new URL(url).searchParams.get("callback_url") ?? "";
          // Correct path, but a STATE that does not match this attempt.
          void fetch(`${callback}?code=FORGED&state=forged-state`);
        },
      }),
    ).rejects.toBeInstanceOf(OAuthStateMismatchError);

    expect(exchangeCalled).toBe(false);
    expect(store.profileIds()).toEqual([]);
    expect(profiles.list("openrouter")).toEqual([]);
  });

  test("a callback delivered to a different path never completes the flow", async () => {
    const { store, profiles } = harness();
    const fetchImpl = (async () => {
      throw new Error("exchange must not run");
    }) as unknown as typeof fetch;

    await expect(
      loginOpenRouter({
        store,
        profiles,
        timeoutMs: 150,
        fetchImpl,
        onAuthorizationUrl: (url) => {
          const callback = new URL(url).searchParams.get("callback_url") ?? "";
          // An attacker answers on their own path, not the bound one.
          void fetch(callback.replace(/\/callback\/[^?]+/, "/callback/attacker") + "?code=FORGED");
        },
      }),
    ).rejects.toBeInstanceOf(Error);

    expect(store.profileIds()).toEqual([]);
    expect(profiles.list("openrouter")).toEqual([]);
  });

  test("exchange failure stores NOTHING", async () => {
    const { store, profiles } = harness();
    const fetchImpl = (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch;
    await expect(
      loginOpenRouter({
        store,
        profiles,
        timeoutMs: 3_000,
        fetchImpl,
        onAuthorizationUrl: (url) => {
          const callback = new URL(url).searchParams.get("callback_url") ?? "";
          void fetch(`${callback}?code=SOME_CODE`);
        },
      }),
    ).rejects.toBeInstanceOf(OAuthExchangeError);
    expect(store.profileIds()).toEqual([]);
    expect(profiles.list("openrouter")).toEqual([]);
  });

  test("callback timeout stores NOTHING", async () => {
    const { store, profiles } = harness();
    await expect(
      loginOpenRouter({
        store,
        profiles,
        timeoutMs: 40,
        fetchImpl: okExchange("sk-or-v1-abcdefghijklmnopqrst"),
        onAuthorizationUrl: () => {},
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(store.profileIds()).toEqual([]);
  });

  test("headless login uses a pasted code and never touches the network except exchange", async () => {
    const { store, profiles } = harness();
    let printedUrl = "";
    const result = await loginOpenRouter({
      store,
      profiles,
      noBrowser: true,
      fetchImpl: okExchange("sk-or-v1-headless-key-123456"),
      onAuthorizationUrl: (url) => {
        printedUrl = url;
      },
      requestCode: async () => "PASTED_CODE",
    });
    expect(result.profileId).toBe("openrouter/default");
    expect(printedUrl).toContain("key_label=");
    expect(printedUrl).not.toContain("callback_url=");
    expect(await store.has("openrouter/default")).toBe(true);
  });

  test("a verifier cannot be reused: a second completion of the same flow fails", async () => {
    const { store, profiles } = harness();
    const pendingFlows = new PendingFlowRegistry();
    const flow = pendingFlows.create();
    await completeOpenRouterLogin({
      flow,
      code: "FIRST",
      store,
      profiles,
      pendingFlows,
      fetchImpl: okExchange("sk-or-v1-first-key-123456789"),
    });
    await expect(
      completeOpenRouterLogin({
        flow,
        code: "SECOND",
        store,
        profiles,
        pendingFlows,
        fetchImpl: okExchange("sk-or-v1-second-key-12345678"),
      }),
    ).rejects.toBeInstanceOf(OAuthStateMismatchError);
    expect(secretOf(await store.get("openrouter/default"))).toBe("sk-or-v1-first-key-123456789");
  });
});
