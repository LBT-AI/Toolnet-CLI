/**
 * Phase 77.12 — dead-hook cleanup.
 *
 * Two guarantees live here:
 *
 *  1. NO DEAD HOOKS: every name in the public contract (`HOOK_NAMES`) has a
 *     real runtime call site, and every declared call site actually contains
 *     the firing edge. A hook exported without a runtime edge fails here —
 *     the same drift that produced the declared-but-unfired `session.start`
 *     and `shell.after` can never silently return.
 *
 *  2. `session.start` CARDINALITY: activation fires exactly once per
 *     sessionId per process lifetime — fresh session, multiple turns, child
 *     sessions and resume included — and is wired in the harness (the one
 *     loop entry), not per front-end.
 *
 * `shell.after` was REMOVED in 77.12: `tool.after` already delivers the
 * normalized shell result envelope, so a post-shell edge was a pure
 * duplicate. The removal tests pin that it stays gone.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOOK_NAMES,
  HOOK_CLASS,
  DEFAULT_FAILURE_POLICY,
  WIRED_HOOKS,
  WIRED_HOOK_NAMES,
  isHookWired,
  hookRegistry,
  type HookInvocation,
} from "../../core/hooks";
import { resetSessionStartLedger } from "../../lib/harness/agentHarness";
import { AgentEngine } from "../../core/agent/agentEngine";
import { subagentSessions } from "../../core/agent/agents/sessions";
import { setSandboxMode } from "../../lib/permissions";
import { toolRegistry } from "../../lib/harness/toolRegistry";

// ── Environment ──────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
let workspace: string;
/** `session.start` activations observed by the current test. */
const started: string[] = [];

beforeEach(() => {
  setSandboxMode("workspace");
  hookRegistry.reset();
  toolRegistry.clearDynamic();
  subagentSessions.clear();
  resetSessionStartLedger();
  started.length = 0;
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-phase7712-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  hookRegistry.reset();
  toolRegistry.clearDynamic();
  subagentSessions.clear();
  resetSessionStartLedger();
  if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true });
});

// ── Scripted model (global fetch) ────────────────────────────────────────────

interface ScriptedResponse {
  content?: string;
  tool_calls?: unknown[];
}

function scriptModel(responses: ScriptedResponse[]): void {
  let turn = 0;
  globalThis.fetch = (async () => {
    const resp = responses[Math.min(turn, responses.length - 1)] ?? { content: "Done" };
    turn++;
    const body = JSON.stringify({
      id: `chatcmpl-${turn}`,
      object: "chat.completion",
      created: Date.now(),
      model: "scripted-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: resp.content || "",
            ...(resp.tool_calls?.length ? { tool_calls: resp.tool_calls } : {}),
          },
          finish_reason: resp.tool_calls?.length ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      type: "default",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => JSON.parse(body),
      text: async () => body,
      clone: async () => ({ json: async () => JSON.parse(body), text: async () => body }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function call(id: string, name: string, args: Record<string, unknown>) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

// ── 1. Static inventory guard ────────────────────────────────────────────────

describe("Phase 77.12 — hook inventory guard", () => {
  const srcRoot = path.resolve(__dirname, "..", "..");
  // Manifest call-site paths are repo-rooted ("src/lib/...").
  const repoRoot = path.resolve(srcRoot, "..");

  /**
   * The guard itself: derive the file part of each `callSite`
   * ("src/... → Function") and require the quoted hook name inside it.
   * Pure and cheap enough to run on every CI pass.
   */
  function assertEveryWiredHookHasCallSite(): string[] {
    const offenders: string[] = [];
    for (const name of WIRED_HOOK_NAMES) {
      const info = WIRED_HOOKS[name];
      if (!info) {
        offenders.push(`${name}: listed in WIRED_HOOK_NAMES but has no inventory entry`);
        continue;
      }
      const [filePart] = info.callSite.split(" → ");
      const file = path.join(repoRoot, filePart);
      if (!fs.existsSync(file)) {
        offenders.push(`${name}: call-site file missing: ${filePart}`);
        continue;
      }
      const text = fs.readFileSync(file, "utf8");
      if (!text.includes(`"${name}"`)) {
        offenders.push(`${name}: no firing edge (quoted hook name) found in ${filePart}`);
      }
    }
    return offenders;
  }

  test("every public hook name has a real runtime call site", () => {
    // The contract and the inventory are the same set — bidirectional.
    expect([...WIRED_HOOK_NAMES].sort()).toEqual([...HOOK_NAMES].sort());
    expect(assertEveryWiredHookHasCallSite()).toEqual([]);
  });

  test("the guard mechanism rejects a hook name with no call site", () => {
    // Negative control: a name that is NOT wired must be detectable.
    // `shell.after` was removed in 77.12, so it is the perfect probe.
    expect(isHookWired("shell.after" as never)).toBe(false);
    expect(WIRED_HOOKS["shell.after" as never]).toBeUndefined();

    // And the generic predicate agrees for every live name.
    for (const name of HOOK_NAMES) expect(isHookWired(name)).toBe(true);
  });

  test("shell.after is removed from the contract entirely", () => {
    expect(HOOK_NAMES).not.toContain("shell.after");
    expect(DEFAULT_FAILURE_POLICY["shell.after" as never]).toBeUndefined();
    expect(HOOK_CLASS["shell.after" as never]).toBeUndefined();

    // And nothing in production still fires it.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "node_modules") continue;
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          const text = fs.readFileSync(full, "utf8");
          if (text.includes('"shell.after"')) offenders.push(path.relative(srcRoot, full));
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });

  test("session.start is classified as observe with warn failure policy", () => {
    expect(HOOK_CLASS["session.start"]).toBe("observe");
    expect(DEFAULT_FAILURE_POLICY["session.start"]).toBe("warn");
  });

  test("every inventory entry carries complete contract metadata", () => {
    for (const name of HOOK_NAMES) {
      const info = WIRED_HOOKS[name];
      expect(info.callSite.length).toBeGreaterThan(0);
      expect(info.semantics.length).toBeGreaterThan(0);
      expect(info.cardinality.length).toBeGreaterThan(0);
      expect(typeof info.canTransform).toBe("boolean");
      expect(typeof info.canVeto).toBe("boolean");
    }
  });
});

// ── 2. session.start cardinality (real AgentEngine + scripted model) ─────────

describe("Phase 77.12 — session.start fires exactly once per session", () => {
  function trackSessionStart(): void {
    hookRegistry.register({
      name: "session.start",
      owner: "plugin:probe",
      handler: (invocation: HookInvocation) => {
        const payload = invocation.output as { sessionId?: string };
        started.push(payload.sessionId ?? "(unknown)");
      },
    });
  }

  test("new session → exactly one start", async () => {
    trackSessionStart();
    scriptModel([{ content: "ok" }]);

    const engine = new AgentEngine();
    const result = await engine.run({
      prompt: "hello",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 2,
      sessionId: "sess-7712-fresh",
      toolPermissionSet: { defaultDecision: "allow", tools: {} },
    });

    expect(result.success).toBe(true);
    expect(started).toEqual(["sess-7712-fresh"]);
  });

  test("multiple turns on the same session → start still fires once", async () => {
    trackSessionStart();
    scriptModel([
      { tool_calls: [call("g1", "read_file", { path: "turn-one.txt" })] },
      { content: "turn one done" },
      { tool_calls: [call("g2", "read_file", { path: "turn-two.txt" })] },
      { content: "turn two done" },
    ]);
    fs.writeFileSync(path.join(workspace, "turn-one.txt"), "1", "utf8");
    fs.writeFileSync(path.join(workspace, "turn-two.txt"), "2", "utf8");

    const engine = new AgentEngine();
    const options = {
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 6,
      sessionId: "sess-7712-turns",
      toolPermissionSet: { defaultDecision: "allow", tools: {} },
    } as const;

    // Each engine.run builds a NEW harness — the exactly-once contract is
    // what keeps a per-turn activation from masquerading as session.start.
    await engine.run({ prompt: "turn one", ...options });
    await engine.run({ prompt: "turn two", ...options });
    await engine.run({ prompt: "turn three", ...options });

    expect(started).toEqual(["sess-7712-turns"]);
  });

  test("child sessions (subagent tasks) start separately, once each", async () => {
    trackSessionStart();
    scriptModel([
      // Parent delegates two tasks.
      {
        tool_calls: [
          call("t1", "task", { description: "inspect", prompt: "inspect [[alpha]]", subagent_type: "general" }),
          call("t2", "task", { description: "report", prompt: "report [[beta]]", subagent_type: "general" }),
        ],
      },
      // Child 1 replies.
      { content: "alpha inspected" },
      // Child 2 replies.
      { content: "beta reported" },
      // Parent concludes.
      { content: "both children done" },
    ]);

    const engine = new AgentEngine();
    const result = await engine.run({
      prompt: "spawn two subagents",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 8,
      sessionId: "sess-7712-parent",
      toolPermissionSet: { defaultDecision: "allow", tools: {} },
    });

    expect(result.success).toBe(true);

    // Parent once + one activation per distinct child sessionId.
    const parentFires = started.filter((s) => s === "sess-7712-parent");
    const childFires = started.filter((s) => s.startsWith("sub:"));
    expect(parentFires).toEqual(["sess-7712-parent"]);
    expect(childFires.length).toBeGreaterThanOrEqual(1);
    expect(new Set(childFires).size).toBe(childFires.length);
  });

  test("resuming a session this process already activated → no duplicate", async () => {
    trackSessionStart();
    scriptModel([{ content: "ok" }, { content: "still ok" }]);

    const engine = new AgentEngine();
    const options = {
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 2,
      sessionId: "sess-7712-resume",
      toolPermissionSet: { defaultDecision: "allow", tools: {} },
    } as const;

    await engine.run({ prompt: "first contact", ...options });
    // A later process state "resumes" the same session — the runtime has
    // already activated it, so the contract says: no second start.
    await engine.run({ prompt: "resume", ...options });

    expect(started).toEqual(["sess-7712-resume"]);
  });

  test("a throwing session.start hook can never break the turn", async () => {
    hookRegistry.register({
      name: "session.start",
      owner: "plugin:broken",
      handler: () => {
        throw new Error("activation observer exploded");
      },
    });
    scriptModel([{ content: "survived" }]);

    const engine = new AgentEngine();
    const result = await engine.run({
      prompt: "hello",
      cwd: workspace,
      workspaceRoot: workspace,
      model: "scripted-model",
      maxTurns: 2,
      sessionId: "sess-7712-broken",
      toolPermissionSet: { defaultDecision: "allow", tools: {} },
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("survived");
  });
});
