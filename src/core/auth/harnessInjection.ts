/**
 * — auth → external-harness credential bridge.
 *
 * Sits in the AUTH layer on purpose: external harnesses stay credential-agnostic
 * (they only declare which env names they read), and the auth layer decides
 * whether a resolved profile may be expressed as one of those names.
 *
 * Guarantees:
 *  - the profile is resolved through the canonical CredentialResolver (which
 *    registers the secret for redaction);
 *  - a profile is NEVER injected unless the user explicitly named it — there is
 *    no default-profile injection path;
 *  - the target env name must be the provider's canonical variable AND be
 *    declared by the adapter, otherwise HarnessCapabilityError;
 *  - nothing is written to argv, logs, or the harness' own config.
 */

import { HarnessCapabilityError } from "../externalHarness/errors";
import { credentialResolver, type CredentialResolver } from "./resolver";
import { AuthProfileValidationError } from "./errors";
import { providerCredentialEnv } from "./types";

export interface ExternalCredentialInjectionInput {
  harnessId: string;
  /** Adapter declaration — an undeclared name can never receive a secret. */
  credentialEnvAllowlist?: string[];
  /** Profile id (`provider/name`) the user explicitly requested. */
  profileId: string;
  /** Override the env var name (must still be declared by the adapter). */
  envName?: string;
  resolver?: CredentialResolver;
}

/**
 * Resolve + validate an explicit profile for external harness injection.
 * Returns the env mapping to hand to the runner, or throws a structured error.
 */
export function resolveExternalCredentialEnv(
  input: ExternalCredentialInjectionInput,
): Record<string, string> {
  const resolver = input.resolver ?? credentialResolver;
  const slash = input.profileId.indexOf("/");
  if (slash <= 0 || slash === input.profileId.length - 1) {
    throw new AuthProfileValidationError(
      `--auth-profile must be '<provider>/<name>' (received '${input.profileId}')`,
      input.profileId,
    );
  }
  const providerId = input.profileId.slice(0, slash).trim().toLowerCase();

  // Explicit profile: an invalid one is terminal (no env fallback).
  const credential = resolver.resolve({ providerId, explicitProfile: input.profileId });

  const envName =
    input.envName?.trim() || credential.envName || providerCredentialEnv(providerId);
  if (!envName) {
    throw new HarnessCapabilityError(
      input.harnessId,
      `provider '${providerId}' has no canonical credential env var to inject`,
    );
  }

  const declared = (input.credentialEnvAllowlist ?? []).map((name) => name.trim());
  if (!declared.includes(envName)) {
    throw new HarnessCapabilityError(
      input.harnessId,
      `harness '${input.harnessId}' does not declare credential env var '${envName}' — refusing to inject it`,
    );
  }

  return { [envName]: credential.secret };
}
