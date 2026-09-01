/**
 * Core Type Definitions for Unified AgentHarness
 * Target File: src/lib/harness/types.ts
 */

import type { ContextMessage, ContextBudget } from "../context/types";
import type { SandboxMode, RiskLevel } from "../security/types";
import type { AgentRole, TaskGraph, SchedulerState } from "../../teamwork/types";

export type ExecutionMode =
  | "INTERACTIVE"
  | "HEADLESS"
  | "TURBO"
  | "TEAMWORK"
  | "SUBAGENT";

export type HarnessEventType =
  | "harness:init"
  | "agent:start"
  | "agent:thinking"
  | "agent:stream_chunk"
  | "tool:queued"
  | "tool:approval_required"
  | "tool:start"
  | "tool:complete"
  | "tool:error"
  | "agent:compact"
  | "agent:complete"
  | "agent:error"
  | "subagent:spawn"
  | "subagent:complete"
  | "session:saved";

export interface HarnessEvent {
  type: HarnessEventType;
  timestamp: number;
  sessionId: string;
  mode: ExecutionMode;
  payload?: any;
}

export type HarnessEventListener = (event: HarnessEvent) => void;

export interface HarnessConfig {
  workspaceRoot?: string;
  currentCwd?: string;
  sessionId?: string;
  model?: string;
  sandboxMode?: SandboxMode;
  gatewayUrl?: string;
  baseUrl?: string;
  maxTurns?: number;
  timeoutMs?: number;
}

export interface ExecutionOptions {
  model?: string;
  gatewayUrl?: string;
  baseUrl?: string;
  maxTurns?: number;
  timeoutMs?: number;
  sessionId?: string;
  systemPrompt?: string;
  stream?: boolean;
  toolsOverride?: any[];
  toolChoice?: "auto" | "required" | "none";
  sandboxMode?: SandboxMode;
  mode?: ExecutionMode;
  onChunk?: (chunk: string) => void;
  onEvent?: (event: string, data: any) => void;
}

export interface HarnessResult {
  success: boolean;
  output: string;
  messages: ContextMessage[];
  toolCallsCount: number;
  turnsUsed: number;
  tokensUsed: number;
  durationMs: number;
  mode: ExecutionMode;
  sessionId: string;
  budget?: ContextBudget;
  error?: string;
  artifacts?: string[];
  teamworkState?: SchedulerState;
}

export interface HarnessMetrics {
  toolCallsRequested: number;
  toolCallsExecuted: number;
  toolCallsDeduplicated: number;
  toolCacheHits: number;
  toolCallsBatched: number;
  rawToolOutputChars: number;
  retainedToolOutputChars: number;
  contextCompactions: number;
  workspaceIndexHits: number;
}

export interface HarnessSnapshot {
  sessionId: string;
  workspaceRoot: string;
  currentCwd: string;
  currentModel: string;
  sandboxMode: SandboxMode;
  activeFramework: string;
  totalTokensUsed: number;
  totalToolCalls: number;
  initializedAt: number;
  metrics?: HarnessMetrics;
}
