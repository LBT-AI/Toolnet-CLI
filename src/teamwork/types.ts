/**
 * Core Type Definitions for ToolNet Teamwork v2
 * Target File: cli/src/teamwork/types.ts
 */

export type ExecutionMode = 'TURBO' | 'STANDARD' | 'COMPLEX' | 'MULTI_AGENT';

export type AgentRole =
  | 'planner'
  | 'explorer'
  | 'worker'
  | 'reviewer'
  | 'auditor'
  | 'challenger'
  | 'EXPLORER'
  | 'IMPLEMENTER'
  | 'REVIEWER'
  | 'QA_ENGINEER'
  | 'TURBO_AGENT';

export type QualityLevel = 'FAST' | 'BALANCED' | 'THOROUGH' | 'DRAFT' | 'NORMAL' | 'HIGH' | 'MAX';

export type TaskStatus =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'SKIPPED'
  | 'pending'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'blocked';

export type TaskNodeStatus = TaskStatus;

export interface TaskNodeOutput {
  success: boolean;
  summary: string;
  modifiedFiles?: string[];
  artifacts?: string[];
  error?: string;
}

export interface TaskNode {
  id: string;
  title: string;
  description?: string;
  prompt?: string;
  role: AgentRole;
  dependencies: string[]; // Parent task node IDs
  dependsOn?: string[];   // Alias for dependencies
  status: TaskStatus;
  assignedAgentId?: string;
  targetFiles?: string[];
  requiresReview?: boolean;
  reviewRequired?: boolean;
  inputContext?: Record<string, unknown>;
  outputResult?: TaskNodeOutput;
  result?: string;
  error?: string;
  retryCount?: number;
  attempts?: number;
  maxAttempts?: number;
  maxRetries?: number;
  estimatedTokens?: number;
  actualTokensUsed?: number;
  tokensUsed?: number;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  complexityScore?: number;
}

export interface TaskGraph {
  id?: string;
  sessionId: string;
  goal?: string;
  userPrompt?: string;
  nodes: TaskNode[] | Record<string, TaskNode>;
  rootNodeIds?: string[];
  mode: ExecutionMode;
  maxConcurrency?: number;
  qualityLevel?: QualityLevel;
  totalEstimatedTokens?: number;
  createdAt: number;
  updatedAt?: number;
  rationale?: string;
  metadata?: {
    intentScore?: number;
    estimatedTotalTokens?: number;
    targetFiles?: string[];
    [key: string]: unknown;
  };
}

export interface IntentComplexityBreakdown {
  promptLengthScore: number;
  actionVerbScore: number;
  fileTargetScore: number;
  multiStepScore: number;
}

export interface IntentAnalysisResult {
  score: number;
  complexityScore?: number;
  mode: ExecutionMode;
  reasons: string[];
  rationale?: string;
  breakdown: IntentComplexityBreakdown;
  extractedFileTargets: string[];
  extractedKeywords: string[];
  requiresPlanner: boolean;
  requiresQA: boolean;
  suggestedRoles: AgentRole[];
  analyzedAt: number;
}

export interface BudgetConfig {
  maxTokens?: number;
  maxCostUsd?: number;
  maxDurationMs?: number;
  maxReviewRounds: number;
  tokenBurnRateAlertRatio?: number;
}

export interface BudgetUsage {
  tokensUsed: number;
  costUsd: number;
  elapsedMs: number;
  reviewRoundsCompleted: number;
}

export type SchedulerStatus =
  | 'idle'
  | 'initializing'
  | 'running'
  | 'paused'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'recovering'
  | 'INITIALIZING'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED';

export interface ActiveAgent {
  agentId: string;
  role: AgentRole;
  taskId: string;
  startedAt: number;
  status: 'running' | 'idle' | 'waiting' | 'RUNNING' | 'IDLE' | 'WAITING';
}

export interface SchedulerState {
  sessionId: string;
  status: SchedulerStatus;
  mode: ExecutionMode;
  graph?: TaskGraph;
  activeWorkers?: number;
  maxWorkers?: number;
  activeAgents?: ActiveAgent[];
  readyTaskIds?: string[];
  runningTaskIds?: string[];
  completedTaskIds: string[];
  failedTaskIds: string[];
  skippedTaskIds?: string[];
  pendingApproval?: ApprovalRequest;
  budgetUsage?: BudgetUsage;
  totalTokensUsed?: number;
  lastCheckpointId?: string;
  startTime?: number;
  endTime?: number;
  updatedAt?: number;
}

export type ApprovalType =
  | 'package_install'
  | 'file_deletion'
  | 'command_execution'
  | 'network_request'
  | 'high_privilege_op';

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  taskId: string;
  agentId: string;
  type: ApprovalType;
  title: string;
  description: string;
  payload: {
    command?: string;
    packages?: string[];
    files?: string[];
    [key: string]: unknown;
  };
  status: 'pending' | 'approved' | 'rejected' | 'auto_approved';
  requestedAt: number;
  respondedAt?: number;
  respondedBy?: string;
}

export interface CheckpointSnapshot {
  id: string;
  sessionId: string;
  milestoneTag: string;
  timestamp: number;
  taskGraph: TaskGraph;
  schedulerState: Omit<SchedulerState, 'graph'>;
  contextCacheHash?: string;
  eventLogSeq: number;
  tokenUsageHistory?: Record<string, number>;
}

export interface CheckpointSnapshot {
  id: string;
  sessionId: string;
  milestoneTag: string;
  timestamp: number;
  graphState: any; // Simplified for now
}

export interface TurboExecutionResult {
  sessionId: string;
  success: boolean;
  output: string;
  toolCallsCount: number;
  tokensUsed: number;
  durationMs: number;
  error?: string;
}

export interface TurboExecutionOptions {
  sessionId?: string;
  model?: string;
  gatewayUrl?: string;
  maxIterations?: number;
  timeoutMs?: number;
  eventBus?: any;
}

export interface SmartPlannerOptions {
  sessionId?: string;
  model?: string;
  gatewayUrl?: string;
  maxConcurrency?: number;
  eventBus?: any;
}

export interface TeamworkConfig {
  sessionId?: string;
  workingDirectory: string;
  qualityLevel: QualityLevel;
  budget: BudgetConfig;
  forceMode?: ExecutionMode;
  dbPath?: string;
}
