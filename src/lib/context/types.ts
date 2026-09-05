export type Role = "user" | "assistant" | "system" | "tool";

export interface ContextMessage {
  role: Role;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  pruned?: boolean;
}

export interface ModelContextSpec {
  modelName: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  autoCompactThresholdTokens: number;
  charsPerTokenEstimate: number;
}

export interface ContextBudget {
  modelName: string;
  maxContextTokens: number;
  currentEstimatedTokens: number;
  currentEstimatedChars: number;
  utilizationPercent: number;
  systemTokens: number;
  memoryTokens: number;
  conversationTokens: number;
  activeToolTokens: number;
  availableTokens: number;
  needsCompaction: boolean;
}

export interface CompactionOptions {
  force?: boolean;
  thresholdTokens?: number;
  thresholdChars?: number;
  keepRecentCount?: number;
  preserveSystemPrompt?: boolean;
  customSummaryPrefix?: string;
  model?: string;
  /** Phase 4: session binding for memory access. */
  sessionId?: string;
  /** Phase 4: explicit memory store override (tests, subagent isolation). */
  memory?: any;
  /** Phase 4: summary message role. Default is "user" for provider compatibility. */
  summaryRole?: "user" | "system" | "assistant";
}

export interface CompactionResult {
  compacted: boolean;
  messages: ContextMessage[];
  originalCount: number;
  newCount: number;
  savedChars: number;
  originalTokens?: number;
  newTokens?: number;
  savedTokens?: number;
  reason?: string;
}

export interface SessionMemoryData {
  workspaceRoot: string;
  framework?: string;
  projectOverview?: string;
  keyFilesTouched: string[];
  modifiedFiles: string[];
  userGoals: string[];
  discoveredInsights: string[];
  environmentInfo: Record<string, string>;
  lastUpdated: number;
}

export interface PruneOptions {
  maxToolResultChars?: number;
  keepRecentToolsCount?: number;
  alwaysPreserveErrors?: boolean;
}
