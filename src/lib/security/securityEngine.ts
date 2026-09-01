import path from "node:path";
import fs from "node:fs";
import type {
  ActionCategory,
  PermissionCapability,
  PermissionResult,
  RiskLevel,
  SandboxMode,
  ToolExecutionContext,
} from "./types";
import { isSensitiveFile } from "./secretGuard";
import { classifyShellCommand } from "./commandClassifier";
import { policyEngine } from "./policyEngine";
import { sessionTrust } from "./sessionTrust";
import { auditLogger } from "./auditLogger";
import {
  isPathInsideWorkspace,
  resolveRealPath,
  getRealWorkspaceRoot,
  evaluateWorkspacePolicy,
  type PathCheckResult,
} from "./workspacePolicy";

export class SecurityEngine {
  private currentMode: SandboxMode = "workspace";
  private pluginTools = new Set<string>();

  setMode(mode: SandboxMode) {
    this.currentMode = mode;
  }

  /**
   * Registers a tool name as plugin-governed. Plugin tools are validated by the
   * plugin's own capability-grant model (see PluginManager.executePluginTool), so
   * the generic external-MCP-tool heuristic must not blanket-block them.
   */
  registerPluginTool(name: string): void {
    if (name) this.pluginTools.add(name);
  }

  unregisterPluginTool(name: string): void {
    this.pluginTools.delete(name);
  }

  isPluginTool(name: string): boolean {
    return this.pluginTools.has(name);
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
    workspaceRoot?: string,
    context?: ToolExecutionContext
  ): PermissionResult {
    const baseCwd = cwd || process.cwd();
    const wsRoot = workspaceRoot || process.cwd();
    const category = this.categorizeTool(toolName);

    // ── Subagent Recursion & Role Isolation Gates ───────────────────────────
    if (context?.agentDepth !== undefined && context.agentDepth >= 1) {
      if (toolName === "spawn_subagent" || toolName === "delegate_task") {
        return {
          decision: "DENY",
          allowed: false,
          needsApproval: false,
          riskLevel: "CRITICAL_DENY",
          capability: "SYSTEM",
          reason: "Nested subagent spawning is prohibited for subagents (depth limit reached).",
        };
      }
    }

    if (context?.agentRole) {
      const canonicalRole = String(context.agentRole).toLowerCase();
      const mutatingTools = new Set([
        "write_file", "edit_file", "replace_all", "apply_patch", "patch",
        "delete_file", "create_artifact", "update_artifact", "shell", "run_command", "bash"
      ]);

      if (canonicalRole === "researcher" || canonicalRole === "reviewer") {
        if (mutatingTools.has(toolName)) {
          return {
            decision: "DENY",
            allowed: false,
            needsApproval: false,
            riskLevel: "CRITICAL_DENY",
            capability: "MODIFY",
            reason: `Role '${context.agentRole}' is read-only and cannot execute mutating or shell tool '${toolName}'.`,
          };
        }
      }
    }

    // ── 1. STEP 1: CRITICAL_DENY (INVIOLABLE — NEVER OVERRIDDEN BY WHITELIST, TRUST, OR FULL-ACCESS) ──
    if (category === "SHELL_EXECUTE") {
      const command = String(args?.command || args?.cmd || "").trim();
      const analysis = classifyShellCommand(command, wsRoot, baseCwd);
      const capability = this.determineShellCapability(command);

      if (analysis.riskLevel === "CRITICAL_DENY" || analysis.isCritical) {
        auditLogger.logEvent({
          timestamp: Date.now(),
          toolName,
          args,
          riskLevel: "CRITICAL_DENY",
          category,
          capability,
          mode,
          decision: "BLOCKED_BY_POLICY",
          reason: analysis.reason || "Catastrophic command blocked by invariant security policy.",
        });
        return {
          decision: "DENY",
          allowed: false,
          needsApproval: false,
          riskLevel: "CRITICAL_DENY",
          capability,
          reason: `Blocked by Security Policy: ${analysis.reason || "Catastrophic destruction command blocked."}`,
        };
      }
    }

    if (category === "FILE_READ" || category === "FILE_WRITE" || category === "FILE_DELETE") {
      const isDelete = category === "FILE_DELETE" || toolName.includes("delete") || toolName.includes("remove");
      const targetPath = toolName.includes("artifact")
        ? `.artifacts/${args?.name || ""}`
        : (args?.path || args?.root || args?.query || ".");
      const pathCheck = this.checkPathInsideWorkspace(targetPath, wsRoot, baseCwd);

      if (isDelete && (pathCheck.resolvedPath === "/" || pathCheck.resolvedPath === wsRoot + "/.git" || pathCheck.resolvedPath.endsWith("/.git"))) {
        return {
          decision: "DENY",
          allowed: false,
          needsApproval: false,
          riskLevel: "CRITICAL_DENY",
          capability: "DELETE",
          reason: "Destruction of root directory or .git repository is permanently blocked.",
        };
      }
    }

    let fileCapability: PermissionCapability = "READ";
    // ── 2. STEP 2: SECRET / PATH TRAVERSAL / PATH POLICY ────────────────────
    if (category === "FILE_READ" || category === "FILE_WRITE" || category === "FILE_DELETE") {
      const isWrite = category === "FILE_WRITE";
      const isDelete = category === "FILE_DELETE" || toolName.includes("delete") || toolName.includes("remove");
      const targetPath = toolName.includes("artifact")
        ? `.artifacts/${args?.name || ""}`
        : (args?.path || args?.root || args?.query || ".");
      const pathCheck = this.checkPathInsideWorkspace(targetPath, wsRoot, baseCwd);
      const isSecret = isSensitiveFile(pathCheck.resolvedPath);
      const fileExists = fs.existsSync(pathCheck.resolvedPath);

      if (isDelete) fileCapability = "DELETE";
      else if (isWrite) fileCapability = fileExists ? "MODIFY" : "CREATE";
      else fileCapability = "READ";

      // Blacklisted / path policy check
      if (!policyEngine.isPathAllowedByPolicy(pathCheck.resolvedPath, isWrite || isDelete ? "write" : "read")) {
        return {
          decision: "DENY",
          allowed: false,
          needsApproval: false,
          riskLevel: "CRITICAL_DENY",
          capability: fileCapability,
          reason: `Access to path '${targetPath}' is blocked by project security policy.`,
        };
      }

      // Secret check in workspace mode
      if (isSecret.isSensitive && mode === "workspace") {
        return {
          decision: "DENY",
          allowed: false,
          needsApproval: false,
          riskLevel: "DANGEROUS",
          capability: fileCapability,
          reason: `Access to sensitive credential file blocked by security sandbox: ${isSecret.reason}`,
        };
      }

      // Outside workspace in workspace mode
      if (!pathCheck.isInside && mode === "workspace") {
        return {
          decision: "DENY",
          allowed: false,
          needsApproval: false,
          riskLevel: "DANGEROUS",
          capability: fileCapability,
          reason: `Path traversal blocked: "${targetPath}" resolves outside workspace (${pathCheck.realWorkspaceRoot}). In 'workspace' mode, accessing files outside the workspace is strictly prohibited.`,
        };
      }
    }

    // ── 3. STEP 3: CAPABILITY LOCKS ─────────────────────────────────────────
    let toolCap: PermissionCapability = fileCapability;
    if (category === "SHELL_EXECUTE") toolCap = this.determineShellCapability(String(args?.command || args?.cmd || ""));
    else if (category === "FILE_DELETE") toolCap = "DELETE";
    else if (category === "FILE_WRITE") toolCap = fileCapability;
    else if (category === "FILE_READ") toolCap = "READ";
    else if (category === "NETWORK_FETCH" || category === "BROWSER_AUTOMATION") toolCap = "NETWORK";
    else if (category === "SYSTEM_ADMIN") toolCap = "SYSTEM";
    else if (category === "MCP_TOOL") toolCap = "EXECUTE";

    // 2.5. PATH CHECK FOR SHELL EXECUTE: block absolute paths outside workspace
    let shellPathsInsideWorkspace = true;
    if (category === "SHELL_EXECUTE") {
      const command = String(args?.command || args?.cmd || "").trim();
      const analysis = classifyShellCommand(command, wsRoot, baseCwd);
      const candidatePaths: string[] = [];
      if (analysis.ast) {
        for (const node of analysis.ast.nodes) {
          for (const arg of node.args) {
            if (arg.startsWith("/") && !arg.includes("://")) {
              candidatePaths.push(arg);
            }
          }
          for (const redir of node.redirections) {
            if (redir.target.startsWith("/") && !redir.target.includes("://")) {
              candidatePaths.push(redir.target);
            }
          }
          for (const sub of node.subCommands) {
            for (const arg of sub.args) {
              if (arg.startsWith("/") && !arg.includes("://")) {
                candidatePaths.push(arg);
              }
            }
          }
        }
      }
      for (const p of candidatePaths) {
        const pathCheck = this.checkPathInsideWorkspace(p, wsRoot, baseCwd);
        if (!pathCheck.isInside) {
          return {
            decision: "DENY",
            allowed: false,
            needsApproval: false,
            riskLevel: "DANGEROUS",
            capability: toolCap,
            reason: `Path traversal blocked: "${p}" resolves outside workspace (${pathCheck.realWorkspaceRoot}). In 'workspace' mode, accessing files outside the workspace is strictly prohibited.`,
          };
        }
      }
      shellPathsInsideWorkspace = candidatePaths.length > 0;
    }

    if (mode !== "full-access" && !policyEngine.isCapabilityAllowed(toolCap)) {
      // Allow file operations inside the workspace for shell commands with explicit workspace paths
      if (mode === "workspace" && category === "SHELL_EXECUTE" && shellPathsInsideWorkspace && ["DELETE", "MODIFY", "CREATE"].includes(toolCap)) {
        // Allow
      } else if (mode === "workspace") {
        return { decision: "DENY", allowed: false, needsApproval: false, riskLevel: "DANGEROUS", capability: toolCap, reason: `Action requires '${toolCap}' capability which is currently locked by security policy.` };
      }
      if (mode === "ask") {
        return { decision: "ASK", allowed: false, needsApproval: true, riskLevel: "DANGEROUS", capability: toolCap, reason: `Action requires '${toolCap}' capability which is currently locked by security policy.` };
      }
    }

    // ── 4. STEP 4: POLICY BLACKLIST ─────────────────────────────────────────
    if (category === "SHELL_EXECUTE") {
      const command = String(args?.command || args?.cmd || "").trim();
      const blacklisted = policyEngine.isCommandBlacklisted(command);
      if (blacklisted.isBlacklisted) {
        return { decision: "DENY", allowed: false, needsApproval: false, riskLevel: "CRITICAL_DENY", capability: toolCap, reason: blacklisted.reason };
      }
    }

    // ── 5. STEP 5: SHELL / CLASSIFIER RISK ──────────────────────────────────
    let analysisRisk: RiskLevel = "SAFE_READ";
    let analysisReason: string | undefined;
    let analysisSuggested: string | undefined;

    if (category === "SHELL_EXECUTE") {
      const command = String(args?.command || args?.cmd || "").trim();
      const analysis = classifyShellCommand(command, wsRoot, baseCwd);
      analysisRisk = analysis.riskLevel;
      analysisReason = analysis.reason;
      analysisSuggested = analysis.suggestedAction;
    }

    // ── 6. STEP 6: POLICY WHITELIST ─────────────────────────────────────────
    if (category === "SHELL_EXECUTE") {
      const command = String(args?.command || args?.cmd || "").trim();
      if (policyEngine.isCommandWhitelisted(command)) {
        return { decision: "ALLOW", allowed: true, needsApproval: false, riskLevel: "SAFE_BUILD", capability: toolCap, matchedRule: "whitelist" };
      }
    }

    // ── 7. STEP 7: SESSION TRUST ────────────────────────────────────────────
    const targetKey = category === "SHELL_EXECUTE"
      ? String(args?.command || args?.cmd || "").trim()
      : (args?.path || args?.name || args?.url || "");

    if (sessionTrust.isDeniedForSession(toolName, targetKey)) {
      return { decision: "DENY", allowed: false, needsApproval: false, riskLevel: "DANGEROUS", capability: toolCap, reason: "Action was previously denied for this session." };
    }

    if (sessionTrust.isTrustedForSession(toolName, targetKey, mode)) {
      return { decision: "ALLOW", allowed: true, needsApproval: false, riskLevel: analysisRisk === "DANGEROUS" ? "SAFE_BUILD" : analysisRisk, capability: toolCap };
    }

    // ── 8. STEP 8: FINAL POLICY DECISION ────────────────────────────────────
    if (mode === "full-access") {
      const intrinsic = this.assessIntrinsicRisk(toolName, args, category, wsRoot, baseCwd);
      return { decision: "ALLOW", allowed: true, needsApproval: false, riskLevel: intrinsic.riskLevel, capability: intrinsic.capability };
    }

    if (mode === "ask") {
      // In ask mode, dangerous shell, sensitive secrets, or out-of-workspace need user approval
      if (category === "SHELL_EXECUTE" && analysisRisk === "DANGEROUS") {
        return { decision: "ASK", allowed: false, needsApproval: true, riskLevel: "DANGEROUS", capability: toolCap, reason: analysisReason || "Command requires user confirmation.", suggestedAction: analysisSuggested };
      }
      if (category === "FILE_READ" || category === "FILE_WRITE" || category === "FILE_DELETE") {
        const targetPath = args?.path || args?.root || ".";
        const pathCheck = this.checkPathInsideWorkspace(targetPath, wsRoot, baseCwd);
        const isSecret = isSensitiveFile(pathCheck.resolvedPath);
        if (!pathCheck.isInside || isSecret.isSensitive) {
          return { decision: "ASK", allowed: false, needsApproval: true, riskLevel: "DANGEROUS", capability: toolCap, reason: isSecret.isSensitive ? `Access to sensitive file: ${isSecret.reason}` : `Access outside workspace: ${pathCheck.resolvedPath}` };
        }
      }
      if (category === "MCP_TOOL" && !this.isPluginTool(toolName)) {
        return { decision: "ASK", allowed: false, needsApproval: true, riskLevel: "DANGEROUS", capability: toolCap, reason: `External MCP tool '${toolName}' requires user confirmation.` };
      }
      return { decision: "ALLOW", allowed: true, needsApproval: false, riskLevel: analysisRisk, capability: toolCap };
    }

    // workspace mode
    if (category === "SHELL_EXECUTE" && analysisRisk === "DANGEROUS") {
      return { decision: "DENY", allowed: false, needsApproval: false, riskLevel: "DANGEROUS", capability: toolCap, reason: `Blocked in 'workspace' sandbox mode: ${analysisReason || "Dangerous command"}` };
    }

    if (category === "MCP_TOOL" && !this.isPluginTool(toolName)) {
      const isReadOnly = /^(read|list|get|inspect|search|find|view|query)/i.test(toolName);
      if (!isReadOnly) {
        return { decision: "DENY", allowed: false, needsApproval: false, riskLevel: "DANGEROUS", capability: toolCap, reason: `Mutating external MCP tool '${toolName}' is blocked in workspace mode.` };
      }
    }

    return { decision: "ALLOW", allowed: true, needsApproval: false, riskLevel: analysisRisk, capability: toolCap };
  }

  assessIntrinsicRisk(
    toolName: string,
    args: any,
    category: ActionCategory,
    wsRoot?: string,
    baseCwd?: string
  ): { riskLevel: RiskLevel; capability: PermissionCapability } {
    const root = wsRoot || process.cwd();
    const cwd = baseCwd || process.cwd();

    if (category === "SHELL_EXECUTE") {
      const command = String(args?.command || args?.cmd || "").trim();
      const analysis = classifyShellCommand(command, root, cwd);
      const cap = this.determineShellCapability(command);
      return { riskLevel: analysis.riskLevel, capability: cap };
    }

    if (category === "FILE_READ" || category === "FILE_WRITE" || category === "FILE_DELETE") {
      const isWrite = category === "FILE_WRITE";
      const isDelete = category === "FILE_DELETE" || toolName.includes("delete") || toolName.includes("remove");
      const targetPath = toolName.includes("artifact")
        ? `.artifacts/${args?.name || ""}`
        : (args?.path || args?.root || args?.query || ".");

      const pathCheck = this.checkPathInsideWorkspace(targetPath, root, cwd);
      const isSecret = isSensitiveFile(pathCheck.resolvedPath);
      let cap: PermissionCapability = "READ";
      if (isDelete) cap = "DELETE";
      else if (isWrite) cap = "MODIFY";

      if (isSecret.isSensitive || !pathCheck.isInside || isDelete) {
        return { riskLevel: "DANGEROUS", capability: cap };
      }
      return { riskLevel: isWrite ? "MODERATE_WRITE" : "SAFE_READ", capability: cap };
    }

    if (category === "NETWORK_FETCH" || category === "BROWSER_AUTOMATION") {
      return { riskLevel: "MODERATE_WRITE", capability: "NETWORK" };
    }

    if (category === "MCP_TOOL") {
      const isReadOnly = /^(read|list|get|inspect|search|find|view|query)/i.test(toolName);
      return { riskLevel: isReadOnly ? "SAFE_READ" : "MODERATE_WRITE", capability: "EXECUTE" };
    }

    return { riskLevel: "SAFE_READ", capability: "READ" };
  }

  private determineShellCapability(command: string): PermissionCapability {
    const trimmed = command.trim();
    if (/\bgit\s+(reset\s+--hard|clean|restore|checkout\s+(\.|-f))/i.test(trimmed)) {
      return "RESET";
    }
    if (/\b(rm\s|rmdir|unlink|drop\s+database)/i.test(trimmed)) {
      return "DELETE";
    }
    if (/\b(sudo|reboot|shutdown|systemctl|iptables|chmod\s+777)/i.test(trimmed)) {
      return "SYSTEM";
    }
    if (/\b(curl|wget|ping|ssh|scp)\b/i.test(trimmed)) {
      return "NETWORK";
    }
    // Check for dynamic execution patterns
    if (this.isDynamicExecution(trimmed)) {
      return "DYNAMIC_EXECUTION";
    }
    return "EXECUTE";
  }

  /**
   * Detects dynamic execution patterns that require DYNAMIC_EXECUTION capability.
   * These are patterns where command behavior depends on runtime expansion
   * that static analysis cannot fully determine.
   */
  private isDynamicExecution(command: string): boolean {
    // eval
    if (/\beval\s+/.test(command)) return true;

    // bash -c, sh -c, zsh -c, dash -c
    if (/\b(bash|sh|zsh|dash)\s+-c\s+/.test(command)) return true;

    // python -c, python3 -c
    if (/\bpython3?\s+-c\s+/.test(command)) return true;

    // node -e
    if (/\bnode\s+-e\s+/.test(command)) return true;

    // perl -e
    if (/\bperl\s+-e\s+/.test(command)) return true;

    // ruby -e
    if (/\bruby\s+-e\s+/.test(command)) return true;

    // env VAR=value sh -c or env VAR=value bash -c
    if (/\benv\s+[A-Z_]+\s*=\s*.*\s+(bash|sh)\s+-c/.test(command)) return true;

    // command ... (command wrapper)
    if (/\bcommand\s+/.test(command)) return true;

    // exec ... (exec wrapper)
    if (/\bexec\s+/.test(command)) return true;

    // nohup ...
    if (/\bnohup\s+/.test(command)) return true;

    // sudo, nice, timeout as wrappers
    if (/\b(sudo|nice|timeout)\s+/.test(command)) return true;

    // xargs sh -c, xargs bash -c
    if (/\bxargs\s+.*\s+(bash|sh)\s+-c/.test(command)) return true;

    // find -exec, find -execdir
    if (/\bfind\s+.*\s+-exec(dir)?\s+/.test(command)) return true;

    // find -delete
    if (/\bfind\s+.*\s+-delete\b/.test(command)) return true;

    // Variable in command position: $CMD, ${CMD}
    if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Za-z_][A-Za-z0-9_]*\s+/.test(command)) return true;

    return false;
  }

  categorizeTool(toolName: string): ActionCategory {
    if (["run_command", "shell", "bash", "exec", "terminal"].includes(toolName)) return "SHELL_EXECUTE";
    if (["write_file", "edit_file", "replace_all", "apply_patch", "create_artifact", "update_artifact"].includes(toolName)) {
      return "FILE_WRITE";
    }
    if (["delete_file", "remove_file", "file_delete"].includes(toolName)) {
      return "FILE_DELETE";
    }
    if (["read_file", "file_exists", "list_dir", "tree", "grep", "glob", "glob_search", "grep_search", "find_path", "git_status", "git_diff", "get_cwd"].includes(toolName)) {
      return "FILE_READ";
    }
    if (["web_fetch", "audit_url", "curl", "wget", "fetch", "network"].includes(toolName)) return "NETWORK_FETCH";
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

    let rel = path.relative(realRoot, realTarget);
    let isInside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));

    if (!isInside && !workspaceRoot) {
      try {
        const { getWorkspaceRoots } = require("../codingAgent");
        const roots: string[] = getWorkspaceRoots();
        for (const r of roots) {
          let rReal = r;
          try {
            rReal = fs.realpathSync(r);
          } catch {
            rReal = path.resolve(r);
          }
          const rRel = path.relative(rReal, realTarget);
          if (rRel === "" || (!rRel.startsWith("..") && !path.isAbsolute(rRel))) {
            isInside = true;
            rel = rRel;
            realRoot = rReal;
            break;
          }
        }
      } catch {}
    }

    return {
      isInside,
      resolvedPath: realTarget,
      realWorkspaceRoot: realRoot,
      relative: rel,
    };
  }
}

export const securityEngine = new SecurityEngine();
