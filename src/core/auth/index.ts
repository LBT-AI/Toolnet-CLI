/**
 * canonical provider auth surface.
 *
 * One store, one profile registry, one resolver, one operations facade; this
 * barrel is the only import path production code needs.
 */

export * from "./types";
export {
  AuthError,
  AuthProfileNotFoundError,
  AuthProfileValidationError,
  AuthProviderUnsupportedError,
  CredentialPermissionError,
  CredentialStoreCorruptError,
  CredentialStoreError,
  CredentialUnavailableError,
  OAuthCallbackTimeoutError,
  OAuthExchangeError,
  OAuthStateMismatchError,
  makeProfileId,
  parseProfileId,
  validateProfileName,
  validateProviderSegment,
} from "./errors";
export { CredentialStore, credentialStore, getCredentialStorePath } from "./credentialStore";
export { AuthProfileRegistry, authProfileRegistry, DEFAULT_AUTH_SETTINGS } from "./registry";
export { CredentialResolver, credentialResolver } from "./resolver";
export { resolveApiKeyLegacy } from "./legacy";
export { AuthOperations, authOperations, statusKindFor } from "./operations";
export {
  buildAuthorizationUrl,
  exchangeCodeForApiKey,
  generatePkce,
  generateState,
  OPENROUTER_AUTH_URL,
  OPENROUTER_CODE_TTL_MS,
  OPENROUTER_EXCHANGE_URL,
  OPENROUTER_OAUTH_PROVIDER,
  PendingFlowRegistry,
  startLoopbackServer,
  statesMatch,
} from "./openrouterOAuth";
export { completeOpenRouterLogin, loginOpenRouter } from "./login";
export {
  clearSessionAuthOverrides,
  pinSessionAuthProfile,
  resetSessionAuthBridge,
  sessionAuthProfile,
  setSessionAuthBridge,
} from "./context";
export { resolveExternalCredentialEnv } from "./harnessInjection";
