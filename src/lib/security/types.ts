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
  | "SHELL_EXECUTE"
  | "NETWORK_FETCH"
  | "BROWSER_AUTOMATION"
  | "MCP_TOOL"
  | "SYSTEM_ADMIN";

export type TrustDuration = "ONCE" | "SESSION" | "DENIED" | "ALWAYS";

export interface PermissionResult {
  allowed: boolean;
  needsApproval: boolean;
  riskLevel?: RiskLevel;
  category?: ActionCategory;
  reason?: string;
  resolvedPath?: string;
  matchedRule?: string;
  suggestedAction?: string;
}

export interface SecurityPolicyConfig {
  version?: string;
  defaultMode?: SandboxMode;
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
  timestamp: number;
  toolName: string;
  args: any;
  riskLevel: RiskLevel;
  category: ActionCategory;
  mode: SandboxMode;
  decision: "ALLOWED" | "APPROVED_BY_USER" | "DENIED_BY_USER" | "BLOCKED_BY_POLICY";
  reason?: string;
  target?: string;
  userSessionId?: string;
}
