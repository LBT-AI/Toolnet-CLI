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
  | "SYSTEM";    // Sudo, system configs, process termination, hardware (Strictly Locked / Critical Deny)

export type TrustDuration = "ONCE" | "SESSION" | "DENIED" | "ALWAYS";

export interface PermissionResult {
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

export interface CapabilityConfig {
  read?: boolean;
  create?: boolean;
  modify?: boolean;
  delete?: boolean;
  execute?: boolean;
  reset?: boolean;
  network?: boolean;
  system?: boolean;
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

export interface SecurityAuditEvent {
  timestamp?: number | string;
  toolName?: string;
  action?: string;
  args: any;
  riskLevel?: RiskLevel;
  category?: ActionCategory;
  capability?: PermissionCapability;
  mode: SandboxMode;
  decision?: "ALLOWED" | "APPROVED_BY_USER" | "DENIED_BY_USER" | "BLOCKED_BY_POLICY";
  allowed?: boolean;
  cwd?: string;
  reason?: string;
  target?: string;
  userSessionId?: string;
  metadata?: Record<string, unknown>;
}

