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
  | "EXECUTION_START"
  | "EXECUTION_COMPLETE";

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
  metadata?: Record<string, unknown>;
}

