/**
 * Phase 79 — Provider Registry + Model Catalog + Model Router.
 *
 * Canonical model layer barrel. Import from here, not from the individual
 * modules, so the surface stays stable as internals move.
 */

// Types
export type {
  CapabilityKey,
  CapabilityRequirement,
  HealthState,
  ModelCapabilities,
  ModelDefinition,
  ModelLimits,
  ModelPricing,
  ModelRef,
  ModelStatus,
  NormalizedUsage,
  ProviderAuthentication,
  ProviderDefinition,
  ProviderHealth,
  ProviderKind,
  ProviderRegistration,
  ProviderStatus,
  ResolvedModel,
  RoutingPolicy,
  RoutingRequest,
} from "./types";
export { CAPABILITY_KEYS, blendedPrice, satisfiesCapabilities, unknownHealth } from "./types";

// Errors
export {
  DuplicateProviderError,
  InvalidModelReferenceError,
  ModelCapabilityError,
  ModelNotFoundError,
  ModelRoutingError,
  ProviderAuthError,
  ProviderError,
  ProviderNotFoundError,
  ProviderRateLimitError,
  ProviderUnavailableError,
  redactSecret,
  type ProviderErrorCode,
} from "./errors";

// Capabilities
export {
  mergeCapabilities,
  missingCapabilities,
  normalizeCapabilities,
  toLegacyCapabilities,
} from "./capabilities";

// Reference parsing
export { formatModelRef, isQualified, parseModelRef, tryParseModelRef } from "./ref";

// Health
export { FAILURE_THRESHOLD, ProviderHealthTracker, healthRank } from "./health";

// Catalog + registry
export { ModelCatalog, modelCatalog } from "./catalog";
export { ProviderRegistry, providerRegistry } from "./registry";

// Discovery
export {
  classifyRefreshError,
  discoverProviderModels,
  normalizeListedModel,
  refreshAllProviders,
  refreshProvider,
  type RefreshErrorClass,
  type RefreshOptions,
  type RefreshResult,
} from "./discovery";

// OpenRouter normalization
export { normalizeOpenRouterModel, normalizeOpenRouterModels, normalizeOpenRouterPricing } from "./openrouter";

// Provider definitions + bootstrap
export {
  bootstrapProviderRegistry,
  kindFromLegacyType,
  openRouterRegistration,
  registrationFromConfig,
  type BootstrapOptions,
  type BootstrapResult,
} from "./providers";

// Router
export {
  ModelRouter,
  getRoutingConfig,
  invokeModel,
  invokeWithFallback,
  isRetryableFailure,
  modelRouter,
  resetRoutingConfig,
  setRoutingConfig,
  type AttemptRecord,
  type FallbackOptions,
  type FallbackResult,
  type RoutingConfig,
} from "./router";

// Live acceptance
  export {
    classifyLiveFailure,
    ensureBootstrapped,
    runLiveAcceptance,
    type LiveAcceptanceOptions,
    type LiveAcceptanceReport,
    type LiveFailureClass,
  } from "./liveAcceptance";

// Runtime bridge
export {
  ensureProviderRegistry,
  noteModelFailure,
  noteModelSuccess,
  resetRuntimeBootstrap,
  resolveRuntimeModel,
  syncAdapterCapabilities,
  type RuntimeModel,
} from "./runtime";
