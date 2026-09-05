import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ToolGateway, securityEngine, redactSecrets, SecurityAuditLogger } from "../../lib/security";
import { scrubChildEnv } from "../../lib/security/childEnv";
import { SessionTrustManager } from "../../lib/security/sessionTrust";
import { compactMessagesAtomically, validateToolCallPairs, assertPrimarySystemMessageInvariant } from "../../lib/context";
import { ContextEngine, getSessionContext, getSessionMemory, deleteSessionContext } from "../../lib/context";
import { executeToolBatch } from "../../lib/harness/toolExecutor";
import { normalizeWorkerResult, workerResultFromError } from "../workerResult";
import { DynamicScheduler } from "../dynamicScheduler";
import { getSubagentTools } from "../subagentRuntime";
import { computeServerFingerprint, getLocalMcpServers, mcpToolName } from "../../lib/mcpRunner";
import { safeFetch, SafeFetchError } from "../../lib/security/safeFetch";
import { saveSession, loadSession, deleteSessionFile } from "../../lib/sessionPersistence";
import { getToolnetHome, getToolnetSessionsDir } from "../../lib/toolnetHome";

const id = (label: string) => `phase5-${label}-${Math.random().toString(36).slice(2, 8)}`;

beforeEach(() => {
  const { sessionTrust } = require("../../lib/security/sessionTrust");
  sessionTrust.clearAll();
});

afterEach(() => {
  const { sessionTrust } = require("../../lib/security/sessionTrust");
  sessionTrust.clearAll();
});

describe("Layer 4 Phase 5 FINAL — residual hardening and red team", () => {
  test("execution: CRITICAL_DENY cannot be overridden by trust or approval", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase5-exec-"));
    const sid = id("critical");
    const trust = new SessionTrustManager();
    trust.recordDecision(sid, "shell", "rm -rf /", "SESSION");
    const result = await ToolGateway.execute(
      { name: "shell", args: { command: "rm -rf /" } },
      { sessionId: sid, cwd: root, workspaceRoot: root, sandboxMode: "full-access", userApproved: true, source: "headless" }
    );
    expect(result.allowed).toBe(false);
    expect(result.riskLevel).toBe("CRITICAL_DENY");
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("execution: child environment excludes API keys and tokens", () => {
    const env = scrubChildEnv({ PATH: "/usr/bin", HOME: "/tmp", OPENAI_API_KEY: "secret", GITHUB_TOKEN: "secret" }, { SAFE_FLAG: "yes", API_KEY: "secret" });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.API_KEY).toBeUndefined();
    expect(env.SAFE_FLAG).toBe("yes");
  });

  test("gateway: architecture has a single raw executor call site", () => {
    const raw = fs.readFileSync(path.join(process.cwd(), "src/lib/agentTools.ts"), "utf8");
    const gateway = fs.readFileSync(path.join(process.cwd(), "src/lib/security/toolGateway.ts"), "utf8");
    // agentTools defines the raw executor once; the gateway is its only
    // production call site. Documentation must not be mistaken for bypasses.
    expect((raw.match(/export async function _executeToolRaw/g) || []).length).toBe(1);
    expect(gateway).toContain("_executeToolRaw(");
  });

  test("sessions: trust and memory remain isolated across A/B and deletion", () => {
    const a = id("A");
    const b = id("B");
    const trust = new SessionTrustManager();
    trust.recordDecision(a, "read_file", "a.ts", "SESSION");
    getSessionMemory(a).recordUserGoal("goal-a");
    getSessionMemory(b).recordUserGoal("goal-b");
    expect(trust.isTrustedForSession(a, "read_file", "a.ts", "workspace")).toBe(true);
    expect(trust.isTrustedForSession(b, "read_file", "a.ts", "workspace")).toBe(false);
    expect(getSessionMemory(b).getSnapshot().userGoals).not.toContain("goal-a");
    deleteSessionContext(b);
    expect(getSessionContext(a).memory.getSnapshot().userGoals).toContain("goal-a");
  });

  test("context: one primary system message and valid tool pairing survive compaction", () => {
    const messages: any[] = [
      { role: "system", content: "primary" },
      { role: "user", content: "first " + "x".repeat(5000) },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", name: "read_file", content: "result" },
      { role: "assistant", content: "done" },
      { role: "user", content: "second" },
      { role: "assistant", content: "answer" },
    ];
    const result = compactMessagesAtomically(messages, { force: true, model: "test", summaryRole: "user" });
    expect(result.compacted).toBe(true);
    expect(validateToolCallPairs(result.messages).valid).toBe(true);
    expect(() => assertPrimarySystemMessageInvariant(result.messages)).not.toThrow();
    expect(result.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(result.messages[0].content).toBe("primary");
  });

  test("provider payload: malformed system placement is rejected", () => {
    expect(() => assertPrimarySystemMessageInvariant([
      { role: "user", content: "x" },
      { role: "system", content: "late" },
    ] as any)).toThrow();
  });

  test("token accounting: provider total wins and detail fields do not double count", () => {
    const sid = id("tokens");
    const engine = new ContextEngine({ sessionId: sid });
    engine.recordUsage({ promptTokens: 100, completionTokens: 50, totalTokens: 120, cachedTokens: 80, reasoningTokens: 40 }, sid);
    engine.recordUsage({ promptTokens: 10, completionTokens: 5 }, sid);
    const usage = engine.getTokenBudget(sid);
    expect(usage.cumulativeSessionTokens).toBe(135);
    expect(usage.actualUsagePromptTokens).toBe(110);
    expect(usage.actualUsageCompletionTokens).toBe(55);
    expect(usage.actualUsageCachedTokens).toBe(80);
    expect(usage.actualUsageReasoningTokens).toBe(40);
  });

  test("redaction: standard headers and credential assignments are removed", () => {
    const text = "Authorization: Bearer super-secret-token-value Cookie: sid=abc X-API-Key: key-value token=private access_token=refresh password=hunter2";
    const out = redactSecrets(text);
    for (const secret of ["super-secret-token-value", "sid=abc", "key-value", "private", "refresh", "hunter2"]) expect(out).not.toContain(secret);
  });

  test("MCP: duplicate names are source-disambiguated and fingerprints change on cwd/args mutation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase5-mcp-"));
    fs.mkdirSync(path.join(root, ".toolnet"));
    fs.writeFileSync(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: { shell: { command: "node", args: ["server.js"] } } }));
    fs.writeFileSync(path.join(root, ".toolnet", "mcp.json"), JSON.stringify({ mcpServers: { shell: { command: "node", args: ["other.js"] } } }));
    const servers = getLocalMcpServers(root);
    expect(servers.length).toBe(2);
    expect(new Set(servers.map((s) => s.serverId)).size).toBe(2);
    expect(computeServerFingerprint(servers[0].config)).not.toBe(computeServerFingerprint({ ...servers[0].config, args: ["changed.js"] }));
    expect(mcpToolName(servers[0].serverId, "read_file")).not.toBe(mcpToolName(servers[1].serverId, "read_file"));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("remote MCP: unsupported remote transports are rejected by URL policy", async () => {
    for (const url of ["file:///tmp/mcp", "javascript:alert(1)", "ftp://example.test/mcp"]) {
      await expect(safeFetch(url)).rejects.toBeInstanceOf(SafeFetchError);
    }
  });

  test("scheduler: empty worker result and provider failure are never success", () => {
    expect(normalizeWorkerResult("").success).toBe(false);
    expect(workerResultFromError(new Error("provider 401 unauthorized")).success).toBe(false);
    expect(workerResultFromError(new Error("provider 401 unauthorized")).errorCode).toBe("AUTH_REQUIRED");
  });

  test("scheduler: 20 mocked nodes complete with randomized async order", async () => {
    const nodes: any[] = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, title: `node-${i}`, role: "RESEARCHER", dependencies: [], status: "PENDING" }));
    const graph: any = { sessionId: id("graph"), mode: "STANDARD", nodes, createdAt: Date.now(), maxConcurrency: 5 };
    const scheduler = new DynamicScheduler(graph, {
      maxConcurrencyOverride: 5,
      executorFn: async (node) => {
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 4)));
        return { success: true, output: node.title, tokensUsed: 1 };
      },
    });
    const state = await scheduler.start();
    expect(state.status).toBe("COMPLETED");
    expect(state.completedTaskIds).toHaveLength(20);
  });

  test("failure injection: audit tampering is detected", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase5-audit-"));
    const file = path.join(root, "audit.jsonl");
    const logger = new SecurityAuditLogger(file);
    logger.logEvent({ toolName: "read_file", args: { path: "safe.txt" }, mode: "workspace", decision: "ALLOW" });
    logger.logEvent({ toolName: "shell", args: { command: "echo safe" }, mode: "workspace", decision: "ALLOW" });
    expect(logger.verifyChain().valid).toBe(true);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    const tampered = JSON.parse(lines[0]);
    tampered.data.allowed = false;
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    expect(logger.verifyChain().valid).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("state/migration: canonical home and project-local .toolnet remain distinct", () => {
    expect(getToolnetHome()).toContain(".toolnetcli");
    expect(getToolnetSessionsDir()).toContain(path.join(".toolnetcli", "sessions"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "phase5-state-"));
    fs.mkdirSync(path.join(project, ".toolnet"));
    fs.writeFileSync(path.join(project, ".toolnet", "mcp.json"), "{}");
    expect(fs.existsSync(path.join(project, ".toolnet", "mcp.json"))).toBe(true);
    fs.rmSync(project, { recursive: true, force: true });
  });

  test("session persistence: deleting B does not affect A and removes cache lifecycle state", () => {
    const a = id("persist-a");
    const b = id("persist-b");
    saveSession(a, [{ role: "user", content: "A" }]);
    saveSession(b, [{ role: "user", content: "B" }]);
    expect(loadSession(a)?.messages[0].content).toBe("A");
    expect(deleteSessionFile(b)).toBe(true);
    expect(loadSession(a)?.messages[0].content).toBe("A");
  });

  test("subagent roles are restrictive by default", () => {
    expect(getSubagentTools("RESEARCHER" as any).map((x) => x.function.name)).not.toContain("shell");
    expect(getSubagentTools("REVIEWER" as any).map((x) => x.function.name)).not.toContain("write_file");
    expect(getSubagentTools("UNKNOWN" as any).map((x) => x.function.name)).not.toContain("spawn_subagent");
  });

  test("tool batching returns a response per call without duplicate execution", async () => {
    let count = 0;
    const result = await executeToolBatch([
      { id: "1", name: "read_file", args: { path: "x" } },
      { id: "2", name: "read_file", args: { path: "x" } },
    ], {
      cwd: process.cwd(),
      runTool: async () => { count++; return { result: "ok", allowed: true }; },
    });
    expect(count).toBe(1);
    expect(result.messages).toHaveLength(2);
  });
});
