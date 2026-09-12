/**
 * Phase 78.9/78.10/78.13/78.14/78.15 — OAuth lifecycle for remote MCP.
 *
 * The heavy protocol work (RFC 9728 resource discovery, RFC 8414 authorization
 * server metadata, RFC 7591 dynamic client registration, PKCE, token exchange
 * and refresh) is delegated to the MCP SDK's `auth()` orchestrator. What this
 * module owns is the part that must be ours:
 *
 *   - where credentials live (URL-bound `McpAuthStore`, never the transcript)
 *   - `state` generation + STRICT validation before any token exchange
 *   - one-time PKCE verifier lifecycle
 *   - a bounded, non-looping refresh, and a deterministic
 *     `needs_client_registration` answer instead of an infinite retry
 *   - the authorization URL never being handed to the model
 *
 * Nothing here logs a token, verifier, code, or client secret.
 */

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  auth,
  discoverOAuthServerInfo,
  refreshAuthorization,
  UnauthorizedError,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  computeExpiresAt,
  isTokenExpired,
  type McpAuthStore,
  type McpAuthTokens,
} from "./authStore";
import type { McpOAuthConfig } from "./remoteConfig";
import { redactRemoteError } from "./remoteConfig";

export const OAUTH_CLIENT_NAME = "ToolNet CLI";
export const DEFAULT_OAUTH_REFRESH_SKEW_MS = 30_000;

export class OAuthStateMismatchError extends Error {
  constructor() {
    super(
      "OAuth callback state did not match the pending authorization request; the code was rejected.",
    );
    this.name = "OAuthStateMismatchError";
  }
}

export class OAuthClientRegistrationRequiredError extends Error {
  readonly hint: string;
  constructor(serverUrl: string) {
    super(
      `The authorization server for ${new URL(serverUrl).host} does not support dynamic client ` +
        `registration. Add oauth.clientId (and clientSecret if the server requires one) to this ` +
        `server's MCP config, then re-run 'toolnet mcp auth <server>'.`,
    );
    this.name = "OAuthClientRegistrationRequiredError";
    this.hint = "needs_client_registration";
  }
}

export interface OAuthProviderOptions {
  name: string;
  serverUrl: string;
  store: McpAuthStore;
  /** Redirect URI registered with the authorization server. */
  redirectUrl: string;
  client?: McpOAuthConfig;
  /** Optional human approval hook: the URL is shown, never given to the model. */
  onAuthorizationUrl?: (url: URL) => void;
}

/**
 * SDK `OAuthClientProvider` backed by the URL-bound auth store.
 * One instance per authorization attempt; all durable state lives in the store.
 */
export class McpOAuthProvider {
  readonly name: string;
  readonly serverUrl: string;
  private readonly store: McpAuthStore;
  private readonly redirect: string;
  private readonly client?: McpOAuthConfig;
  private readonly onAuthorizationUrl?: (url: URL) => void;
  /** Captured for the CLI/UI; never returned from a model-callable tool. */
  lastAuthorizationUrl?: string;

  constructor(options: OAuthProviderOptions) {
    this.name = options.name;
    this.serverUrl = options.serverUrl;
    this.store = options.store;
    this.redirect = options.redirectUrl;
    this.client = options.client;
    this.onAuthorizationUrl = options.onAuthorizationUrl;
  }

  get redirectUrl(): string {
    return this.client?.redirectUri ?? this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    const hasSecret = Boolean(this.client?.clientSecret);
    return {
      redirect_uris: [this.redirectUrl],
      client_name: OAUTH_CLIENT_NAME,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: hasSecret ? "client_secret_post" : "none",
      ...(this.client?.scope ? { scope: this.client.scope } : {}),
    };
  }

  /** Generate + persist the CSRF `state` so the callback can be validated. */
  async state(): Promise<string> {
    const state = generateOpaqueToken();
    await this.store.set(this.name, { serverUrl: this.serverUrl, oauthState: state });
    return state;
  }

  getStoredState(): string | undefined {
    return this.store.get(this.name)?.oauthState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const stored = this.store.getClientInfoFor(this.name, this.serverUrl);
    if (stored) {
      return { client_id: stored.clientId, client_secret: stored.clientSecret };
    }
    // Static config (Phase 78.14) is a legitimate pre-registration.
    if (this.client?.clientId) {
      return { client_id: this.client.clientId, client_secret: this.client.clientSecret };
    }
    return undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.store.set(this.name, {
      serverUrl: this.serverUrl,
      clientInfo: {
        clientId: info.client_id,
        clientSecret: "client_secret" in info ? info.client_secret : undefined,
        clientIdIssuedAt: "client_id_issued_at" in info ? info.client_id_issued_at : undefined,
        clientSecretExpiresAt: "client_secret_expires_at" in info ? info.client_secret_expires_at : undefined,
      },
    });
  }

  tokens(): OAuthTokens | undefined {
    const stored = this.store.getTokensFor(this.name, this.serverUrl);
    if (!stored) return undefined;
    return {
      access_token: stored.accessToken,
      token_type: "Bearer",
      ...(stored.refreshToken ? { refresh_token: stored.refreshToken } : {}),
      ...(stored.scope ? { scope: stored.scope } : {}),
      ...(stored.expiresAt
        ? { expires_in: Math.max(0, Math.floor((stored.expiresAt - Date.now()) / 1000)) }
        : {}),
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.store.set(this.name, {
      serverUrl: this.serverUrl,
      tokens: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: computeExpiresAt(tokens.expires_in),
        scope: tokens.scope,
      },
      // One-time lifecycle: the verifier and state are consumed by this exchange.
      codeVerifier: undefined,
      oauthState: undefined,
    });
  }

  /**
   * The authorization URL goes to the operator (CLI/TUI), never to the model.
   */
  async redirectToAuthorization(url: URL): Promise<void> {
    this.lastAuthorizationUrl = url.toString();
    this.onAuthorizationUrl?.(url);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.store.set(this.name, { serverUrl: this.serverUrl, codeVerifier });
  }

  codeVerifier(): string {
    const verifier = this.store.get(this.name)?.codeVerifier;
    if (!verifier) {
      throw new Error("No PKCE code verifier is stored for this server — start the auth flow again.");
    }
    return verifier;
  }

  async saveDiscoveryState(state: {
    authorizationServerUrl: string;
    resourceMetadataUrl?: string;
  }): Promise<void> {
    await this.store.set(this.name, {
      serverUrl: this.serverUrl,
      authorizationServerUrl: state.authorizationServerUrl,
      resourceMetadataUrl: state.resourceMetadataUrl,
    });
  }

  discoveryState(): { authorizationServerUrl: string; resourceMetadataUrl?: string } | undefined {
    const entry = this.store.get(this.name);
    if (!entry?.authorizationServerUrl) return undefined;
    return {
      authorizationServerUrl: entry.authorizationServerUrl,
      resourceMetadataUrl: entry.resourceMetadataUrl,
    };
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all") {
      await this.store.remove(this.name);
      return;
    }
    if (scope === "tokens") {
      await this.store.clearTokens(this.name);
      return;
    }
    await this.store.set(this.name, {
      ...(scope === "client" ? { clientInfo: undefined } : {}),
      ...(scope === "verifier" ? { codeVerifier: undefined, oauthState: undefined } : {}),
      ...(scope === "discovery" ? { authorizationServerUrl: undefined, resourceMetadataUrl: undefined } : {}),
    });
  }
}

// ── Lifecycle entry points ──────────────────────────────────────────────────

export interface BeginAuthOptions {
  name: string;
  serverUrl: string;
  store: McpAuthStore;
  fetchFn: FetchLike;
  client?: McpOAuthConfig;
  /** Where the loopback callback is listening. */
  redirectUrl: string;
  resourceMetadataUrl?: URL;
  onAuthorizationUrl?: (url: URL) => void;
}

export type BeginAuthResult =
  | { status: "AUTHORIZED" }
  | { status: "REDIRECT"; authorizationUrl: string }
  | { status: "NEEDS_CLIENT_REGISTRATION"; reason: string };

/**
 * Phase 78.9/78.13.
 *
 * Discovery runs first so `needs_client_registration` is a DETERMINISTIC answer
 * (no registration endpoint, no static client, no stored client) rather than an
 * SDK error after a pointless attempt. Then `auth()` handles registration,
 * PKCE, and the redirect.
 */
export async function beginAuthorization(options: BeginAuthOptions): Promise<BeginAuthResult> {
  const provider = new McpOAuthProvider({
    name: options.name,
    serverUrl: options.serverUrl,
    store: options.store,
    redirectUrl: options.redirectUrl,
    client: options.client,
    onAuthorizationUrl: options.onAuthorizationUrl,
  });

  if (!provider.clientInformation()) {
    const info = await discoverOAuthServerInfo(options.serverUrl, {
      resourceMetadataUrl: options.resourceMetadataUrl,
      fetchFn: options.fetchFn,
    });
    const registrationEndpoint = info.authorizationServerMetadata?.registration_endpoint;
    if (!registrationEndpoint) {
      return {
        status: "NEEDS_CLIENT_REGISTRATION",
        reason: new OAuthClientRegistrationRequiredError(options.serverUrl).message,
      };
    }
    // Cache what discovery found so the exchange does not repeat it.
    await provider.saveDiscoveryState({
      authorizationServerUrl: info.authorizationServerUrl,
      resourceMetadataUrl: options.resourceMetadataUrl?.toString(),
    });
  }

  const result = await auth(provider, {
    serverUrl: options.serverUrl,
    resourceMetadataUrl: options.resourceMetadataUrl,
    fetchFn: options.fetchFn,
  });

  if (result === "AUTHORIZED") return { status: "AUTHORIZED" };

  if (!provider.lastAuthorizationUrl) {
    throw new Error("OAuth authorization was requested but no authorization URL was produced.");
  }
  return { status: "REDIRECT", authorizationUrl: provider.lastAuthorizationUrl };
}

export interface CompleteAuthOptions extends BeginAuthOptions {
  code: string;
  /** `state` echoed by the callback — validated, never trusted. */
  state?: string;
}

/**
 * Phase 78.10/78.23.
 *
 * The `state` check happens BEFORE the code is exchanged. A mismatch throws and
 * persists nothing: no token is saved and the caller must not connect.
 */
export async function completeAuthorization(options: CompleteAuthOptions): Promise<void> {
  const provider = new McpOAuthProvider({
    name: options.name,
    serverUrl: options.serverUrl,
    store: options.store,
    redirectUrl: options.redirectUrl,
    client: options.client,
    onAuthorizationUrl: options.onAuthorizationUrl,
  });

  const expected = provider.getStoredState();
  if (!expected) {
    throw new OAuthStateMismatchError();
  }
  if (!options.state || !timingSafeEqual(expected, options.state)) {
    throw new OAuthStateMismatchError();
  }

  try {
    await auth(provider, {
      serverUrl: options.serverUrl,
      authorizationCode: options.code,
      fetchFn: options.fetchFn,
    });
  } catch (error) {
    // A failed exchange must not leave a half-authorized record behind.
    await options.store.set(options.name, { codeVerifier: undefined, oauthState: undefined });
    throw new Error(redactRemoteError(error instanceof Error ? error.message : String(error)));
  }
}

export interface RefreshOptions {
  name: string;
  serverUrl: string;
  store: McpAuthStore;
  fetchFn: FetchLike;
  client?: McpOAuthConfig;
  skewMs?: number;
}

export type RefreshOutcome = "fresh" | "refreshed" | "no-refresh-token" | "refresh-failed";

/**
 * Phase 78.15 — bounded refresh. Exactly ONE attempt; a failure clears the
 * access token so the caller transitions to `needs_auth` instead of looping.
 */
export async function refreshAccessTokenIfNeeded(options: RefreshOptions): Promise<RefreshOutcome> {
  const tokens = options.store.getTokensFor(options.name, options.serverUrl);
  if (!isTokenExpired(tokens, options.skewMs ?? DEFAULT_OAUTH_REFRESH_SKEW_MS)) return "fresh";
  if (!tokens?.refreshToken) return "no-refresh-token";

  const clientInfo = options.store.getClientInfoFor(options.name, options.serverUrl);
  const clientInformation: OAuthClientInformationMixed | undefined = clientInfo
    ? { client_id: clientInfo.clientId, client_secret: clientInfo.clientSecret }
    : options.client?.clientId
      ? { client_id: options.client.clientId, client_secret: options.client.clientSecret }
      : undefined;

  if (!clientInformation) {
    // Nothing to refresh with: the access token is already expired, so drop it
    // rather than letting a dead credential be presented on the next connect.
    await options.store.clearTokens(options.name);
    return "refresh-failed";
  }

  try {
    const info = await discoverOAuthServerInfo(options.serverUrl, { fetchFn: options.fetchFn });
    const refreshed = await refreshAuthorization(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientInformation,
      refreshToken: tokens.refreshToken,
      fetchFn: options.fetchFn,
    });
    await options.store.setTokens(options.name, options.serverUrl, {
      accessToken: refreshed.access_token,
      // Some servers rotate the refresh token; keep the old one when absent.
      refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
      expiresAt: computeExpiresAt(refreshed.expires_in),
      scope: refreshed.scope ?? tokens.scope,
    });
    return "refreshed";
  } catch {
    // Invalid/expired refresh token → drop the credentials and require re-auth.
    await options.store.clearTokens(options.name);
    return "refresh-failed";
  }
}

/** True when a stored, URL-bound, unexpired access token exists. */
export function hasUsableToken(
  store: McpAuthStore,
  name: string,
  serverUrl: string,
  skewMs = DEFAULT_OAUTH_REFRESH_SKEW_MS,
): boolean {
  const tokens: McpAuthTokens | undefined = store.getTokensFor(name, serverUrl);
  return Boolean(tokens?.accessToken) && !isTokenExpired(tokens, skewMs);
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof UnauthorizedError;
}

/** Constant-time-ish comparison for the CSRF state check. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function generateOpaqueToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}
