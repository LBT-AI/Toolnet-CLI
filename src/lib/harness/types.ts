/**
 * Core Type Definitions for Unified AgentHarness
 * Target File: src/lib/harness/types.ts
 */

import type { ContextMessage, ContextBudget } from "../context/types";
import type { SandboxMode, RiskLevel } from "../security/types";
import type { AgentRole, TaskGraph, SchedulerState } from "../../teamwork/types";
import type { CompletionEvidence, TaskRequirement } from "../../core/contracts";
import type { ToolPermissionScope } from "../../core/agent/agents/types";

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
  | "agent:reasoning_chunk"
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
  | "session:saved"
  | "loop:start"
  | "loop:end"
  | "loop:error";

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
  prompt?: string;
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
  /** Real agent role for the security context (Phase 2 policy propagation). */
  agentRole?: string;
  /** Nesting depth for subagent recursion gates. */
  agentDepth?: number;
  /** Abort signal — cancelling stops provider calls AND running tools. */
  signal?: AbortSignal;
  /**
   * Phase 75 — effective permission scope for this run. When set, tools denied
   * by the scope are refused BEFORE the security gateway, and `task` children
   * inherit this scope (intersected with their agent definition).
   */
  toolPermissionSet?: ToolPermissionScope;
  /** Phase 75 — maximum subagent nesting depth (default 1 = no grandchildren). */
  subagentMaxDepth?: number;
  onChunk?: (chunk: string) => void;
  onEvent?: (event: string, data: any) => void;
  /** Phase 73.9 — task requirements parsed from the user prompt. When set, the
   *  loop runs the Completion Gate before accepting a text-only final answer. */
  taskRequirements?: TaskRequirement;
  /** Live evidence fed by verified tool results (Completion Gate). */
  completionEvidence?: CompletionEvidence;
  /**
   * Interactive approval hook. When a tool requires permission and this is
   * provided, the loop asks the caller (TUI modal) instead of failing the call.
   * Denial returns a typed denied result to the model — never a fake success.
   */
  requestApproval?: (input: { name: string; args: any; reason?: string }) => Promise<boolean>;
  /**
   * Front-end specific tools (e.g. the TUI's save_plan) that are not part of
   * the core registry. Returning null falls through to the normal gateway.
   */
  onCustomTool?: (
    name: string,
    args: any,
    id: string
  ) => Promise<{ result: string; allowed: boolean } | null>;
  /** Reasoning effort settings — applied only when the model declares support. */
  reasoningSettings?: { enabled: boolean; effort: "auto" | "low" | "medium" | "high" };
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
  /** Phase 73.9 — verified side effects accumulated by the Completion Gate. */
  evidence?: CompletionEvidence;
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

// ── Task Understanding Layer ─────────────────────────────────────────────────

export type Intent =
  | "question"
  | "inspect"
  | "research"
  | "create"
  | "modify"
  | "debug"
  | "test"
  | "review"
  | "explain"
  | "mixed";

export interface TaskContext {
  rawPrompt: string;
  intent: Intent;
  objectives: string[];
  constraints: string[];
  referencedFiles: string[];
  referencedUrls: string[];
  requiresWorkspace: boolean;
  requiresNetwork: boolean;
  requiresMutation: boolean;
  requiresExecution: boolean;
  requestedOutput?: string;
  ambiguities: string[];
}

export type UrlKind = "github" | "documentation" | "webpage" | "api" | "raw-file" | "unknown";

export interface ExternalContext {
  source: string;
  content: string;
  trusted: false;
}

export interface Requirement {
  id: string;
  text: string;
  status: "pending" | "satisfied" | "blocked";
}

export interface ActiveTaskContext {
  currentGoal?: string;
  currentFiles: string[];
  currentUrls: string[];
  currentPlan: string[];
  completedSteps: string[];
  pendingSteps: string[];
  constraints: string[];
  requirements: Requirement[];
}

