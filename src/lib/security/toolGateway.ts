import { securityEngine } from "./securityEngine";
import { auditLogger } from "./auditLogger";
import { redactSecrets } from "./secretGuard";
import { getSandboxMode } from "../permissions";
import { _executeToolRaw, getToolCache } from "../agentTools";
import { compressToolResult } from "../harness/toolOutputCompressor";
import type { ToolExecutionContext, ToolGatewayResult, SandboxMode, SecurityAuditDecision } from "./types";
import { randomUUID } from "node:crypto";
import { toolRateLimiter, type ToolRateLimitContext, type ToolRateLimitResult } from "./toolRateLimiter";

export class ToolGateway {
  /**
   * Universal Single Chokepoint for all tool executions across ToolNet CLI.
   * Layer 4 Phase 1 contract:
   *  - SecurityEngine.evaluate is the ONLY policy decision point.
   *  - CRITICAL_DENY can NEVER be overridden (not by userApproved, not by mode).
   *  - ASK returns needsApproval unless context.userApproved is true.
   *  - _executeToolRaw is the internal executor and re-gates nothing.
   */
  static async execute(
    call: { name: string; args: any; id?: string },
    context: ToolExecutionContext = {}
  ): Promise<ToolGatewayResult> {
    const startTime = Date.now();
    const name = call.name;
    const args = call.args || {};
    const cwd = context.cwd || process.cwd();
    const wsRoot = context.workspaceRoot || process.cwd();
    const mode: SandboxMode = context.sandboxMode || getSandboxMode();
    const correlationId = call.id || randomUUID();
    const toolCallId = call.id || correlationId;
    const sessionId = context.sessionId;
    const now = Date.now();

    const workspaceId = wsRoot ? wsRoot : undefined;
    const userId = context.userId;

    const auditMeta = {
      sessionId,
      userId,
      workspaceId,
      agentRole: context.agentRole,
      source: context.source,
      agentDepth: context.agentDepth,
    };

    // 0. TOOL_REQUEST
    auditLogger.logEvent({
      timestamp: now,
      toolName: name,
      action: name,
      args,
      mode,
      decision: "TOOL_REQUEST",
      allowed: true,
      cwd,
      correlationId,
      toolCallId,
      userSessionId: sessionId,
      userId,
      workspaceId,
      agentRole: context.agentRole,
      source: context.source,
      metadata: auditMeta,
    });

    // 0.5 RATE LIMIT CHECK
    if (sessionId) {
      const rateLimitContext: ToolRateLimitContext = {
        sessionId,
        toolName: name,
        now,
        source: context.source,
      };

      const rateLimitResult = toolRateLimiter.check(rateLimitContext);

      if (!rateLimitResult.allowed) {
        const rateLimitDuration = Date.now() - startTime;

        auditLogger.logEvent({
          timestamp: Date.now(),
          toolName: name,
          action: name,
          args,
          mode,
          decision: "RATE_LIMITED",
          allowed: false,
          cwd,
          reason: rateLimitResult.reason,
          correlationId,
          toolCallId,
          userSessionId: sessionId,
          userId,
          workspaceId,
          agentRole: context.agentRole,
          source: context.source,
          durationMs: rateLimitDuration,
          metadata: {
            ...auditMeta,
            retryAfterMs: rateLimitResult.retryAfterMs,
          },
        });

        return {
          stdout: "",
          stderr: `Rate Limited: ${rateLimitResult.reason}`,
          exitCode: 1,
          allowed: false,
          decision: "DENY",
          reason: rateLimitResult.reason,
          riskLevel: "MODERATE_WRITE",
          capability: "READ",
          durationMs: rateLimitDuration,
        };
      }
    }

    // 1. SECURITY_EVALUATION
    const decision = securityEngine.evaluate(name, args, mode, cwd, wsRoot, context);

    auditLogger.logEvent({
      timestamp: Date.now(),
      toolName: name,
      action: name,
      args,
      riskLevel: decision.riskLevel || "SAFE_READ",
      category: decision.category,
      capability: decision.capability,
      mode,
      decision: "SECURITY_EVALUATION",
      allowed: decision.allowed,
      cwd,
      reason: decision.reason,
      target: args?.path || args?.url || args?.name,
      correlationId,
      toolCallId,
      userSessionId: sessionId,
      userId,
      workspaceId,
      agentRole: context.agentRole,
      source: context.source,
      durationMs: Date.now() - startTime,
      metadata: {
        ...auditMeta,
        needsApproval: decision.needsApproval,
        matchedRule: decision.matchedRule,
      },
    });

    // Guard 1: CRITICAL_DENY or hard DENY — never executable, userApproved cannot override.
    if (
      decision.riskLevel === "CRITICAL_DENY" ||
      decision.decision === "DENY" ||
      (!decision.allowed && !decision.needsApproval)
    ) {
      const reason = decision.reason || "Blocked by security sandbox policy.";
      const durationMs = Date.now() - startTime;

      auditLogger.logEvent({
        timestamp: Date.now(),
        toolName: name,
        action: name,
        args,
        riskLevel: decision.riskLevel || "CRITICAL_DENY",
        category: decision.category,
        capability: decision.capability,
        mode,
        decision: "BLOCKED_BY_POLICY",
        allowed: false,
        cwd,
        reason,
        correlationId,
        toolCallId,
        userSessionId: sessionId,
        userId,
        workspaceId,
        agentRole: context.agentRole,
        source: context.source,
        durationMs,
        metadata: auditMeta,
      });

      return {
        stdout: "",
        stderr: `Permission Denied: ${reason}`,
        exitCode: 1,
        allowed: false,
        decision: "DENY",
        reason,
        riskLevel: decision.riskLevel,
        capability: decision.capability,
        durationMs,
      };
    }

    // Guard 2: ASK without prior user approval — return needsApproval (fail-closed).
    if ((decision.decision === "ASK" || decision.needsApproval) && !context.userApproved) {
      const reason = decision.reason || `Tool ${name} requires interactive approval.`;
      const durationMs = Date.now() - startTime;

      auditLogger.logEvent({
        timestamp: Date.now(),
        toolName: name,
        action: name,
        args,
        riskLevel: decision.riskLevel || "DANGEROUS",
        category: decision.category,
        capability: decision.capability,
        mode,
        decision: "ASK",
        allowed: false,
        cwd,
        reason,
        correlationId,
        toolCallId,
        userSessionId: sessionId,
        userId,
        workspaceId,
        agentRole: context.agentRole,
        source: context.source,
        durationMs,
        metadata: auditMeta,
      });

      return {
        stdout: "",
        stderr: `Approval Required: ${reason}`,
        exitCode: 1,
        allowed: false,
        needsApproval: true,
        approvalRequired: true,
        decision: "ASK",
        reason,
        riskLevel: decision.riskLevel,
        capability: decision.capability,
        durationMs,
      };
    }

    if (decision.decision === "ASK" || decision.needsApproval) {
      // Guard 3: userApproved=true but the action is session-denied or session-trusted
      // already re-evaluated. If the user previously DENIED this exact action for the
      // session, honor the denial even when userApproved=true.
      const targetKey = securityEngine.getSessionTrustTargetKey(name, args);
      if (targetKey && securityEngine.isSessionDenied(name, targetKey, context.sessionId)) {
        const durationMs = Date.now() - startTime;

        auditLogger.logEvent({
          timestamp: Date.now(),
          toolName: name,
          action: name,
          args,
          riskLevel: decision.riskLevel || "DANGEROUS",
          category: decision.category,
          capability: decision.capability,
          mode,
          decision: "DENIED_BY_USER",
          allowed: false,
          cwd,
          reason: "Action was previously denied for this session.",
          correlationId,
          toolCallId,
          userSessionId: sessionId,
          userId,
          workspaceId,
          agentRole: context.agentRole,
          source: context.source,
          durationMs,
          metadata: auditMeta,
        });

        return {
          stdout: "",
          stderr: "Permission Denied: Action was previously denied for this session.",
          exitCode: 1,
          allowed: false,
          decision: "DENY",
          reason: "Action was previously denied for this session.",
          riskLevel: decision.riskLevel,
          capability: decision.capability,
          durationMs,
        };
      }

      const durationMs = Date.now() - startTime;

      auditLogger.logEvent({
        timestamp: Date.now(),
        toolName: name,
        action: name,
        args,
        riskLevel: decision.riskLevel || "DANGEROUS",
        category: decision.category,
        capability: decision.capability,
        mode,
        decision: "APPROVED_BY_USER",
        allowed: true,
        cwd,
        reason: "Approved by user for this execution.",
        correlationId,
        toolCallId,
        userSessionId: sessionId,
        userId,
        workspaceId,
        agentRole: context.agentRole,
        source: context.source,
        durationMs,
        metadata: auditMeta,
      });
    }

    // Record rate limit before execution
    if (sessionId) {
      toolRateLimiter.record({
        sessionId,
        toolName: name,
        now: Date.now(),
        source: context.source,
      });
    }

    // 2. Cache check for read-only tools
    const toolCache = getToolCache();
    const cached = toolCache.get(name, args);
    if (cached !== null) {
      const durationMs = Date.now() - startTime;

      if (sessionId) {
        toolRateLimiter.release({ sessionId, toolName: name, now: Date.now() });
      }

      return {
        stdout: cached,
        stderr: "",
        exitCode: 0,
        allowed: true,
        cached: true,
        decision: "ALLOW",
        riskLevel: decision.riskLevel,
        capability: decision.capability,
        durationMs,
      };
    }

    // 3. EXECUTION_START
    auditLogger.logEvent({
      timestamp: Date.now(),
      toolName: name,
      action: name,
      args,
      riskLevel: decision.riskLevel || "SAFE_READ",
      category: decision.category,
      capability: decision.capability,
      mode,
      decision: "EXECUTION_START",
      allowed: true,
      cwd,
      correlationId,
      toolCallId,
      userSessionId: sessionId,
      userId,
      workspaceId,
      agentRole: context.agentRole,
      source: context.source,
      metadata: auditMeta,
    });

    // 4. Execution via internal raw executor (no re-gating inside).
    try {
      const rawJson = await _executeToolRaw(name, args, {
        cwd,
        workspaceRoot: wsRoot,
        sandboxMode: mode,
        signal: context.signal,
        userApproved: context.userApproved,
        sessionId: context.sessionId,
        agentRole: context.agentRole,
        agentDepth: context.agentDepth,
        source: context.source,
      });

      const sanitizedJson = compressToolResult(redactSecrets(rawJson), name);
      let exitCode = 0;
      try {
        const parsed = JSON.parse(rawJson);
        exitCode = parsed.exitCode !== undefined ? parsed.exitCode : (parsed.success === false ? 1 : 0);
      } catch {}

      const requestSize = JSON.stringify(args).length;
      const responseSize = rawJson.length;

      // Invalidate cache on mutating tools or store in cache on read-only tools
      const isWriteTool = name === "write_file" || name === "edit_file" || name === "replace_all" || name === "apply_patch" || name === "create_artifact" || name === "update_artifact";
      if (isWriteTool && args?.path) {
        toolCache.invalidateByPath(args.path);
      }
      if (name === "shell" || name === "run_command" || name === "bash") {
        toolCache.invalidateAll();
      }
      if (exitCode === 0 && !isWriteTool && name !== "shell" && name !== "run_command") {
        toolCache.set(name, args, sanitizedJson);
      }

      const durationMs = Date.now() - startTime;

      // EXECUTION_COMPLETE
      auditLogger.logEvent({
        timestamp: Date.now(),
        toolName: name,
        action: name,
        args,
        riskLevel: decision.riskLevel || "SAFE_READ",
        category: decision.category,
        capability: decision.capability,
        mode,
        decision: "EXECUTION_COMPLETE",
        allowed: true,
        cwd,
        correlationId,
        toolCallId,
        userSessionId: sessionId,
        userId,
        workspaceId,
        agentRole: context.agentRole,
        source: context.source,
        durationMs,
        requestSize,
        responseSize,
        result: exitCode === 0 ? "success" : "failure",
        metadata: auditMeta,
      });

      if (sessionId) {
        toolRateLimiter.release({ sessionId, toolName: name, now: Date.now() });
      }

      return {
        stdout: sanitizedJson,
        stderr: "",
        exitCode,
        allowed: true,
        decision: "ALLOW",
        riskLevel: decision.riskLevel,
        capability: decision.capability,
        durationMs,
      };
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      const durationMs = Date.now() - startTime;

      // EXECUTION_ERROR
      auditLogger.logEvent({
        timestamp: Date.now(),
        toolName: name,
        action: name,
        args,
        riskLevel: decision.riskLevel || "DANGEROUS",
        category: decision.category,
        capability: decision.capability,
        mode,
        decision: "EXECUTION_ERROR",
        allowed: false,
        cwd,
        reason: errMsg,
        correlationId,
        toolCallId,
        userSessionId: sessionId,
        userId,
        workspaceId,
        agentRole: context.agentRole,
        source: context.source,
        durationMs,
        metadata: auditMeta,
      });

      if (sessionId) {
        toolRateLimiter.release({ sessionId, toolName: name, now: Date.now() });
      }

      return {
        stdout: "",
        stderr: `Execution Error: ${errMsg}`,
        exitCode: 1,
        allowed: false,
        decision: "DENY",
        reason: errMsg,
        riskLevel: decision.riskLevel,
        capability: decision.capability,
        durationMs,
      };
    }
  }
}
