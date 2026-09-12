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

// Phase 80 — performance profiles + eval evidence
export {
  EVAL_DIMENSIONS,
  MIN_SAMPLES,
  aggregatePerformance,
  indexProfiles,
  isProfileEmpty,
  type EvalDimension,
  type EvalDimensionScores,
  type ModelPerformanceProfile,
  type PerformanceSample,
} from "./performance";

// Phase 80 — routing profiles
export {
  DEFAULT_ROUTING_PROFILE,
  ROUTING_PROFILES,
  ROUTING_PROFILE_NAMES,
  describeProfile,
  isRoutingProfileName,
  resolveRoutingProfile,
  type RoutingProfileDefinition,
  type RoutingProfileName,
  type ScoreWeights,
} from "./profiles";

// Phase 80 — deterministic scorer
export {
  CONTEXT_REFERENCE_TOKENS,
  COST_REFERENCE_USD,
  LATENCY_REFERENCE_MS,
  MIN_LATENCY_SAMPLES,
  NEUTRAL,
  contextTarget,
  evalScore,
  latencyScore,
  scoreModel,
  scoreTotal,
  type ModelScore,
  type ScoreComponent,
  type ScoreInput,
} from "./scoring";

// Phase 80 — task classification
export {
  LONG_CONTEXT_THRESHOLD,
  TOOL_HEAVY_THRESHOLD,
  classificationToRoutingRequest,
  classifyTask,
  type ClassifyInput,
  type TaskClassification,
  type TaskType,
} from "./taskClassifier";

// Phase 80 — persistent model cache
export {
  MODEL_CACHE_SCHEMA_VERSION,
  MODEL_CACHE_TTL_MS,
  getModelCachePath,
  hydrateCatalogFromCache,
  isCacheStale,
  readCatalogCache,
  removeCachedProvider,
  setCachedProviderModels,
  writeCatalogCache,
  type CatalogCacheFile,
  type CachedProviderModels,
} from "./cache";

// Phase 80 — read-only catalog projection (TUI/CLI)
export {
  buildCatalogRows,
  classifyPricing,
  priceLabel,
  triState,
  type CatalogFilter,
  type CatalogRow,
  type CatalogView,
} from "./catalogView";

// Phase 80 — routing persistence
export {
  POLICIES,
  addFallback,
  applyRoutingSettings,
  currentSettings,
  loadRoutingConfig,
  persistRoutingConfig,
  removeFallback,
  resetPersistedRouting,
  validateRoutingPatch,
  type RoutingValidation,
} from "./routingStore";

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
  providerSpeed,
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
