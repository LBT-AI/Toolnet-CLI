export type SandboxMode = "workspace" | "ask" | "full-access";

export type RiskLevel =
  | "SAFE_READ"
  | "SAFE_BUILD"
  | "MODERATE_WRITE"
  | "DANGEROUS"
  | "CRITICAL_DENY";

export type ActionCategory =
  | "FILE_READ"
  | "FILE_WRITE"
  | "FILE_DELETE"
  | "SHELL_EXECUTE"
  | "NETWORK_FETCH"
  | "BROWSER_AUTOMATION"
  | "MCP_TOOL"
  | "SYSTEM_ADMIN";

/**
 * 8 Granular Permission Capabilities for Strict Project & System Protection
 */
export type PermissionCapability =
  | "READ"       // Read code, files, directory structure, git history (Auto-allowed)
  | "CREATE"     // Create new files, directories, test files, plans (Auto-allowed)
  | "MODIFY"     // In-place surgical edits, patches, refactors (Auto-allowed in workspace)
  | "DELETE"     // Delete files/directories, rm, rmdir, drop database (Locked / Approval required)
  | "EXECUTE"    // Run safe builds, unit tests, scripts (Auto-allowed for build/test)
  | "RESET"      // git reset --hard, git clean, restore, wiping uncommitted changes (Locked / Approval required)
  | "NETWORK"    // Web fetch, API calls, browser testing (Auto-allowed for GET/fetch)
  | "SYSTEM"     // Sudo, system configs, process termination, hardware (Strictly Locked / Critical Deny)
  | "DYNAMIC_EXECUTION"; // eval, bash -c, sh -c, python -c, node -e, interpreter inline scripts

export type TrustDuration = "ONCE" | "SESSION" | "DENIED";

export type PolicyDecisionType = "ALLOW" | "ASK" | "DENY";

export interface PermissionResult {
  decision?: PolicyDecisionType;
  allowed: boolean;
  needsApproval: boolean;
  riskLevel?: RiskLevel;
  category?: ActionCategory;
  capability?: PermissionCapability;
  reason?: string;
  resolvedPath?: string;
  matchedRule?: string;
  suggestedAction?: string;
}

export interface ToolExecutionContext {
  cwd?: string;
  workspaceRoot?: string;
  sandboxMode?: SandboxMode;
  userApproved?: boolean;
  agentRole?: string;
  agentDepth?: number;
  sessionId?: string;
  userId?: string;
  /** Layer 4 Phase 1: origin of the call — for audit + role propagation. */
  source?: "tui" | "headless" | "subagent" | "teamwork" | "plugin" | "vision" | "mcp";
  /** Abort signal — propagated to the executor so running processes can be killed. */
  signal?: AbortSignal;
  /**
   * Phase 75 — runtime facts for tools that create subagents (`task`).
   * The harness attaches the spawning turn's effective permission scope and
   * nesting depth so a child can never be granted more than its parent holds.
   */
  subagent?: SubagentRuntimeContext;
}

/**
 * What a subagent-capable tool needs to spawn a child safely. Structurally
 * declared here (rather than imported from core) so the security layer keeps
 * zero runtime dependency on the agent layer.
 */
export interface SubagentRuntimeContext {
  /** Effective permission scope of the spawning turn. */
  permission: ToolPermissionScopeLike;
  /** Nesting depth of the spawning turn — a primary agent is 0. */
  depth: number;
  /** Maximum allowed child depth. */
  maxDepth: number;
  /**
   * Interactive approval hook inherited by the child, so a child that hits an
   * ASK can surface the same prompt the parent uses instead of failing closed.
   */
  requestApproval?: (input: { name: string; args: unknown; reason?: string }) => Promise<boolean>;
}

/** Structural shape of a tool permission scope (see core/agent/agents/types). */
export interface ToolPermissionScopeLike {
  defaultDecision: "allow" | "ask" | "deny";
  tools: Record<string, "allow" | "ask" | "deny">;
  allowedTools?: string[];
}

export interface ToolGatewayResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  allowed: boolean;
  needsApproval?: boolean;
  approvalRequired?: boolean;
  reason?: string;
  decision: PolicyDecisionType;
  riskLevel?: RiskLevel;
  capability?: PermissionCapability;
  cached?: boolean;
  durationMs?: number;
}

export interface CapabilityConfig {
  read?: boolean;
  create?: boolean;
  modify?: boolean;
  delete?: boolean;
  execute?: boolean;
  reset?: boolean;
  network?: boolean;
  system?: boolean;
  dynamicExecution?: boolean;
}

export interface SecurityPolicyConfig {
  version?: string;
  defaultMode?: SandboxMode;
  capabilities?: CapabilityConfig;
  allowedCommands?: string[];
  blockedCommands?: string[];
  allowedReadPaths?: string[];
  allowedWritePaths?: string[];
  blockedPaths?: string[];
  allowedDomains?: string[];
  blockedDomains?: string[];
  protectSecrets?: boolean;
  auditLogging?: boolean;
  rateLimit?: {
    maxPerMinute?: number;
    maxPerTurn?: number;
    maxConcurrent?: number;
    maxPerSession?: number;
    windowMs?: number;
    sessionWindowMs?: number;
  };
}

export type SecurityAuditDecision =
  | "ALLOW"
  | "DENY"
  | "ASK"
  | "APPROVED"
  | "USER_DENIED"
  | "SANDBOX_BLOCK"
  | "EXECUTION_ERROR"
  | "ALLOWED"
  | "APPROVED_BY_USER"
  | "DENIED_BY_USER"
  | "BLOCKED_BY_POLICY"
  | "POLICY_EVALUATED"
  | "TOOL_REQUEST"
  | "SECURITY_EVALUATION"
  | "APPROVAL"
  | "EXECUTION_START"
  | "EXECUTION_COMPLETE"
  | "RATE_LIMITED"
  /** Phase 77: a lifecycle hook vetoed the call before any side effect. */
  | "BLOCKED_BY_HOOK";

export interface SecurityAuditEvent {
  timestamp?: number | string;
  toolName?: string;
  action?: string;
  args: any;
  riskLevel?: RiskLevel;
  category?: ActionCategory;
  capability?: PermissionCapability;
  mode: SandboxMode;
  decision?: SecurityAuditDecision;
  allowed?: boolean;
  cwd?: string;
  reason?: string;
  target?: string;
  userSessionId?: string;
  correlationId?: string;
  toolCallId?: string;
  userId?: string;
  workspaceId?: string;
  agentRole?: string;
  source?: string;
  durationMs?: number;
  requestSize?: number;
  responseSize?: number;
  result?: string;
  metadata?: Record<string, unknown>;
}

