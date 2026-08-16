import path from "node:path";
import fs from "node:fs";
import type {
  ActionCategory,
  PermissionResult,
  RiskLevel,
  SandboxMode,
} from "./types";
import { isSensitiveFile } from "./secretGuard";
import { classifyShellCommand } from "./commandClassifier";
import { policyEngine } from "./policyEngine";
import { sessionTrust } from "./sessionTrust";
import { auditLogger } from "./auditLogger";

export class SecurityEngine {
  private currentMode: SandboxMode = "ask";

  setMode(mode: SandboxMode) {
    this.currentMode = mode;
  }

  getMode(): SandboxMode {
    return this.currentMode;
  }

  /**
   * Evaluates security permission for any tool execution request.
   */
  evaluate(
    toolName: string,
    args: any,
    mode: SandboxMode = this.currentMode,
    cwd?: string,
    workspaceRoot?: string
  ): PermissionResult {
    const baseCwd = cwd || process.cwd();
    const wsRoot = workspaceRoot || process.cwd();

    // 1. Full access bypass
    if (mode === "full-access") {
      auditLogger.logEvent({
        timestamp: Date.now(),
        toolName,
        args,
        riskLevel: "SAFE_READ",
        category: this.categorizeTool(toolName),
        mode,
        decision: "ALLOWED",
        reason: "Full-access sandbox mode active",
      });
      return { allowed: true, needsApproval: false, riskLevel: "SAFE_READ" };
    }

    const category = this.categorizeTool(toolName);

    // 2. Shell Command Evaluation
    if (category === "SHELL_EXECUTE") {
      const command = String(args?.command || args?.cmd || "").trim();
      const targetKey = command;

      // Check Session Trust
      if (sessionTrust.isTrustedForSession(toolName, targetKey)) {
        return { allowed: true, needsApproval: false, riskLevel: "SAFE_READ" };
      }
      if (sessionTrust.isDeniedForSession(toolName, targetKey)) {
        return { allowed: false, needsApproval: false, reason: "Command was previously denied for this session." };
      }

      // Check Policy Whitelist
      if (policyEngine.isCommandWhitelisted(command)) {
        auditLogger.logEvent({
          timestamp: Date.now(),
          toolName,
          args,
          riskLevel: "SAFE_BUILD",
          category,
          mode,
          decision: "ALLOWED",
          reason: "Command is explicitly whitelisted in security policy",
        });
        return { allowed: true, needsApproval: false, riskLevel: "SAFE_BUILD", matchedRule: "whitelist" };
      }

      // Check Policy Blacklist
      const blacklisted = policyEngine.isCommandBlacklisted(command);
      if (blacklisted.isBlacklisted) {
        auditLogger.logEvent({
          timestamp: Date.now(),
          toolName,
          args,
          riskLevel: "CRITICAL_DENY",
          category,
          mode,
          decision: "BLOCKED_BY_POLICY",
          reason: blacklisted.reason,
        });
        return { allowed: false, needsApproval: false, reason: blacklisted.reason, riskLevel: "CRITICAL_DENY" };
      }

      // Classify command semantics & risk
      const analysis = classifyShellCommand(command);

      if (analysis.riskLevel === "CRITICAL_DENY") {
        auditLogger.logEvent({
          timestamp: Date.now(),
          toolName,
          args,
          riskLevel: analysis.riskLevel,
          category,
          mode,
          decision: "BLOCKED_BY_POLICY",
          reason: analysis.reason,
        });
        return {
          allowed: false,
          needsApproval: false,
          riskLevel: analysis.riskLevel,
          reason: `Blocked by Security Policy: ${analysis.reason}`,
        };
      }

      if (analysis.riskLevel === "DANGEROUS") {
        if (mode === "workspace") {
          auditLogger.logEvent({
            timestamp: Date.now(),
            toolName,
            args,
            riskLevel: analysis.riskLevel,
            category,
            mode,
            decision: "BLOCKED_BY_POLICY",
            reason: analysis.reason,
          });
          return {
            allowed: false,
            needsApproval: false,
            riskLevel: analysis.riskLevel,
            reason: `Blocked in 'workspace' sandbox mode: ${analysis.reason}`,
          };
        }

        // Mode 'ask' -> Prompt user
        return {
          allowed: true,
          needsApproval: true,
          riskLevel: analysis.riskLevel,
          reason: analysis.reason,
          suggestedAction: analysis.suggestedAction,
        };
      }

      // Safe commands in workspace or ask mode
      return { allowed: true, needsApproval: false, riskLevel: analysis.riskLevel };
    }

    // 3. File & Resource Tool Evaluation
    if (category === "FILE_READ" || category === "FILE_WRITE") {
      const isWrite = category === "FILE_WRITE";
      const targetPath = toolName.includes("artifact")
        ? `.artifacts/${args?.name || ""}`
        : (args?.path || args?.root || args?.query || ".");

      const pathCheck = this.checkPathInsideWorkspace(targetPath, wsRoot, baseCwd);
      const isSecret = isSensitiveFile(pathCheck.resolvedPath);

      // Secret Protection
      if (isSecret.isSensitive) {
        if (mode === "workspace") {
          return {
            allowed: false,
            needsApproval: false,
            riskLevel: "DANGEROUS",
            reason: `Access to sensitive file blocked by security sandbox: ${isSecret.reason}`,
          };
        }
        if (mode === "ask") {
          if (sessionTrust.isTrustedForSession(toolName, pathCheck.resolvedPath)) {
            return { allowed: true, needsApproval: false, riskLevel: "MODERATE_WRITE" };
          }
          return {
            allowed: true,
            needsApproval: true,
            riskLevel: "DANGEROUS",
            reason: `Warning: Tool "${toolName}" targets sensitive secret credentials (${isSecret.reason})`,
          };
        }
      }

      // Path Traversal Check
      if (!pathCheck.isInside) {
        if (mode === "workspace") {
          return {
            allowed: false,
            needsApproval: false,
            riskLevel: "DANGEROUS",
            reason: `Path traversal blocked: "${targetPath}" resolves outside workspace (${pathCheck.realWorkspaceRoot}). In 'workspace' mode, accessing files outside the workspace is strictly prohibited.`,
          };
        }
        if (mode === "ask") {
          if (sessionTrust.isTrustedForSession(toolName, pathCheck.resolvedPath)) {
            return { allowed: true, needsApproval: false, riskLevel: "MODERATE_WRITE" };
          }
          return {
            allowed: true,
            needsApproval: true,
            riskLevel: isWrite ? "DANGEROUS" : "MODERATE_WRITE",
            reason: `Tool "${toolName}" accesses path outside workspace: "${pathCheck.resolvedPath}"`,
          };
        }
      }

      // Project File Integrity Protection (Anti-Accidental-Wipe)
      const baseName = path.basename(pathCheck.resolvedPath).toLowerCase();
      const isCriticalProjectFile = ["package.json", "tsconfig.json", "cargo.toml", "go.mod", "pom.xml", ".gitignore"].includes(baseName);
      if (isWrite && isCriticalProjectFile && fs.existsSync(pathCheck.resolvedPath)) {
        const content = String(args?.content || args?.replacement || "").trim();
        if (content.length === 0) {
          if (mode === "workspace") {
            return {
              allowed: false,
              needsApproval: false,
              riskLevel: "DANGEROUS",
              reason: `Emptying/blanking critical project configuration file "${baseName}" is blocked by security policy.`,
            };
          }
          if (mode === "ask") {
            return {
              allowed: true,
              needsApproval: true,
              riskLevel: "DANGEROUS",
              reason: `Warning: Tool "${toolName}" is attempting to write empty content to critical project file "${baseName}".`,
            };
          }
        }
      }

      return { allowed: true, needsApproval: false, riskLevel: isWrite ? "MODERATE_WRITE" : "SAFE_READ" };
    }

    // 4. Web & Browser Tools
    if (category === "NETWORK_FETCH" || category === "BROWSER_AUTOMATION") {
      const action = args?.action || "fetch";
      if (mode === "ask" && (action === "click" || action === "fill" || action === "evaluate")) {
        return {
          allowed: true,
          needsApproval: true,
          riskLevel: "MODERATE_WRITE",
          reason: `Browser automation action '${action}' requires user confirmation.`,
        };
      }
      return { allowed: true, needsApproval: false, riskLevel: "SAFE_READ" };
    }

    // 5. MCP Tools Evaluation
    if (category === "MCP_TOOL") {
      if (mode === "ask") {
        if (sessionTrust.isTrustedForSession(toolName)) {
          return { allowed: true, needsApproval: false, riskLevel: "SAFE_READ" };
        }
      }
      return { allowed: true, needsApproval: false, riskLevel: "SAFE_READ" };
    }

    return { allowed: true, needsApproval: false, riskLevel: "SAFE_READ" };
  }

  private categorizeTool(toolName: string): ActionCategory {
    if (toolName === "run_command" || toolName === "shell") return "SHELL_EXECUTE";
    if (["write_file", "edit_file", "replace_all", "apply_patch", "create_artifact", "update_artifact"].includes(toolName)) {
      return "FILE_WRITE";
    }
    if (["read_file", "file_exists", "list_dir", "tree", "grep", "glob", "find_path", "git_status", "git_diff"].includes(toolName)) {
      return "FILE_READ";
    }
    if (["web_fetch", "audit_url"].includes(toolName)) return "NETWORK_FETCH";
    if (["browser", "browser_action"].includes(toolName)) return "BROWSER_AUTOMATION";
    return "MCP_TOOL";
  }

  private checkPathInsideWorkspace(targetPath: string, workspaceRoot?: string, cwd?: string) {
    const root = workspaceRoot || process.cwd();
    const baseCwd = cwd || process.cwd();

    let realRoot = root;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      realRoot = path.resolve(root);
    }

    const absPath = path.isAbsolute(targetPath) ? path.normalize(targetPath) : path.resolve(baseCwd, targetPath);
    let realTarget = absPath;
    try {
      realTarget = fs.realpathSync(absPath);
    } catch {
      const parentDir = path.dirname(absPath);
      const fileName = path.basename(absPath);
      try {
        const realParent = fs.realpathSync(parentDir);
        realTarget = path.join(realParent, fileName);
      } catch {
        realTarget = absPath;
      }
    }

    const rel = path.relative(realRoot, realTarget);
    const isInside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));

    return {
      isInside,
      resolvedPath: realTarget,
      realWorkspaceRoot: realRoot,
      relative: rel,
    };
  }
}

export const securityEngine = new SecurityEngine();
