/**
 * — Canonical provider auth types.
 *
 * Two hard separations govern this module:
 *
 *  1. CONFIG vs SECRETS — `AuthProfile` (metadata: ids, type, timestamps) is
 *     safe for config/UI/logs. `CredentialData` (secrets) lives ONLY inside
 *     the CredentialStore and never leaves it except through the
 *     CredentialResolver for a specific provider call.
 *  2. PROFILE vs CREDENTIAL — a profile is a stable NAMED IDENTITY; the
 *     credential under it can be replaced (re-login) without changing the id.
 *
 * A provider route () is NOT a credential and a credential is NOT a
 * route: routes pick which upstream serves a model, profiles pick WHICH
 * account pays for it.
 *
 * This module is contract-only: no filesystem, no network, no provider calls.
 */

/** — supported credential types. Deliberately closed. */
export type CredentialType = "env" | "api_key" | "oauth_exchanged_key";

/** — profile identity: `<providerId>/<profileName>`, both validated. */
export interface AuthProfile {
  id: string;
  providerId: string;
  displayName: string;
  /** Credential type discriminator — metadata only, mirrors the store entry. */
  type: CredentialType;
  /** Free-form, non-secret metadata (label, key-hash id, etc.). */
  metadata?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

/** — typed credential payloads. Exactly one shape per `type`. */
export type CredentialData =
  | EnvCredential
  | ApiKeyCredential
  | OAuthExchangedKeyCredential;

/** Present when the standard provider env var is set. The secret stays in env. */
export interface EnvCredential {
  type: "env";
  /** Environment variable name (never the value). */
  envName: string;
}

/** Manually entered key (`toolnet auth add`). */
export interface ApiKeyCredential {
  type: "api_key";
  secret: string;
}

/** Key obtained via OpenRouter OAuth PKCE code exchange (). */
export interface OAuthExchangedKeyCredential {
  type: "oauth_exchanged_key";
  secret: string;
  /** OAuth provider the code was exchanged with (e.g. "openrouter"). */
  oauthProvider: string;
  /** OpenRouter account linkage when the protocol surfaces one. */
  userId?: string;
  obtainedAt: number;
}

/** — where a resolved credential came from (status/diagnostics). */
export type CredentialSource =
  | "explicit_profile"
  | "session_profile"
  | "active_profile"
  | "environment"
  | "legacy_store"
  | "config"
  | "unavailable";

/** — resolver output. The raw secret is present but must never be logged. */
export interface ResolvedCredential {
  providerId: string;
  /** Profile id when resolved through one; absent for env/legacy sources. */
  profileId?: string;
  type: CredentialType;
  source: CredentialSource;
  /** The secret itself — callers use it for one call and must not retain it. */
  secret: string;
  /** Env var name when source=environment. */
  envName?: string;
}

/** Secret-free status view (CLI/TUI/doctor). Never contains the secret. */
export interface AuthProfileStatus {
  providerId: string;
  profileId?: string;
  displayName?: string;
  type?: CredentialType;
  source: CredentialSource;
  /** True only when a credential is actually resolvable right now. */
  configured: boolean;
  /** Env var checked, when source=environment or env fallback exists. */
  envName?: string;
  active: boolean;
  createdAt?: number;
  updatedAt?: number;
}

/** — status vocabulary. Existence of a string is never "valid". */
export type AuthStatusKind =
  | "configured"
  | "environment"
  | "needs_auth"
  | "invalid"
  | "unavailable";

/** Canonical provider credential defaults (env name per provider id). */
export const PROVIDER_CREDENTIAL_ENV: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  google: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  xai: "XAI_API_KEY",
  together: "TOGETHER_API_KEY",
  cohere: "COHERE_API_KEY",
  minimax: "MINIMAX_API_KEY",
  toolnet: "TOOLNET_API_KEY",
  alibaba: "DASHSCOPE_API_KEY",
  dashscope: "DASHSCOPE_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
};

/** Standard env credential for a provider, when one is declared. */
export function providerCredentialEnv(providerId: string): string | undefined {
  return PROVIDER_CREDENTIAL_ENV[providerId.trim().toLowerCase()];
}
