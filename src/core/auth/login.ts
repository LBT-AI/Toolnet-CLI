/**
 * — OpenRouter login orchestration.
 *
 * One function drives the whole PKCE lifecycle and, critically, stores the
 * credential ONLY after every validation has passed:
 *
 *   pending flow (state + verifier)
 *     → authorization URL (loopback callback or headless code)
 *     → code received
 *     → STATE VALIDATED + flow consumed (throws otherwise)
 *     → code exchanged for an API key
 *     → credential stored, profile registered, optionally activated
 *
 * Any failure before the final step leaves the credential store untouched, and
 * a failure after storing never half-registers a profile (store first, then
 * register — the registry refuses a profile without a credential).
 *
 * Nothing here logs a secret: the authorization URL carries only the public
 * challenge, and the exchanged key goes straight into the store.
 */

import { AuthProfileValidationError } from "./errors";
import { credentialStore, type CredentialStore } from "./credentialStore";
import { authProfileRegistry, type AuthProfileRegistry } from "./registry";
import {
  buildAuthorizationUrl,
  exchangeCodeForApiKey,
  OPENROUTER_OAUTH_PROVIDER,
  PendingFlowRegistry,
  startLoopbackServer,
  type PendingFlow,
} from "./openrouterOAuth";
import { validateProfileName } from "./errors";
import type { CredentialSource } from "./types";

export interface OpenRouterLoginOptions {
  /** Profile name (not the full id) — default "default". */
  profileName?: string;
  /** Print the URL instead of relying on a reachable loopback callback. */
  noBrowser?: boolean;
  timeoutMs?: number;
  keyLabel?: string;
  /** Activate the profile for the provider when it completes (default true). */
  activate?: boolean;
  fetchImpl?: typeof fetch;
  store?: CredentialStore;
  profiles?: AuthProfileRegistry;
  /** Called with the authorization URL so the CLI can open/print it. */
  onAuthorizationUrl?: (url: string) => void;
  /** Headless code source (CLI prompt). Required when `noBrowser` is true. */
  requestCode?: (flow: PendingFlow, authorizationUrl: string) => Promise<string>;
  /** Override for the loopback port; 0/undefined = ephemeral. */
  callbackPort?: number;
  /** Pending-flow registry override (tests). */
  pendingFlows?: PendingFlowRegistry;
  onStatus?: (message: string) => void;
}

export interface OpenRouterLoginResult {
  profileId: string;
  type: "oauth_exchanged_key";
  source: CredentialSource;
  activated: boolean;
  /** Length only — never the key itself. */
  keyLength: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Run the full OpenRouter PKCE login. Resolves with the created profile id.
 * Throws a structured auth error on any failure, having stored nothing.
 */
export async function loginOpenRouter(options: OpenRouterLoginOptions = {}): Promise<OpenRouterLoginResult> {
  const providerId = OPENROUTER_OAUTH_PROVIDER;
  const name = validateProfileName(options.profileName ?? "default");
  const profileId = `${providerId}/${name}`;
  const store = options.store ?? credentialStore;
  const profiles = options.profiles ?? authProfileRegistry;
  const pending = options.pendingFlows ?? new PendingFlowRegistry();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const flow = pending.create();

  // Headless needs a code source; loopback must not be silently skipped when
  // the caller asked for a browser flow but no server can be bound.
  if (options.noBrowser && !options.requestCode) {
    throw new AuthProfileValidationError(
      "headless login requires a code entry point (requestCode)",
      profileId,
    );
  }

  let loopback: Awaited<ReturnType<typeof startLoopbackServer>> | undefined;
  let waitForCode: Promise<{ code: string; state: string }>;

  if (options.noBrowser) {
    const authorizationUrl = buildAuthorizationUrl({
      codeChallenge: flow.codeChallenge,
      keyLabel: options.keyLabel ?? "ToolNet CLI",
    });
    options.onAuthorizationUrl?.(authorizationUrl);
    options.onStatus?.(
      "Open this URL on any machine, authorize, then paste the displayed code here.",
    );
    waitForCode = options.requestCode!(flow, authorizationUrl).then((code) => ({
      code,
      state: flow.state,
    }));
  } else {
    let resolveCode!: (value: { code: string; state: string }) => void;
    let rejectCode!: (error: Error) => void;
    waitForCode = new Promise((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    loopback = await startLoopbackServer({
      state: flow.state,
      ...(options.callbackPort !== undefined ? { port: options.callbackPort } : {}),
      timeoutMs,
      onCode: (code, state) => resolveCode({ code, state }),
      onError: (error) => rejectCode(error),
    });

    const authorizationUrl = buildAuthorizationUrl({
      codeChallenge: flow.codeChallenge,
      callbackUrl: loopback.callbackUrl,
    });
    options.onAuthorizationUrl?.(authorizationUrl);
    options.onStatus?.(
      "Waiting for authorization in the browser (the callback is bound to 127.0.0.1 only)…",
    );
  }

  try {
    const { code, state } = await waitForCode;

 // — state is validated BEFORE the exchange. `consume` throws on any
    // mismatch/expiry/reuse, and the catch below stores nothing.
    const consumed = pending.consume(state);

    const { key } = await exchangeCodeForApiKey({
      code,
      codeVerifier: consumed.codeVerifier,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

    // Store the secret first: the registry refuses a profile with no
    // credential, so this ordering can never leave a dangling profile.
    await store.set(profileId, {
      type: "oauth_exchanged_key",
      secret: key,
      oauthProvider: providerId,
      obtainedAt: Date.now(),
    });

    const profile = profiles.register({
      providerId,
      name,
      displayName: name,
      type: "oauth_exchanged_key",
      metadata: { source: "openrouter-oauth" },
    });

    let activated = false;
    if (options.activate !== false) {
      profiles.setActive(providerId, profile.id);
      activated = true;
    }

    return {
      profileId: profile.id,
      type: "oauth_exchanged_key",
      source: "explicit_profile",
      activated,
      keyLength: key.length,
    };
  } finally {
    await loopback?.close();
 // — a failed attempt must not leave a usable verifier behind.
    flow.consumed = true;
  }
}

/**
 * — complete a HEADLESS login from a code the user pasted, using a flow
 * that was created earlier in this same process. Kept separate so tests can
 * exercise state validation without a loopback server.
 */
export async function completeOpenRouterLogin(input: {
  flow: PendingFlow;
  code: string;
  profileName?: string;
  activate?: boolean;
  fetchImpl?: typeof fetch;
  store?: CredentialStore;
  profiles?: AuthProfileRegistry;
  pendingFlows: PendingFlowRegistry;
}): Promise<OpenRouterLoginResult> {
  const providerId = OPENROUTER_OAUTH_PROVIDER;
  const name = validateProfileName(input.profileName ?? "default");
  const profileId = `${providerId}/${name}`;
  const store = input.store ?? credentialStore;
  const profiles = input.profiles ?? authProfileRegistry;

  const consumed = input.pendingFlows.consume(input.flow.state);
  const { key } = await exchangeCodeForApiKey({
    code: input.code,
    codeVerifier: consumed.codeVerifier,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });

  await store.set(profileId, {
    type: "oauth_exchanged_key",
    secret: key,
    oauthProvider: providerId,
    obtainedAt: Date.now(),
  });
  const profile = profiles.register({
    providerId,
    name,
    displayName: name,
    type: "oauth_exchanged_key",
    metadata: { source: "openrouter-oauth" },
  });
  let activated = false;
  if (input.activate !== false) {
    profiles.setActive(providerId, profile.id);
    activated = true;
  }
  return {
    profileId: profile.id,
    type: "oauth_exchanged_key",
    source: "explicit_profile",
    activated,
    keyLength: key.length,
  };
}
