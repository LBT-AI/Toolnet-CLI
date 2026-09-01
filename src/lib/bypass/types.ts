export type BypassLevel =
  | "lite"
  | "full"
  | "ultra"
  | "chad-lite"
  | "chad"
  | "chad-ultra"
  | "devmode"
  | "godmode"
  | "cybersec"
  | "raw"
  | "custom";

export const ALL_BYPASS_LEVELS: BypassLevel[] = [
  "lite",
  "full",
  "ultra",
  "chad-lite",
  "chad",
  "chad-ultra",
  "devmode",
  "godmode",
  "cybersec",
  "raw",
  "custom",
];

export interface BypassLevelInfo {
  level: BypassLevel;
  name: string;
  potency: number; // 1 to 10 scale
  description: string;
  targetModels: string;
}

export interface BypassConfig {
  enabled: boolean;
  level: BypassLevel;
  customPrompt?: string;
  autoEscalate: boolean;
  forceExecution: boolean;
  prefixInjection: boolean;
}

export type BypassContext = BypassConfig;

export interface RefusalCheckResult {
  isRefusal: boolean;
  reason?: string;
  matchedPattern?: string;
}

export interface BypassTurnResult {
  promptInjected: string;
  systemPromptInjected: string;
  escalatedFrom?: BypassLevel;
}
