/**
 * Provider Abstraction Layer — Barrel Export.
 *
 * Core code should import from this module:
 *   import { getActiveProvider, getActiveBaseUrl } from "../providers";
 */

export type {
  Provider,
  ProviderConfig,
  ModelInfo,
  ChatRequest,
  ChatResponse,
  ChatChunk,
  ChatMessage,
  ChatChoice,
  ToolCall,
  ToolDefinition,
  Usage,
} from "./types";

export { OpenAICompatibleProvider, normalizeOpenAiBaseUrl } from "./openaiCompatible";
export { ToolNetProvider, normalizeToolNetBaseUrl, TOOLNET_DEFAULT_MODELS } from "./toolnet";
export { AnthropicProvider, normalizeAnthropicBaseUrl, ANTHROPIC_DEFAULT_MODELS } from "./anthropic";
export { GeminiProvider, normalizeGeminiBaseUrl, GEMINI_DEFAULT_MODELS } from "./gemini";

export {
  loadProvidersConfig,
  saveProvidersConfig,
  resetProvidersConfigCache,
  listProviders,
  getActiveProviderConfig,
  addProvider,
  removeProvider,
  setActiveProvider,
  createProviderInstance,
  getActiveProvider,
  getActiveBaseUrl,
  getActiveApiKey,
  getActiveDefaultModel,
  resolveApiKey,
  getDefaultProviderConfig,
  syncProviderOnKeySave,
  autoRestoreActiveProvider,
  onProviderSwitch,
  notifyProviderSwitch,
  type ProviderSwitchListener,
  PROVIDERS_CONFIG_FILE,
} from "./registry";
