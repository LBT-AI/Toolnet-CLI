/**
 * Phase 79 — Provider Registry + Model Catalog + Model Router.
 *
 * Canonical model layer barrel. Import from here, not from the individual
 * modules, so the surface stays stable as internals move.
 */

import { loadRoutingIntelligence } from "./routingIntelligence";

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
export {
  AVAILABILITY_MIN_SAMPLES,
  FAILURE_THRESHOLD,
  ProviderHealthTracker,
  healthRank,
  type ProviderOutcome,
} from "./health";

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

// Phase 82 — read-only routing projection (TUI/CLI)
export {
  buildRoutingView,
  renderRoutingView,
  type RoutingRouteRow,
  type RoutingView,
  type RoutingViewInput,
} from "./routingView";

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
  invokeRouteChain,
  invokeWithFallback,
  isRetryableFailure,
  modelRouter,
  providerSpeed,
  resetRoutingConfig,
  setRoutingConfig,
  type AttemptRecord,
  type FallbackOptions,
  type FallbackResult,
  type RouteChainOptions,
  type RouteChainResult,
  type RoutingConfig,
  type RoutingDecision,
} from "./router";

// Phase 82 — provider routes + route routing
  export {
    DEFAULT_UPSTREAM,
    declaredUpstream,
    logicalModelKey,
    routeFromModel,
    routeIdOf,
    routeLabel,
    sameRoute,
    type ProviderRoute,
    type RouteRejection,
    type RouteRejectionReason,
  } from "./route";

  export {
    DEFAULT_PROVIDER_CONSTRAINTS,
    DEFAULT_PROVIDER_ROUTING_POLICY,
    PROVIDER_ROUTING_POLICIES,
    PROVIDER_ROUTING_POLICY_DEFINITIONS,
    describeProviderRoutingPolicy,
    isProviderRoutingPolicyName,
    mergeConstraints,
    resolveProviderRoutingPolicy,
    validateProviderRoutingPolicy,
    type ProviderConstraints,
    type ProviderRoutingPolicy,
    type ProviderRoutingPolicyName,
    type ProviderRoutingWeights,
  } from "./providerPolicy";

  export {
    ROUTE_COST_REFERENCE_USD,
    ROUTE_LATENCY_REFERENCE_MS,
    ROUTE_PRIORITY_REFERENCE,
    compareRoutes,
    scoreRoute,
    tieBreakReasons,
    type RouteScore,
    type RouteScoreComponent,
    type RouteScoreComponentKey,
    type RouteScoreInput,
  } from "./routeScoring";

  export {
    resolveProviderRoutes,
    routeLabels,
    type RouteRelaxation,
    type RouteResolution,
    type RouteResolutionOptions,
    type RouteResolutionRequest,
  } from "./routeResolver";

  export {
    ROUTE_LATENCY_MIN_SAMPLES,
    ROUTE_METRIC_TTL_MS,
    ROUTE_RING_SIZE,
    RoutePerformanceTracker,
    routePerformance,
    type RouteOutcome,
    type RoutePerformanceRecord,
    type RoutePerformanceSnapshot,
  } from "./routePerformance";

  export {
    affectsProviderHealth,
    classifyProviderFailure,
    failureProfile,
    isRetryableKind,
    type FailureClassification,
    type FailureKind,
  } from "./failureKind";

  export {
    getRoutingIntelligencePath,
    loadRoutingIntelligence,
    persistRoutingIntelligence,
    readRoutingIntelligence,
    ROUTING_INTELLIGENCE_SCHEMA_VERSION,
    type RoutingIntelligenceFile,
  } from "./routingIntelligence";

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

// Phase 82 §13 — hydrate the canonical route-performance tracker from the
// persisted intelligence snapshot exactly once per process, so the first
// routing decision of a session already reflects observed reality. Stale
// records decay on load; a corrupt file is quarantined, never thrown.
loadRoutingIntelligence();
