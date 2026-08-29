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
export { ToolNetProvider, normalizeToolNetBaseUrl } from "./toolnet";
export { AnthropicProvider, normalizeAnthropicBaseUrl } from "./anthropic";
export { GeminiProvider, normalizeGeminiBaseUrl } from "./gemini";

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
  PROVIDERS_CONFIG_FILE,
} from "./registry";
