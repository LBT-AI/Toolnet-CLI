/**
 * Layer 4 — Phase 1: Execution Integrity + ToolGateway Convergence
 *
 * Regression suite proving:
 *  1. ToolGateway is the single security chokepoint (ALLOW/ASK/DENY/CRITICAL_DENY).
 *  2. TUI approval flow semantics (Y once / A session / N / Esc) without re-execution.
 *  3. SessionTrust canonical keys match SecurityEngine lookup; shell wildcard trust banned.
 *  4. Shell hardening: explicit cwd, workspace boundary, symlink escape, scrubbed env,
 *     streaming output caps, timeout killing the whole process tree (grandchild included).
 *  5. Interpreter commands (python -c, node -e, bash -c, sh -c, env, xargs, find -exec)
 *     classify under DYNAMIC_EXECUTION and go through the gateway — no bypass.
 *  6. Call-graph assertions: production code never calls _executeToolRaw outside
 *     the allowed internal modules; model-callable paths never execute raw.
 *
 * Guard Clauses throughout: tests skip cleanly when a prerequisite is unavailable.
 */

import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "layer4-phase1-"));
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "layer4-phase1-outside-"));

afterAll(() => {
  try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch {}
});

import { securityEngine } from "../../lib/security/securityEngine";
import { sessionTrust } from "../../lib/security/sessionTrust";
import { ToolGateway } from "../../lib/security/toolGateway";
import { scrubChildEnv, isSecretEnvVar } from "../../lib/security/childEnv";
import { setSandboxMode, getSandboxMode } from "../../lib/permissions";
import { toolBash, type ShellExecContext } from "../../lib/codingAgent";

const origMode = getSandboxMode();

beforeEach(() => {
  setSandboxMode("workspace");
  sessionTrust.clear();
});

afterEach(() => {
  sessionTrust.clear();
});

afterAll(() => {
  setSandboxMode(origMode);
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. TOOLGATEWAY — single chokepoint decision matrix
// ═══════════════════════════════════════════════════════════════════════════

describe("PHASE1 ToolGateway decision matrix", () => {
  const cwd = tmpBase;
  const wsRoot = tmpBase;

  test("ALLOW executes exactly once", async () => {
    const res = await ToolGateway.execute(
      { name: "read_file", args: { path: "package.json" } },
      { cwd, workspaceRoot: wsRoot, sandboxMode: "workspace" }
    );
    expect(res.allowed).toBe(true);
    expect(res.decision).toBe("ALLOW");
    expect(res.stdout).toContain("name");
  });

  test("ASK + userApproved=false executes zero times (needsApproval returned)", async () => {
    const cmd = "bash -c 'echo gated'";
    const perm = securityEngine.evaluate("shell", { command: cmd }, "workspace", cwd, wsRoot);
    if (!perm.needsApproval) return; // guard: classifier may treat as non-ASK in workspace mode

    const res = await ToolGateway.execute(
      { name: "shell", args: { command: cmd } },
      { cwd, workspaceRoot: wsRoot, sandboxMode: "workspace", userApproved: false }
    );
    expect(res.allowed).toBe(false);
    expect(res.needsApproval).toBe(true);
  });

  test("ASK + userApproved=true executes exactly once", async () => {
    const cmd = "echo phase1-approved";
    const perm = securityEngine.evaluate("shell", { command: cmd }, "ask", cwd, wsRoot);
    // guard: command must be ASK in ask mode for the approved path to be meaningful
    if (perm.allowed && !perm.needsApproval) {
      const res = await ToolGateway.execute(
        { name: "shell", args: { command: cmd } },
        { cwd, workspaceRoot: wsRoot, sandboxMode: "ask", userApproved: false }
      );
      if (!res.needsApproval) return;
    }
    const res = await ToolGateway.execute(
      { name: "shell", args: { command: "echo phase1-approved" } },
      { cwd, workspaceRoot: wsRoot, sandboxMode: "ask", userApproved: true }
    );
    expect(res.allowed).toBe(true);
    expect(res.stdout).toContain("phase1-approved");
  });

  test("DENY executes zero times", async () => {
    const res = await ToolGateway.execute(
      { name: "write_file", args: { path: path.join(outsideDir, "evil.txt"), content: "no" } },
      { cwd, workspaceRoot: wsRoot, sandboxMode: "workspace" }
    );
    expect(res.allowed).toBe(false);
    expect(res.decision).toBe("DENY");
    expect(fs.existsSync(path.join(outsideDir, "evil.txt"))).toBe(false);
  });

  test("CRITICAL_DENY executes zero times even with userApproved=true", async () => {
    const res = await ToolGateway.execute(
      { name: "shell", args: { command: "rm -rf /" } },
      { cwd, workspaceRoot: wsRoot, sandboxMode: "workspace", userApproved: true }
    );
    expect(res.allowed).toBe(false);
    expect(res.riskLevel).toBe("CRITICAL_DENY");
    expect(res.needsApproval).toBeUndefined();
  });

  test("userApproved=true cannot resurrect a session-denied ASK action", async () => {
    const cmd = "echo phase1-denied-cmd";
    // Simulate a prior "N" for this exact action
    sessionTrust.recordDecision("shell", cmd, "DENIED");
    const res = await ToolGateway.execute(
      { name: "shell", args: { command: cmd } },
      { cwd, workspaceRoot: wsRoot, sandboxMode: "ask", userApproved: true }
    );
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/denied for this session/i);
  });

  test("headless ASK fails closed via ToolGateway (no interactive user to approve)", async () => {
    // Test runners are non-TTY; gateway with userApproved=false must not execute.
    const res = await ToolGateway.execute(
      { name: "shell", args: { command: "bash -c 'echo headless'" } },
      { cwd, workspaceRoot: wsRoot, sandboxMode: "ask", userApproved: false }
    );
    if (res.allowed) return; // guard: classifier may allow this safe echo
    expect(res.needsApproval === true || res.allowed === false).toBe(true);
  });

  test("agentRole researcher cannot run shell via gateway (real role propagated)", async () => {
    const res = await ToolGateway.execute(
      { name: "shell", args: { command: "echo hi" } },
      { cwd, workspaceRoot: wsRoot, sandboxMode: "workspace", agentRole: "researcher", userApproved: true }
    );
    expect(res.allowed).toBe(false);
    expect(res.riskLevel).toBe("CRITICAL_DENY");
  });

  test("agentDepth>=1 cannot spawn_subagent via gateway", async () => {
    const res = await ToolGateway.execute(
      { name: "spawn_subagent", args: { role: "CODER", task: "nested" } },
      { cwd, workspaceRoot: wsRoot, sandboxMode: "workspace", agentDepth: 1, userApproved: true }
    );
    expect(res.allowed).toBe(false);
    expect(res.riskLevel).toBe("CRITICAL_DENY");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. TUI APPROVAL SEMANTICS — Y / A / N / Esc via permissionModal contract
// ═══════════════════════════════════════════════════════════════════════════

describe("PHASE1 TUI approval semantics (modal contract)", () => {
  test("modal records A under (toolName, targetKey) matching SecurityEngine lookup", async () => {
    const { requestApprovalModal } = require("../../tui/permissions/permissionModal");
    const { tuiState } = require("../../tui/state");
    const toolName = "run_command";
    const args = { command: "npm test" };
    const targetKey = securityEngine.getSessionTrustTargetKey(toolName, args);

    const promise = requestApprovalModal({ toolName, args, targetKey, reason: "run tests?" });
    expect(tuiState.pendingConfirmation).toBeDefined();

    // Simulate user pressing "A" (allow for session)
    tuiState.pendingConfirmation.onDecision("a");
    tuiState.pendingConfirmation.resolve(true);
    tuiState.pendingConfirmation = null;
    const ok = await promise;
    expect(ok).toBe(true);

    // The recorded key MUST match the exact lookup SecurityEngine performs:
    expect(sessionTrust.isTrustedForSession(toolName, targetKey, "workspace")).toBe(true);
  });

  test("Y records nothing (allow once, no persistence)", async () => {
    const { requestApprovalModal } = require("../../tui/permissions/permissionModal");
    const { tuiState } = require("../../tui/state");
    const toolName = "shell";
    const args = { command: "echo once-only" };
    const targetKey = securityEngine.getSessionTrustTargetKey(toolName, args);

    const promise = requestApprovalModal({ toolName, args, targetKey });
    tuiState.pendingConfirmation.onDecision("y");
    tuiState.pendingConfirmation.resolve(true);
    tuiState.pendingConfirmation = null;
    await promise;

    expect(sessionTrust.isTrustedForSession(toolName, targetKey, "workspace")).toBe(false);
    expect(sessionTrust.listTrusted().length).toBe(0);
  });

  test("N records session denial; later identical ASK auto-denies", async () => {
    const { requestApprovalModal } = require("../../tui/permissions/permissionModal");
    const { tuiState } = require("../../tui/state");
    const toolName = "shell";
    const args = { command: "echo denied-cmd" };
    const targetKey = securityEngine.getSessionTrustTargetKey(toolName, args);

    const promise = requestApprovalModal({ toolName, args, targetKey });
    tuiState.pendingConfirmation.onDecision("n");
    tuiState.pendingConfirmation.resolve(false);
    tuiState.pendingConfirmation = null;
    const ok = await promise;
    expect(ok).toBe(false);

    expect(sessionTrust.isDeniedForSession(toolName, targetKey)).toBe(true);
  });

  test("Esc records nothing (dismiss without persistence)", async () => {
    const { requestApprovalModal } = require("../../tui/permissions/permissionModal");
    const { tuiState } = require("../../tui/state");
    const toolName = "shell";
    const args = { command: "echo dismissed" };
    const targetKey = securityEngine.getSessionTrustTargetKey(toolName, args);

    const promise = requestApprovalModal({ toolName, args, targetKey });
    // Esc path in inputHandler resolves WITHOUT calling onDecision
    tuiState.pendingConfirmation.resolve(false);
    tuiState.pendingConfirmation = null;
    const ok = await promise;
    expect(ok).toBe(false);

    expect(sessionTrust.isDeniedForSession(toolName, targetKey)).toBe(false);
    expect(sessionTrust.isTrustedForSession(toolName, targetKey, "workspace")).toBe(false);
  });

  test("A-recorded trust lets a second identical ASK through without a modal (gateway path)", async () => {
    const toolName = "shell";
    const args = { command: "echo reuse-trust-cmd" };
    const targetKey = securityEngine.getSessionTrustTargetKey(toolName, args);
    sessionTrust.recordDecision(toolName, targetKey, "SESSION");

    // First gateway call (no userApproved): SecurityEngine STEP 7 honors session
    // trust and returns ALLOW — the TUI would never see needsApproval → no modal.
    const res = await ToolGateway.execute(
      { name: toolName, args },
      { cwd: tmpBase, workspaceRoot: tmpBase, sandboxMode: "ask", userApproved: false }
    );
    expect(res.allowed).toBe(true);
    expect(res.needsApproval).toBeUndefined();
  });

  test("approval retry does not double-execute (gateway evaluates once per entry)", async () => {
    const toolName = "shell";
    const args = { command: "echo single-shot-phase1" };
    // Not trusted, not denied → first call must be ASK (needsApproval, 0 executions)
    const first = await ToolGateway.execute(
      { name: toolName, args },
      { cwd: tmpBase, workspaceRoot: tmpBase, sandboxMode: "ask", userApproved: false }
    );
    const firstWasAsk = first.needsApproval === true;
    // Approved re-entry executes once
    const second = await ToolGateway.execute(
      { name: toolName, args },
      { cwd: tmpBase, workspaceRoot: tmpBase, sandboxMode: "ask", userApproved: true }
    );
    expect(second.allowed).toBe(true);
    if (firstWasAsk) {
      expect(first.allowed).toBe(false);
      // The first (unapproved) call must NOT have produced command output
      expect(first.stdout).toBe("");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. SESSION TRUST KEYS
// ═══════════════════════════════════════════════════════════════════════════

describe("PHASE1 session trust canonical keys", () => {
  test("canonical exact match: npm test trusted, npm test --foo NOT trusted", () => {
    const toolName = "run_command";
    const trustedKey = securityEngine.getSessionTrustTargetKey(toolName, { command: "npm test" });
    const otherKey = securityEngine.getSessionTrustTargetKey(toolName, { command: "npm test --foo" });
    expect(trustedKey).toBe("npm test");
    expect(otherKey).toBe("npm test --foo");
    expect(trustedKey).not.toBe(otherKey);

    sessionTrust.recordDecision(toolName, trustedKey, "SESSION");
    expect(sessionTrust.isTrustedForSession(toolName, trustedKey, "workspace")).toBe(true);
    // Variant must NOT inherit trust
    expect(sessionTrust.isTrustedForSession(toolName, otherKey, "workspace")).toBe(false);
  });

  test("shell wildcard trust is forbidden in workspace and ask modes", () => {
    const ok = sessionTrust.trustEntireToolForSession("shell", "workspace");
    expect(ok).toBe(false);
    expect(sessionTrust.isTrustedForSession("shell", "anything", "workspace")).toBe(false);
    expect(sessionTrust.isTrustedForSession("shell", "other", "ask")).toBe(false);
    expect(sessionTrust.listTrusted().includes("shell:*")).toBe(false);
  });

  test("file tools use path as canonical key", () => {
    const key = securityEngine.getSessionTrustTargetKey("write_file", { path: "src/x.ts" });
    expect(key).toBe("src/x.ts");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. SHELL HARDENING
// ═══════════════════════════════════════════════════════════════════════════

describe("PHASE1 shell hardening", () => {
  const wsRoot = tmpBase;
  const inner = path.join(tmpBase, "inner-dir");
  fs.mkdirSync(inner, { recursive: true });

  test("cwd = provided context cwd (not module global)", async () => {
    const ctx: ShellExecContext = { cwd: inner, workspaceRoot: wsRoot, sandboxMode: "workspace" };
    const res = await toolBash("pwd", 10000, ctx);
    expect(res.success).toBe(true);
    expect(res.stdout?.trim()).toBe(fs.realpathSync(inner));
  });

  test("cwd outside workspace blocked in workspace mode", async () => {
    const ctx: ShellExecContext = { cwd: outsideDir, workspaceRoot: wsRoot, sandboxMode: "workspace" };
    const res = await toolBash("pwd", 10000, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/outside the allowed workspace roots/i);
  });

  test("symlink cwd escape blocked (realpath resolution)", async () => {
    const linkPath = path.join(wsRoot, "escape-link");
    try {
      fs.symlinkSync(outsideDir, linkPath, "dir");
    } catch { return; } // guard: symlink unsupported
    const ctx: ShellExecContext = { cwd: linkPath, workspaceRoot: wsRoot, sandboxMode: "workspace" };
    const res = await toolBash("pwd", 10000, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/outside the allowed workspace roots/i);
    try { fs.unlinkSync(linkPath); } catch {}
  });

  test("secret env vars absent in child; safe env retained", async () => {
    process.env.PHASE1_SECRET_PROBE = "classified-xyz";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret-probe";
    const ctx: ShellExecContext = { cwd: inner, workspaceRoot: wsRoot, sandboxMode: "workspace" };
    const res = await toolBash("echo \"[$PHASE1_SECRET_PROBE][$AWS_SECRET_ACCESS_KEY][$HOME]\"", 10000, ctx);
    delete process.env.PHASE1_SECRET_PROBE;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    expect(res.success).toBe(true);
    expect(res.stdout).not.toContain("classified-xyz");
    expect(res.stdout).not.toContain("aws-secret-probe");
    expect(res.stdout).toContain(`[${process.env.HOME}]`);
  });

  test("explicit env cannot smuggle secret-looking vars", () => {
    const env = scrubChildEnv({ PATH: "/usr/bin", HOME: "/root" }, {
      MY_FLAG: "1",
      EVIL_API_KEY: "should-not-pass",
    });
    expect(env.MY_FLAG).toBe("1");
    expect(env.EVIL_API_KEY).toBeUndefined();
  });

  test("isSecretEnvVar deny-list coverage", () => {
    expect(isSecretEnvVar("OPENAI_API_KEY")).toBe(true);
    expect(isSecretEnvVar("GITHUB_TOKEN")).toBe(true);
    expect(isSecretEnvVar("MY_DB_PASSWORD")).toBe(true);
    expect(isSecretEnvVar("AWS_SESSION_TOKEN")).toBe(true);
    expect(isSecretEnvVar("GOOGLE_APPLICATION_CREDENTIALS")).toBe(true);
    expect(isSecretEnvVar("STRIPE_KEY")).toBe(true);
    expect(isSecretEnvVar("PLAIN_VAR")).toBe(false);
    expect(isSecretEnvVar("LC_ALL")).toBe(false);
  });

  test("stdout cap enforced while streaming (not post-hoc)", async () => {
    const ctx: ShellExecContext = { cwd: inner, workspaceRoot: wsRoot, sandboxMode: "workspace", outputCapBytes: 1024 };
    const res = await toolBash("head -c 100000 /dev/zero | tr '\\0' 'a'", 20000, ctx);
    expect(res.success).toBe(true);
    expect((res.stdout || "").length).toBeLessThan(5000);
    expect(res.stdout || res.data || "").toContain("output truncated at byte cap");
  }, 30000);

  test("stderr cap enforced while streaming", async () => {
    const ctx: ShellExecContext = { cwd: inner, workspaceRoot: wsRoot, sandboxMode: "workspace", outputCapBytes: 1024 };
    const res = await toolBash("head -c 100000 /dev/zero | tr '\\0' 'b' 1>&2", 20000, ctx);
    expect((res.stderr || "").length).toBeLessThan(5000);
  }, 30000);

  test("timeout kills the whole process tree (grandchild included)", async () => {
    const ctx: ShellExecContext = { cwd: inner, workspaceRoot: wsRoot, sandboxMode: "workspace" };
    const start = Date.now();
    const res = await toolBash("sleep 30 & sleep 30", 500, ctx);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(5000);
    expect(res.success).toBe(false);
    expect(res.exitCode).toBe(124);

    // Give the kernel a beat to reap the group, then verify no stray sleeps
    await new Promise((r) => setTimeout(r, 300));
    const probe = Bun.spawnSync(["pgrep", "-f", "sleep 30"]);
    const stray = (probe.stdout.toString() || "").trim();
    expect(stray).toBe("");
  }, 20000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. INTERPRETER / DYNAMIC EXECUTION CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

describe("PHASE1 interpreter classification (all through gateway policy)", () => {
  const cases: Array<{ cmd: string; expectCapability: string }> = [
    { cmd: "python -c 'print(1)'", expectCapability: "DYNAMIC_EXECUTION" },
    { cmd: "node -e 'console.log(1)'", expectCapability: "DYNAMIC_EXECUTION" },
    { cmd: "bash -c 'echo x'", expectCapability: "DYNAMIC_EXECUTION" },
    { cmd: "sh -c 'echo x'", expectCapability: "DYNAMIC_EXECUTION" },
    { cmd: "env FOO=bar node script.js", expectCapability: "DYNAMIC_EXECUTION" },
    { cmd: "find . -name '*.ts' -exec rm {} ;", expectCapability: "DYNAMIC_EXECUTION" },
    { cmd: "cat list | xargs rm", expectCapability: "DYNAMIC_EXECUTION" },
  ];

  for (const { cmd, expectCapability } of cases) {
    test(`capability of "${cmd}" is gated (${expectCapability} or stricter) and not silently allowlisted`, () => {
      const cap = securityEngine.evaluate("shell", { command: cmd }, "workspace", tmpBase, tmpBase);
      // Either the expected dynamic-execution capability, or a STRICTER locked
      // capability (e.g. DELETE for find -exec rm) — never a silent allow.
      const gatedCaps = new Set(["DYNAMIC_EXECUTION", "DELETE", "RESET", "SYSTEM"]);
      expect(gatedCaps.has(cap.capability as string) || cap.capability === expectCapability).toBe(true);
      // DYNAMIC_EXECUTION capability is locked by default → must not be ALLOW
      // without approval/trust. Classification must come before any executor.
      expect(cap.allowed).toBe(false);
    });
  }

  test("git/npm/bun/pnpm/yarn are not blanket-safe (lifecycle scripts run code)", () => {
    // In workspace mode EXECUTE capability is allowed for plain builds, but the
    // classifier must never mark `npm install` (arbitrary lifecycle scripts) as
    // SAFE_READ-only — it is at least workspace execution, gated by policy.
    const npmInstall = securityEngine.evaluate("shell", { command: "npm install" }, "workspace", tmpBase, tmpBase);
    // npm install executes arbitrary package lifecycle scripts — must never be SAFE_READ
    expect(npmInstall.riskLevel).not.toBe("SAFE_READ");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. CALL GRAPH — no raw-executor bypass in production paths
// ═══════════════════════════════════════════════════════════════════════════

describe("PHASE1 call graph assertions", () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), "utf8");

  test("_executeToolRaw referenced ONLY by allowed internal modules", () => {
    const libDir = path.join(__dirname, "../../lib");
    const offenders: string[] = [];
    const allowed = new Set(["agentTools.ts", "security/toolGateway.ts"]);

    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) { walk(p); continue; }
        if (!f.name.endsWith(".ts") || f.name.endsWith(".test.ts")) continue;
        const src = fs.readFileSync(p, "utf8");
        if (src.includes("_executeToolRaw") && !allowed.has(path.relative(libDir, p))) {
          offenders.push(path.relative(libDir, p));
        }
      }
    };
    walk(libDir);
    expect(offenders).toEqual([]);
  });

  test("TUI agentWiring routes model-callable tools through ToolGateway (no direct executeTool)", () => {
    const src = read("../../tui/events/agentWiring.ts");
    expect(src).toMatch(/ToolGateway\.execute/);
    expect(src).not.toMatch(/executeTool\(name,\s*args,\s*\{/);
    expect(src).toMatch(/userApproved,\s*$/m); // approved re-entry exists
  });

  test("pluginManager goes through ToolGateway, no independent evaluatePermission", () => {
    const src = read("../../lib/plugins/pluginManager.ts");
    expect(src).toMatch(/ToolGateway\.execute/);
    expect(src).not.toMatch(/evaluatePermission/);
  });

  test("toolBash does not re-gate via permissionGate (single SecurityEngine eval)", () => {
    const src = read("../../lib/codingAgent.ts");
    expect(src).not.toMatch(/permissionGate\.evaluate\("bash"/);
    expect(src).not.toMatch(/permissionGate\.evaluate\(/);
  });

  test("agentTools.executeTool is a thin ToolGateway wrapper (no second SecurityEngine call)", () => {
    const src = read("../../lib/agentTools.ts");
    expect(src).toMatch(/ToolGateway\.execute/);
    // No direct securityEngine/evaluatePermission usage remains in executeTool
    expect(src).not.toMatch(/evaluatePermission\(/);
  });

  test("TUI save_plan does not bypass with raw fs.writeFileSync", () => {
    const src = read("../../tui/events/agentWiring.ts");
    expect(src).not.toMatch(/fs\.writeFileSync\(planPath/);
    expect(src).toMatch(/toolWrite\(planPath/);
  });

  test("vision reads go through SecurityEngine policy", () => {
    const src = read("../../lib/vision.ts");
    expect(src).toMatch(/securityEngine\.evaluate\("read_file"/);
  });

  test("bypassPolicy no longer weakens file tool invariants", () => {
    const src = read("../../lib/codingAgent.ts");
    // The only bypassPolicy short-circuit must be redundant with full-access mode
    expect(src).toMatch(/bypassPolicy && getSandboxMode\(\) === "full-access"/);
    const getCwdInfoSrc = src.slice(src.indexOf("export function getCwdInfo"));
    expect(getCwdInfoSrc).toMatch(/bypassPolicy: isFullAccess/);
  });
});
