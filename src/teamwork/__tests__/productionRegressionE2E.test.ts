/**
 * PHASE 7 — PRODUCTION REGRESSION + E2E GATE.
 *
 * This suite adds NO features. It drives the REAL production modules
 * (AgentHarness / AgentEngine / SessionRunDriver / SessionStore / SecurityEngine
 * / ToolGateway / the TUI transcript reconciler) against a SCRIPTED provider and
 * fixture files, so the whole Phase 1–6 fix set is exercised together:
 *
 *   01 long realistic task (>10 turns with progress)  14 cancellation race
 *   02 browser unavailable                            15 assistant text→tool→text
 *   03 browser available fixture                      16 silent long-running activity
 *   04 web_fetch timeout→retry→success                17 queued steer at completion
 *   05 web_fetch permanent error                      18 provider error
 *   06 read directory recovery                        19 crash/restart/resume
 *   07 permission approve                             20 no-progress loop
 *   08 permission deny                                21 repeated equivalent failures
 *   09 security deny                                  22 structured errors model-facing
 *   10 php -r safe inspection                         23 Plan mode write denial
 *   11 2>/dev/null                                    24 foreground/subagent separation
 *   12 out-of-order tools                             25 compaction/context continuation
 *   13 same-name tools
 *
 * Rules honoured here: no real network/provider (fixtures + fetch stubs only),
 * no sleeps (deferred promises/barriers), temp dirs only, deterministic.
 * A failure in this file is ALWAYS a production regression — never the model.
 */

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentHarness } from "../../lib/harness";
import { setSandboxMode } from "../../lib/permissions";
import { setModelCapabilities } from "../../lib/reasoning";
import { securityEngine } from "../../lib/security/securityEngine";
import {
  classifyShellCommand,
  filesystemRedirectTargets,
  assessRedirection,
} from "../../lib/security/commandClassifier";
import { parseShellCommand } from "../../lib/security/shellParser";
import { agentRegistry } from "../../core/agent/agents/registry";
import { deriveSubagentPermission, permissionScopeFromAgent } from "../../core/agent/agents/permissions";
import { decideTool, type ToolPermissionScope } from "../../core/agent/agents/types";
import { SubagentSessionStore } from "../../core/agent/agents/sessions";
import { sessionStore } from "../../core/session";
import { SessionRunDriver, type ForegroundRun, type RunOutcome, type SettledRun } from "../../core/session/lifecycle";
import { syncTranscriptPreservingReasoning } from "../../tui/events/agentWiring";
import {
  tuiState,
  openActiveToolActivity,
  updateActiveToolProgress,
  closeActiveToolActivity,
} from "../../tui/state";
import { renderActiveToolActivity } from "../../tui/renderers/chatRenderer";
import { stripAnsi } from "../../tui/layout";
import { ADAPTIVE_HARD_CAP } from "../../core/harness/continuation";
import { validateToolCallPairs } from "../../lib/context/toolCallValidator";

// ── deterministic browser fixture (no real Chromium) ────────────────────────
const mockChromium: any = {
  executablePath: () => "/nonexistent/phase7/chrome",
  launch: async () => {
    throw new Error("not launched in this fixture");
  },
};

mock.module("playwright", () => ({ chromium: mockChromium }));
mock.module("playwright-core", () => {
  throw new Error("not implemented");
});

// The browser module must be imported AFTER the module mock above.
import {
  getBrowserCapability,
  executeBrowserTool,
  resetBrowserStateForTests,
  resetBrowserCapabilityCacheForTests,
} from "../../lib/browserTool";

// ═══════════════════════════════════════════════════════════════════════════
// Shared harness / provider scripting
// ═══════════════════════════════════════════════════════════════════════════

const originalFetch = globalThis.fetch;
let tmpDir: string;

interface MockResponse {
  content?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}
interface CapturedTurn {
  messages: any[];
  toolNames: string[];
}

function okResponse(payload: unknown): any {
  const body = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    type: "default",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => JSON.parse(body),
    text: async () => body,
    clone: async () => ({ json: async () => JSON.parse(body), text: async () => body }),
  };
}

function errorResponse(status: number, message: string): any {
  const body = JSON.stringify({ error: { message, type: "invalid_request_error" } });
  return {
    ok: false,
    status,
    statusText: status === 400 ? "Bad Request" : "Error",
    type: "default",
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => JSON.parse(body),
    text: async () => body,
    clone: async () => ({ json: async () => JSON.parse(body), text: async () => body }),
  };
}

function callTool(id: string, name: string, args: any): MockResponse {
  return {
    content: `Working on ${name} #${id}...`,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function callsTool(
  id: string,
  name: string,
  args: any
): NonNullable<MockResponse["tool_calls"]> {
  return [callTool(id, name, args).tool_calls![0]];
}

interface StubOptions {
  scriptedFetches?: boolean;
  /** Fail every provider call with a plain (non-overflow) HTTP error. */
  providerError?: string;
}

function stubModel(
  responses: MockResponse[],
  captured: CapturedTurn[] = [],
  opts: StubOptions = {},
  onRequest?: (messages: any[]) => MockResponse | null
) {
  let turn = 0;
  globalThis.fetch = (async (url: string, options?: { body?: string; signal?: AbortSignal }) => {
    const href = String(url);

    if (opts.scriptedFetches) {
      if (href.includes("phase7-timeout.example")) {
        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        throw error;
      }
      if (href.includes("phase7-404.example")) {
        return new Response("missing", {
          status: 404,
          statusText: "Not Found",
          headers: { "content-type": "text/html" },
        }) as never;
      }
      if (href.includes("phase7-ok.example")) {
        return new Response("<html><head><title>Phase7 OK</title></head><body>recovered page body</body></html>", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/html" },
        }) as never;
      }
    }

    if (options?.body) {
      let parsed: any = null;
      try {
        parsed = JSON.parse(options.body);
      } catch {}
      if (parsed && Array.isArray(parsed.messages)) {
        const messages = parsed.messages;
        captured.push({
          messages,
          toolNames: Array.isArray(parsed.tools) ? parsed.tools.map((t: any) => String(t?.function?.name || "")) : [],
        });
        const injected = onRequest?.(messages);
        if (injected) {
          turn++;
          return okResponse({
            id: `chatcmpl-${turn}`,
            object: "chat.completion",
            created: Date.now(),
            model: "test-model",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: injected.content ?? "",
                  ...(injected.tool_calls?.length ? { tool_calls: injected.tool_calls } : {}),
                },
                finish_reason: injected.tool_calls?.length ? "tool_calls" : "stop",
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          });
        }
        if (opts.providerError) {
          turn++;
          return errorResponse(400, opts.providerError);
        }
      }
    }

    const response = responses[turn] ?? { content: "Done." };
    turn++;
    return okResponse({
      id: `chatcmpl-${turn}`,
      object: "chat.completion",
      created: Date.now(),
      model: "test-model",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: response.content ?? "",
            ...(response.tool_calls?.length ? { tool_calls: response.tool_calls } : {}),
          },
          finish_reason: response.tool_calls?.length ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });
  }) as never;
  return { calls: () => turn };
}

function makeHarness(config: Record<string, unknown> = {}): AgentHarness {
  return new AgentHarness({
    workspaceRoot: tmpDir,
    currentCwd: tmpDir,
    model: "test-model",
    harness: "default",
    ...config,
  } as any);
}

function toolMessages(result: { messages?: any[] }): any[] {
  return (result.messages ?? []).filter((m) => m.role === "tool");
}

function structuredErrorOf(message: any): any {
  try {
    return JSON.parse(String(message.content))?.structuredError;
  } catch {
    return undefined;
  }
}

beforeEach(() => {
  setSandboxMode("full-access");
  setModelCapabilities([
    {
      id: "test-model",
      capabilities: { tools: true, nativeToolCalls: true, reasoning: false, vision: false, streaming: false },
    },
  ]);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-phase7-"));
  globalThis.fetch = originalFetch;
  resetBrowserStateForTests();
  resetBrowserCapabilityCacheForTests();
  mockChromium.executablePath = () => "/nonexistent/phase7/chrome";
  mockChromium.launch = async () => {
    throw new Error("not launched in this fixture");
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  closeActiveToolActivity();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════
// SessionRunDriver control plane (deferred promises only — never a sleep)
// ═══════════════════════════════════════════════════════════════════════════

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

interface RunControl {
  driver: SessionRunDriver;
  runs: ForegroundRun[];
  started: Array<Promise<void>>;
  finish: (index: number, outcome: RunOutcome) => Promise<void>;
  pendingSteers: string[];
  settled: SettledRun[];
  idleCount: () => number;
}

function makeControl(options: { onSettleExtra?: (settled: SettledRun) => void } = {}): RunControl {
  const runs: ForegroundRun[] = [];
  const started: Array<Promise<void>> = [];
  const gates: Array<Deferred<RunOutcome>> = [];
  const settled: SettledRun[] = [];
  const pendingSteers: string[] = [];
  let idle = 0;

  let boundaryWaiters: Array<() => void> = [];
  const signalBoundary = () => {
    const waiters = boundaryWaiters;
    boundaryWaiters = [];
    for (const waiter of waiters) waiter();
  };
  const nextBoundary = () => new Promise<void>((resolve) => boundaryWaiters.push(resolve));

  const driver = new SessionRunDriver({
    sessionId: "phase7",
    run: async (run) => {
      runs.push(run);
      const gate = deferred<RunOutcome>();
      gates.push(gate);
      const start = deferred<void>();
      started.push(start.promise);
      start.resolve();
      signalBoundary();
      return gate.promise;
    },
    promoteSteers: () => {
      const promoted = [...pendingSteers];
      pendingSteers.length = 0;
      return promoted;
    },
    dequeueMessage: () => null,
    admitSteer: (content) => {
      pendingSteers.push(content);
    },
    externalIdleBlockers: () => (pendingSteers.length > 0 ? ["pending-steer"] : []),
    onSettle: (s) => {
      settled.push(s);
      options.onSettleExtra?.(s);
    },
    onIdle: () => {
      idle += 1;
      signalBoundary();
    },
    onDrainEnd: () => signalBoundary(),
  });

  return {
    driver,
    runs,
    started,
    pendingSteers,
    settled,
    idleCount: () => idle,
    finish: async (index, outcome) => {
      const boundary = nextBoundary();
      gates[index].resolve(outcome);
      await boundary;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// The 25 mandatory scenarios
// ═══════════════════════════════════════════════════════════════════════════

describe.serial("PHASE 7 — production regression E2E gate (25 scenarios)", () => {
  // ── 01 ────────────────────────────────────────────────────────────────────
  test("S01 — long realistic coding task (>10 turns) with verifiable progress", async () => {
    const responses: MockResponse[] = [];
    for (let i = 1; i <= 12; i++) {
      fs.writeFileSync(path.join(tmpDir, `module-${i}.ts`), `export const m${i} = ${i};\n`);
      responses.push(callTool(`r${i}`, "read_file", { path: `module-${i}.ts` }));
    }
    responses.push(callTool("w1", "write_file", { path: "report.md", content: "# Report\nAll 12 modules inspected.\n" }));
    responses.push({ content: "Đã kiểm tra 12 module và ghi report.md." });
    stubModel(responses);

    const result = await makeHarness().run("Inspect 12 modules and write a report", { maxTurns: 10 });

    expect(result.success).toBe(true);
    expect(result.turnsUsed).toBeGreaterThan(10);
    expect(result.evidence?.successfulMutations ?? 0).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(tmpDir, "report.md"))).toBe(true);
  });

  // ── 02 ────────────────────────────────────────────────────────────────────
  test("S02 — browser unavailable: capability reports it and the tool returns TOOL_UNAVAILABLE", async () => {
    mockChromium.executablePath = () => "/nonexistent/phase7/chrome";

    const cap = await getBrowserCapability();
    expect(cap.available).toBe(false);
    expect(String(cap.reason)).toContain("Chromium executable unavailable");

    const res = await executeBrowserTool({ url: "https://phase7-ok.example/" });
    expect(res.success).toBe(false);
    expect(String(res.error)).toContain("TOOL_UNAVAILABLE");

    // The harness must not offer the `browser` schema when the runtime cannot
    // honour it (production filter in agentHarness).
    const harness = makeHarness();
    let toolsForRequest: any[] = [];
    (harness as any)["completeModel"] = async (_provider: any, request: any) => {
      toolsForRequest = request.tools ?? [];
      return { response: { content: "done", toolCalls: [] }, hadMessage: true };
    };
    await harness.run("say hi");
    expect(toolsForRequest.length).toBeGreaterThan(0);
    expect(toolsForRequest.find((t) => t?.function?.name === "browser")).toBeUndefined();
  });

  // ── 03 ────────────────────────────────────────────────────────────────────
  test("S03 — browser available fixture: capability green and the browser schema is offered", async () => {
    mockChromium.executablePath = () => process.execPath; // a binary that really exists

    const cap = await getBrowserCapability();
    expect(cap.available).toBe(true);
    expect(cap.reason).toBeUndefined();

    const harness = makeHarness();
    let toolsForRequest: any[] = [];
    (harness as any)["completeModel"] = async (_provider: any, request: any) => {
      toolsForRequest = request.tools ?? [];
      return { response: { content: "done", toolCalls: [] }, hadMessage: true };
    };
    await harness.run("say hi");
    expect(toolsForRequest.length).toBeGreaterThan(0);
    expect(toolsForRequest.find((t) => t?.function?.name === "browser")).toBeDefined();
  });

  // ── 04 ────────────────────────────────────────────────────────────────────
  test("S04 — web_fetch timeout → changed strategy → success", async () => {
    const captured: CapturedTurn[] = [];
    stubModel(
      [
        callTool("t1", "web_fetch", { url: "https://phase7-timeout.example/page" }),
        callTool("t2", "web_fetch", { url: "https://phase7-ok.example/page" }),
        { content: "Recovered by switching target; page read." },
      ],
      captured,
      { scriptedFetches: true }
    );

    const result = await makeHarness().run("Fetch https://phase7-timeout.example/page", { maxTurns: 8 });

    expect(result.success).toBe(true);
    expect(result.turnsUsed).toBe(3);
    const followUp = JSON.stringify(captured[1].messages);
    expect(followUp).toContain("TIMEOUT");
    expect(followUp).toContain("different strategy");
  });

  // ── 05 ────────────────────────────────────────────────────────────────────
  test("S05 — web_fetch permanent error (404): replan, identical retry stops the run", async () => {
    const captured: CapturedTurn[] = [];
    stubModel(
      [
        callTool("p1", "web_fetch", { url: "https://phase7-404.example/gone" }),
        callTool("p2", "web_fetch", { url: "https://phase7-404.example/gone" }),
        { content: "unreachable" },
      ],
      captured,
      { scriptedFetches: true }
    );

    const result = await makeHarness().run("Fetch https://phase7-404.example/gone", { maxTurns: 8 });

    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("Recovery exhausted");
    expect(result.turnsUsed).toBe(2); // no 404 loop, no third provider turn
    const firstFollowUp = JSON.stringify(captured[1].messages);
    expect(firstFollowUp).toContain("404");
    expect(firstFollowUp).toContain("Do not retry the same request");
  });

  // ── 06 ────────────────────────────────────────────────────────────────────
  test("S06 — read_file on a directory recovers with one list_dir, task continues", async () => {
    fs.mkdirSync(path.join(tmpDir, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "pkg", "index.ts"), "export const x = 1;\n");

    const captured: CapturedTurn[] = [];
    stubModel(
      [
        callTool("a1", "read_file", { path: "pkg" }),
        callTool("a2", "list_dir", { path: "pkg" }),
        { content: "Listed pkg/ after the recovery hint; task complete." },
      ],
      captured
    );

    const result = await makeHarness().run("Inspect the pkg directory", { maxTurns: 8 });

    expect(result.success).toBe(true);
    expect(result.turnsUsed).toBe(3);
    const followUp = JSON.stringify(captured[1].messages);
    expect(followUp).toContain("NOT_A_FILE");
    expect(followUp).toContain("list_dir");
  });

  // ── 07 ────────────────────────────────────────────────────────────────────
  test("S07 — permission approve: an ASK tool runs after explicit approval", async () => {
    const scope: ToolPermissionScope = { defaultDecision: "allow", tools: { shell: "ask" } };
    let approvals = 0;
    stubModel(
      [
        callTool("s1", "shell", { command: "echo phase7-approved" }),
        { content: "Command approved and executed." },
      ],
      []
    );

    const result = await makeHarness().run("Echo the marker", {
      maxTurns: 4,
      toolPermissionSet: scope,
      requestApproval: async () => {
        approvals += 1;
        return true;
      },
    });

    expect(approvals).toBe(1);
    expect(result.success).toBe(true);
    expect(result.approvalRequired).toBeFalsy();
    const executed = toolMessages(result).some((m) => String(m.content).includes("phase7-approved"));
    expect(executed).toBe(true);
  });

  // ── 08 ────────────────────────────────────────────────────────────────────
  test("S08 — permission deny: an ASK tool is refused and the run stops loudly", async () => {
    const scope: ToolPermissionScope = { defaultDecision: "allow", tools: { shell: "ask" } };
    stubModel([callTool("s1", "shell", { command: "echo phase7-denied" }), { content: "unreachable" }]);

    const result = await makeHarness().run("Echo the marker", {
      maxTurns: 4,
      toolPermissionSet: scope,
      requestApproval: async () => false,
    });

    expect(result.success).toBe(false);
    expect(result.approvalRequired).toBe(true);
    expect(result.error ?? "").toContain("Permission denied");
    // The denied command never ran.
    const executed = toolMessages(result).some((m) => String(m.content).includes("phase7-denied"));
    expect(executed).toBe(false);
  });

  // ── 09 ────────────────────────────────────────────────────────────────────
  test("S09 — security deny: an out-of-workspace write is refused and cannot be worked around", async () => {
    const outside = path.resolve(path.join(tmpDir, "..", "phase7-escape.txt"));
    if (fs.existsSync(outside)) fs.rmSync(outside, { force: true });

    const captured: CapturedTurn[] = [];
    stubModel(
      [
        callTool("f1", "write_file", { path: "../phase7-escape.txt", content: "escaped" }),
        callTool("f2", "write_file", { path: "../phase7-escape.txt", content: "escaped" }),
        { content: "unreachable" },
      ],
      captured
    );

    const result = await makeHarness({ sandboxMode: "workspace" }).run("Write the summary file", { maxTurns: 8 });

    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("Policy bypass attempt blocked");
    expect(result.turnsUsed).toBe(2);
    expect(fs.existsSync(outside)).toBe(false);
    // The denial is machine-readable and reaches the model as a security verdict.
    const denial = JSON.stringify(captured[1].messages);
    expect(denial.includes("OUTSIDE_WORKSPACE") || denial.includes("SECURITY_DENIED")).toBe(true);
  });

  // ── 10 ────────────────────────────────────────────────────────────────────
  test("S10 — php -r read-only inspection is usable, destructive payloads stay blocked", async () => {
    const safe = "php -r 'echo \"hello\";'";
    expect(classifyShellCommand(safe).riskLevel).not.toBe("CRITICAL_DENY");
    const decision = securityEngine.evaluate("shell", { command: safe }, "workspace");
    expect(decision.decision).toBe("ALLOW");
    expect(decision.allowed).toBe(true);

    // Control: a destructive inline payload is never laundered by the safe case.
    const destructive = "php -r 'shell_exec(\"rm -rf /\");'";
    expect(securityEngine.evaluate("shell", { command: destructive }, "workspace").decision).toBe("DENY");
  });

  // ── 11 ────────────────────────────────────────────────────────────────────
  test("S11 — 2>/dev/null is a discard sink, not system tampering", async () => {
    const cmd = "echo hello 2>/dev/null";
    const ast = parseShellCommand(cmd);
    expect(ast.allRedirectTargets).toContain("/dev/null");
    expect(filesystemRedirectTargets(ast)).toEqual([]);
    expect(assessRedirection({ type: "2>/dev/null", target: "/dev/null" }).writesFilesystem).toBe(false);

    const analysis = classifyShellCommand(cmd);
    expect(analysis.category).toBe("READ_ONLY");
    const result = securityEngine.evaluate("shell", { command: cmd }, "workspace");
    expect(result.decision).toBe("ALLOW");
    expect(result.allowed).toBe(true);

    // Control: a protected write cannot hide behind the discard sink.
    const smuggled = "echo hello 2>/dev/null > /etc/crontab";
    expect(securityEngine.evaluate("shell", { command: smuggled }, "workspace").decision).toBe("DENY");
  });

  // ── 12 ────────────────────────────────────────────────────────────────────
  test("S12 — out-of-order tool results are correlated by call id, never by position", async () => {
    const currentMsgs = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call-cwd", type: "function", function: { name: "get_cwd", arguments: "{}" } },
          { id: "call-browser", type: "function", function: { name: "browser", arguments: "{}" } },
          { id: "call-file", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call-browser", name: "browser", content: "Playwright error", durationMs: 50 },
      { role: "tool", tool_call_id: "call-cwd", name: "get_cwd", content: "/root" },
    ];
    const engineMsgs = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call-cwd", type: "function", function: { name: "get_cwd", arguments: "{}" } },
          { id: "call-browser", type: "function", function: { name: "browser", arguments: "{}" } },
          { id: "call-file", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call-cwd", name: "get_cwd", content: "/root" },
      { role: "tool", tool_call_id: "call-browser", name: "browser", content: "Playwright error" },
      { role: "tool", tool_call_id: "call-file", name: "read_file", content: "File content" },
    ];

    const merged = syncTranscriptPreservingReasoning(currentMsgs, engineMsgs);
    const toolMsgs = merged.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(["call-cwd", "call-browser", "call-file"]);
    expect(validateToolCallPairs(merged).valid).toBe(true);

    // And the real loop executes the parallel batch and correlates by id.
    fs.writeFileSync(path.join(tmpDir, "a.md"), "AAA");
    fs.writeFileSync(path.join(tmpDir, "b.md"), "BBB");
    stubModel([
      { tool_calls: [...callsTool("c1", "read_file", { path: "a.md" }), ...callsTool("c2", "read_file", { path: "b.md" })] },
      { content: "Both files read." },
    ]);
    const result = await makeHarness().run("Read a.md and b.md", { maxTurns: 4 });
    const results = toolMessages(result);
    expect(results).toHaveLength(2);
    const byId = new Map(results.map((m) => [m.tool_call_id, String(m.content)]));
    expect(byId.get("c1")).toContain("AAA");
    expect(byId.get("c2")).toContain("BBB");
  });

  // ── 13 ────────────────────────────────────────────────────────────────────
  test("S13 — two tools with the SAME name correlate by call id, not by name", async () => {
    const currentMsgs = [
      { role: "tool", tool_call_id: "read-2", name: "read_file", content: "CONTENT_B" },
      { role: "tool", tool_call_id: "read-1", name: "read_file", content: "CONTENT_A" },
    ];
    const engineMsgs = [
      { role: "tool", tool_call_id: "read-1", name: "read_file", content: "CONTENT_A" },
      { role: "tool", tool_call_id: "read-2", name: "read_file", content: "CONTENT_B" },
    ];
    const merged = syncTranscriptPreservingReasoning(currentMsgs, engineMsgs);
    expect(merged.map((m) => m.content)).toEqual(["CONTENT_A", "CONTENT_B"]);

    // Real loop: same tool name twice in one turn → distinct, correct results.
    fs.writeFileSync(path.join(tmpDir, "first.md"), "FIRST_BODY");
    fs.writeFileSync(path.join(tmpDir, "second.md"), "SECOND_BODY");
    stubModel([
      {
        tool_calls: [
          ...callsTool("same-1", "read_file", { path: "first.md" }),
          ...callsTool("same-2", "read_file", { path: "second.md" }),
        ],
      },
      { content: "Read both same-name calls." },
    ]);
    const result = await makeHarness().run("Read first.md and second.md", { maxTurns: 4 });
    const results = toolMessages(result);
    expect(results).toHaveLength(2);
    const byId = new Map(results.map((m) => [m.tool_call_id, String(m.content)]));
    expect(byId.get("same-1")).toContain("FIRST_BODY");
    expect(byId.get("same-2")).toContain("SECOND_BODY");
  });

  // ── 14 ────────────────────────────────────────────────────────────────────
  test("S14 — cancellation race: a late success never resurrects a cancelled run", async () => {
    const c = makeControl();
    c.driver.submit("long task");
    c.pendingSteers.push("STEER_DURING_CANCEL");

    expect(c.driver.cancel()).toBe(true);

    // The provider success arrives AFTER the cancel.
    await c.finish(0, { success: true });

    expect(c.settled).toHaveLength(1);
    expect(c.settled[0].phase).toBe("cancelled");
    expect(c.settled[0].error).toBe("Cancelled");
    expect(c.runs).toHaveLength(1); // no auto-continuation after a cancel
    expect(c.driver.idleBlockers()).toContain("pending-steer");
    // The steer is not lost — an explicit resume still delivers it.
    expect(c.pendingSteers).toEqual(["STEER_DURING_CANCEL"]);
  });

  // ── 15 ────────────────────────────────────────────────────────────────────
  test("S15 — assistant text → tool → text keeps the transcript order and the final answer", async () => {
    fs.writeFileSync(path.join(tmpDir, "note.md"), "hello phase7");
    stubModel([
      { content: "Let me inspect the note.", tool_calls: callsTool("read-1", "read_file", { path: "note.md" }) },
      { content: "The note says: hello phase7." },
    ]);

    const result = await makeHarness().run("What does note.md say?", { maxTurns: 4 });

    expect(result.success).toBe(true);
    expect(result.output).toContain("hello phase7");
    const roles = (result.messages ?? []).map((m) => m.role);
    const assistantIdx = roles.indexOf("assistant");
    expect(assistantIdx).toBeGreaterThan(-1);
    const assistant = (result.messages ?? [])[assistantIdx] as any;
    expect(String(assistant.content)).toContain("Let me inspect");
    expect(assistant.tool_calls?.[0]?.id).toBe("read-1");
    expect(roles.lastIndexOf("assistant")).toBeGreaterThan(roles.indexOf("tool"));
  });

  // ── 16 ────────────────────────────────────────────────────────────────────
  test("S16 — silent long-running activity still shows elapsed progress (52/80/120)", async () => {
    for (const cols of [52, 80, 120]) {
      closeActiveToolActivity();
      openActiveToolActivity("call-silent", "bash", { command: "bun test very/deeply/nested/path/suite.test.ts" });
      // A silent tool: no stdout tail at all, only elapsed time.
      updateActiveToolProgress("call-silent", [], 15000);

      const activity = tuiState.activeToolActivity!;
      expect(activity.elapsedMs).toBe(15000);
      expect(activity.status).toBe("running");
      expect(activity.tail?.length ?? 0).toBe(0);

      const rendered = renderActiveToolActivity(activity, cols);
      expect(rendered.length).toBeGreaterThan(0);
      const text = rendered.map((l) => stripAnsi(l)).join("\n");
      expect(text).toContain("15s");
      expect(text).toContain("bun test");
      for (const line of rendered) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(cols);
      }
    }
    closeActiveToolActivity();
  });

  // ── 17 ────────────────────────────────────────────────────────────────────
  test("S17 — a steer arriving exactly at completion becomes the next work, never lost", async () => {
    let idleWhenSecondStarted = -1;
    let injected = false;
    const c = makeControl({
      onSettleExtra: () => {
        if (injected) return;
        injected = true;
        c.pendingSteers.push("STEER_AT_COMPLETION");
      },
    });

    c.driver.submit("complete me");
    await c.finish(0, { success: true });
    await c.started[1];
    idleWhenSecondStarted = c.idleCount();

    expect(c.runs).toHaveLength(2);
    expect(c.runs[1].kind).toBe("continuation");
    expect(c.runs[1].promoted).toEqual(["STEER_AT_COMPLETION"]);
    // The session never reported IDLE between the settle and the next run.
    expect(idleWhenSecondStarted).toBe(0);
    await c.finish(1, { success: true });
    expect(c.driver.getPhase()).toBe("idle");
    expect(c.idleCount()).toBe(1);
  });

  // ── 18 ────────────────────────────────────────────────────────────────────
  test("S18 — provider error fails loudly, once, with no tool execution", async () => {
    const stub = stubModel([], [], { providerError: "phase7 upstream provider failure" });

    const result = await makeHarness().run("Do the thing", { maxTurns: 4 });

    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("phase7 upstream provider failure");
    expect(stub.calls()).toBe(1);
    expect(toolMessages(result)).toHaveLength(0);
  });

  // ── 19 ────────────────────────────────────────────────────────────────────
  test("S19 — crash/restart/resume: interrupted call is surfaced, never fabricated", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-phase7-sessions-"));
    const previous = process.env.TOOLNETCLI_SESSIONS_DIR;
    process.env.TOOLNETCLI_SESSIONS_DIR = dir;
    try {
      const id = `phase7_resume_${Date.now()}`;
      sessionStore.create({ id });
      sessionStore.setStatus(id, "running", { reason: "run-started" });
      sessionStore.appendSessionEvent(id, "user.message", { content: "read the config" });
      sessionStore.appendSessionEvent(id, "assistant.message", { content: "" });
      sessionStore.appendSessionEvent(id, "session.input.admitted", {
        inputId: "pin7",
        content: "steer that survived the crash",
        delivery: "steer",
        admittedSequence: 1,
      });
      // Tool started and the process died before any result was persisted.
      sessionStore.appendSessionEvent(id, "tool.started", {
        callId: "call7",
        name: "write_file",
        args: { path: "a.txt" },
      });

      const resumed = sessionStore.resume(id, { liveOwner: false });

      expect(resumed.status).toBe("interrupted");
      expect(resumed.interruptedTools).toHaveLength(1);
      expect(resumed.interruptedTools[0].callId).toBe("call7");
      // No fabricated tool result and no replayed mutation.
      expect(resumed.transcript.filter((m) => m.role === "tool")).toHaveLength(0);
      expect(resumed.evidence.filesChanged).toEqual([]);

      // Reconstruction is idempotent.
      const again = sessionStore.resume(id, { liveOwner: false });
      expect(again.interruptedTools).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.TOOLNETCLI_SESSIONS_DIR;
      else process.env.TOOLNETCLI_SESSIONS_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── 20 ────────────────────────────────────────────────────────────────────
  test("S20 — no-progress loop stops early with a distinct loop error", async () => {
    const responses: MockResponse[] = [];
    for (let i = 1; i <= 40; i++) responses.push(callTool(`l${i}`, "shell", { command: "echo loop" }));
    stubModel(responses);

    const result = await makeHarness().run("Loop forever", { maxTurns: 10 });

    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("Infinite loop detected");
    expect(result.turnsUsed).toBeLessThan(ADAPTIVE_HARD_CAP);
  });

  // ── 21 ────────────────────────────────────────────────────────────────────
  test("S21 — repeated equivalent failures are detected and bounded", async () => {
    stubModel([
      callTool("e1", "shell", { command: "exit 1" }),
      callTool("e2", "shell", { command: "EXIT 1" }),
      callTool("e3", "shell", { command: "exit 1 " }),
      { content: "I keep failing." },
    ]);

    const result = await makeHarness().run("Retry the same broken thing", { maxTurns: 10 });

    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("equivalent argument variants");
    expect(result.turnsUsed).toBeLessThan(10);
  });

  // ── 22 ────────────────────────────────────────────────────────────────────
  test("S22 — structured errors reach the model in the machine-readable envelope", async () => {
    fs.mkdirSync(path.join(tmpDir, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "pkg", "index.ts"), "export const x = 1;\n");

    const captured: CapturedTurn[] = [];
    stubModel(
      [
        callTool("a1", "read_file", { path: "pkg" }),
        callTool("a2", "list_dir", { path: "pkg" }),
        { content: "Listed after recovery." },
      ],
      captured
    );

    const result = await makeHarness().run("Inspect pkg", { maxTurns: 8 });
    expect(result.success).toBe(true);

    // The SECOND provider request carries the structured failure the model saw.
    const toolMsg = captured[1].messages.find((m: any) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    const structured = structuredErrorOf(toolMsg);
    expect(structured?.code).toBe("NOT_A_FILE");
    expect(structured?.retryable).toBe(false);
  });

  // ── 23 ────────────────────────────────────────────────────────────────────
  test("S23 — Plan mode write denial: a mutation cannot be laundered into the plan", async () => {
    const planScope = permissionScopeFromAgent(agentRegistry.resolve("plan"));
    expect(decideTool(planScope, "write_file")).toBe("deny");
    expect(decideTool(planScope, "shell")).toBe("deny");

    const target = "phase7-plan.txt";
    stubModel([
      callTool("pw1", "write_file", { path: target, content: "nope" }),
      callTool("pw2", "write_file", { path: target, content: "nope" }),
      { content: "unreachable" },
    ]);

    const result = await makeHarness({ sandboxMode: "workspace" }).run("Write the plan file", {
      maxTurns: 4,
      toolPermissionSet: planScope,
    });

    expect(result.success).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, target))).toBe(false);
    const denied = toolMessages(result).some((m) => structuredErrorOf(m)?.code === "PERMISSION_DENIED");
    expect(denied).toBe(true);
  });

  // ── 24 ────────────────────────────────────────────────────────────────────
  test("S24 — foreground/subagent separation: a child can never exceed or contaminate the parent", async () => {
    // The foreground runs read-only: write_file is denied at the parent scope.
    const parentScope: ToolPermissionScope = { defaultDecision: "allow", tools: { write_file: "deny" } };
    const coderChild = deriveSubagentPermission({
      parentPermission: parentScope,
      agentDefinition: agentRegistry.get("coder")!,
    });
    expect(decideTool(coderChild, "write_file")).toBe("deny");
    expect(decideTool(coderChild, "read_file")).toBe("allow");

    const child = "phase7-sub.txt";
    stubModel([
      callTool("sw1", "write_file", { path: child, content: "leak" }),
      callTool("sw2", "write_file", { path: child, content: "leak" }),
      { content: "unreachable" },
    ]);

    const parentHarness = makeHarness();
    const res = await parentHarness.runSubagent("coder" as any, "Write the child file", {
      maxTurns: 4,
      toolPermissionSet: coderChild,
      toolsOverride: [
        { type: "function", function: { name: "write_file", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } },
      ],
    });

    expect(res.success).toBe(false);
    expect(res.mode).toBe("SUBAGENT");
    expect(fs.existsSync(path.join(tmpDir, child))).toBe(false);
    expect(toolMessages(res).some((m) => structuredErrorOf(m)?.code === "PERMISSION_DENIED")).toBe(true);
    // The parent scope itself stays unchanged (no escalation side effect).
    expect(decideTool(parentScope, "write_file")).toBe("deny");
    expect(decideTool(parentScope, "read_file")).toBe("allow");

    // Child sessions are isolated from each other and from the parent.
    const store = new SubagentSessionStore();
    const a = store.create({ parentSessionId: "p1", agentId: "coder", prompt: "fix bug", depth: 1 });
    store.appendMessages(a.id, [{ role: "assistant", content: "working" }]);
    const b = store.create({ parentSessionId: "p2", agentId: "coder", prompt: "other", depth: 1 });
    expect(store.get(a.id)!.messages.length).toBe(2);
    expect(store.get(b.id)!.messages.length).toBe(1);
    expect(store.listByParent("p1").map((s) => s.id)).toEqual([a.id]);
  });

  // ── 25 ────────────────────────────────────────────────────────────────────
  test("S25 — compaction/context continuation: an overflow compacts and the task finishes", async () => {
    // First provider call → a tool call (real history). The next loop request is
    // rejected once with a context-length overflow; the harness must compact and
    // retry exactly once, then continue to a successful finish.
    let failed = false;
    let innerTurn = 0;
    globalThis.fetch = (async (_url: string, options?: { body?: string }) => {
      const payload = options?.body ? JSON.parse(options.body) : {};
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      innerTurn++;
      const shouldFail = !failed && messages.length >= 3;
      if (shouldFail) {
        failed = true;
        return errorResponse(
          400,
          "This model's maximum context length is 128000 tokens, however you requested 200000 tokens"
        );
      }
      const current = innerTurn - 1;
      const response =
        current === 0
          ? {
              content: "",
              tool_calls: callsTool("w1", "write_file", { path: "phase7-overflow.txt", content: "hello\n" }),
            }
          : { content: "Recovered after compaction.", tool_calls: [] };
      return okResponse({
        id: `chatcmpl-${innerTurn}`,
        object: "chat.completion",
        created: Date.now(),
        model: "test-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: response.content ?? "",
              ...(response.tool_calls?.length ? { tool_calls: response.tool_calls } : {}),
            },
            finish_reason: response.tool_calls?.length ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      });
    }) as never;

    const harness = makeHarness();
    const events: Array<{ type: string; payload?: any }> = [];
    harness.on((event) => events.push({ type: event.type, payload: event.payload }));

    const prompt = `Fix the build.\n${"previous context line\n".repeat(2_200)}`;
    const result = await harness.run(prompt, { maxTurns: 6 });

    const overflowCompaction = events.filter(
      (e) => e.type === "agent:compact" && e.payload?.trigger === "provider_overflow"
    );
    expect(overflowCompaction).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.output).toContain("Recovered after compaction");
    expect(fs.existsSync(path.join(tmpDir, "phase7-overflow.txt"))).toBe(true);
  });
});
