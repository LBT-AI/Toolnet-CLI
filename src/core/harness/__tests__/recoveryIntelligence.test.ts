/**
 * Phase 5 — Structured error-driven recovery intelligence.
 *
 * Two layers are tested:
 *
 *   1. `RecoveryGovernor` — the pure, code-driven policy (deterministic unit
 *      tests, no I/O).
 *   2. The REAL `AgentHarness` loop against a stubbed provider, so scenarios
 *      A–J run through production code paths (same technique as
 *      adaptiveBudget.test.ts / integration.test.ts).
 *
 * No real provider, no timers beyond the tool's own bounded retry backoff,
 * temp dirs only.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHarness } from "../../../lib/harness";
import { setSandboxMode } from "../../../lib/permissions";
import { setModelCapabilities } from "../../../lib/reasoning";
import {
  browserRequestRequiresRealBrowser,
  extractStructuredError,
  recoveryDenialSignature,
  recoveryFailureSignature,
  RecoveryGovernor,
  RECOVERY_MAX_ATTEMPTS_PER_SIGNATURE,
  RECOVERY_MAX_TOTAL_ATTEMPTS,
  type RecoveryFailure,
} from "..";
import type { StructuredToolError, ToolErrorCode } from "../../contracts";

const originalFetch = globalThis.fetch;

let tmpDir: string;

beforeEach(() => {
  setSandboxMode("full-access");
  setModelCapabilities([
    {
      id: "test-model",
      capabilities: { tools: true, nativeToolCalls: true, reasoning: false, vision: false, streaming: false },
    },
  ]);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-phase5-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. RecoveryGovernor — pure policy
// ═══════════════════════════════════════════════════════════════════════════

const REGISTRY_TOOLS = new Set([
  "read_file",
  "list_dir",
  "tree",
  "web_fetch",
  "browser",
  "browser_action",
  "shell",
  "write_file",
]);

function failure(
  toolName: string,
  args: Record<string, unknown>,
  code: ToolErrorCode,
  extra: Partial<StructuredToolError> = {},
  opts: { target?: string; availableTools?: ReadonlySet<string> } = {}
): RecoveryFailure {
  return {
    toolName,
    args,
    error: { code, message: code, retryable: false, ...extra },
    target: opts.target,
    availableTools: opts.availableTools ?? REGISTRY_TOOLS,
  };
}

describe("Phase 5 — RecoveryGovernor: inline interpreter-free code-driven policy", () => {
  test("1. NOT_A_FILE → one deterministic list_dir recovery, then bounded stop", () => {
    const gov = new RecoveryGovernor();
    const first = gov.assess(failure("read_file", { path: "src" }, "NOT_A_FILE", { suggestedTool: "list_dir" }));
    expect(first.action).toBe("alternate");
    expect(first.alternateTool).toBe("list_dir");
    expect(first.stop).toBe(false);
    expect(first.instruction).toContain("list_dir");
    expect(gov.totalRecoveries).toBe(1);

    // An EQUIVALENT variant of the same failure is not a new recovery.
    const second = gov.assess(failure("read_file", { path: "SRC" }, "NOT_A_FILE", { suggestedTool: "list_dir" }));
    expect(second.stop).toBe(true);
    expect(second.error).toContain("Recovery exhausted");
    expect(gov.totalRecoveries).toBe(1);
  });

  test("2. TOOL_UNAVAILABLE: web_fetch only when the semantics allow it", () => {
    const gov = new RecoveryGovernor();
    const readOnly = gov.assess(failure("browser_action", { url: "https://example.com" }, "TOOL_UNAVAILABLE"));
    expect(readOnly.action).toBe("alternate");
    expect(readOnly.alternateTool).toBe("web_fetch");

    const interactive = gov.assess(
      failure("browser_action", { url: "https://example.com", screenshot: true }, "TOOL_UNAVAILABLE")
    );
    expect(interactive.action).toBe("replan");
    expect(interactive.alternateTool).toBeUndefined();
    expect(interactive.instruction).toContain("real browser interaction");

    expect(browserRequestRequiresRealBrowser({ action: "click" })).toBe(true);
    expect(browserRequestRequiresRealBrowser({ url: "https://example.com" })).toBe(false);
  });

  test("3. TOOL_UNAVAILABLE with no equivalent stays a replan; repeat stops", () => {
    const gov = new RecoveryGovernor();
    const first = gov.assess(failure("totally_unknown_tool", { x: 1 }, "TOOL_UNAVAILABLE"));
    expect(first.action).toBe("replan");
    expect(first.stop).toBe(false);
    const second = gov.assess(failure("totally_unknown_tool", { x: 1 }, "TOOL_UNAVAILABLE"));
    expect(second.stop).toBe(true);
    expect(second.error).toContain("Recovery exhausted");
  });

  test("4. TIMEOUT after internal retries: one changed strategy, then bounded stop", () => {
    const gov = new RecoveryGovernor();
    const first = gov.assess(failure("web_fetch", { url: "https://slow.example" }, "TIMEOUT"));
    expect(first.action).toBe("retry-with-changes");
    expect(first.instruction).toContain("different strategy");
    expect(gov.assess(failure("web_fetch", { url: "https://slow.example" }, "TIMEOUT")).stop).toBe(true);
  });

  test("5. NETWORK_ERROR: same bounded policy, alternate when a mapping exists", () => {
    const gov = new RecoveryGovernor();
    const alt = gov.assess(failure("browser_action", { url: "https://x.example" }, "NETWORK_ERROR"));
    expect(alt.action).toBe("alternate");
    expect(alt.alternateTool).toBe("web_fetch");

    const plain = new RecoveryGovernor().assess(failure("web_fetch", { url: "https://x.example" }, "NETWORK_ERROR"));
    expect(plain.action).toBe("retry-with-changes");
    expect(plain.stop).toBe(false);
  });

  test("6/7. HTTP_ERROR: 404/403 never retried, 5xx gets one bounded strategy", () => {
    const g404 = new RecoveryGovernor();
    const d = g404.assess(failure("web_fetch", { url: "https://x.example/missing" }, "HTTP_ERROR", { details: { status: 404 } }));
    expect(d.action).toBe("replan");
    expect(d.instruction).toContain("404");
    expect(g404.assess(failure("web_fetch", { url: "https://x.example/missing" }, "HTTP_ERROR", { details: { status: 404 } })).stop).toBe(true);

    const g500 = new RecoveryGovernor();
    const s = g500.assess(failure("web_fetch", { url: "https://x.example/down" }, "HTTP_ERROR", { details: { status: 500 } }));
    expect(s.action).toBe("retry-with-changes");
    expect(s.stop).toBe(false);
    expect(g500.assess(failure("web_fetch", { url: "https://x.example/down" }, "HTTP_ERROR", { details: { status: 500 } })).stop).toBe(true);
  });

  test("8. SECURITY_DENIED: never a bypass variant — the same target stops the run", () => {
    const gov = new RecoveryGovernor();
    const first = gov.assess(failure("shell", { command: "cat /etc/shadow" }, "SECURITY_DENIED"));
    expect(first.action).toBe("replan");
    expect(first.stop).toBe(false);
    expect(first.instruction).toContain("Do NOT rewrite the command into a variant");

    // A DIFFERENT variant of the SAME policy verdict on the SAME target is a
    // bypass attempt — the coarse denial signature catches it.
    const variant = gov.assess(failure("shell", { command: "cat  /etc/shadow " }, "SECURITY_DENIED"));
    expect(variant.stop).toBe(true);
    expect(variant.error).toContain("Policy bypass attempt blocked");
  });

  test("9. PERMISSION_DENIED: replan, never a bypass variant", () => {
    const gov = new RecoveryGovernor();
    expect(gov.assess(failure("write_file", { path: "/etc/passwd" }, "PERMISSION_DENIED")).action).toBe("replan");
    const again = gov.assess(failure("write_file", { path: "/etc/passwd" }, "PERMISSION_DENIED"));
    expect(again.stop).toBe(true);
    expect(again.error).toContain("Policy bypass attempt blocked");
  });

  test("10. PERMISSION_REQUIRED: wait for approval, never spam alternatives", () => {
    const gov = new RecoveryGovernor();
    const first = gov.assess(failure("shell", { command: "rm -rf build" }, "PERMISSION_REQUIRED"));
    expect(first.action).toBe("await-approval");
    expect(first.stop).toBe(false);
    expect(first.alternateTool).toBeUndefined();
    expect(first.instruction).toContain("Wait for the decision");

    const spam = gov.assess(failure("shell", { command: "rm -rf build" }, "PERMISSION_REQUIRED"));
    expect(spam.stop).toBe(true);
    expect(spam.error).toContain("Approval is still pending");
  });

  test("11. CANCELLED: recovery stops immediately (no corrective turn, no budget spent)", () => {
    const gov = new RecoveryGovernor();
    const decision = gov.assess(failure("shell", { command: "sleep 30" }, "CANCELLED"));
    expect(decision.action).toBe("stop");
    expect(decision.stop).toBe(true);
    expect(decision.instruction).toBeUndefined();
    expect(gov.totalRecoveries).toBe(0);
  });

  test("12. INTERNAL_ERROR: no blind retry", () => {
    const gov = new RecoveryGovernor();
    const decision = gov.assess(failure("read_file", { path: "a.txt" }, "INTERNAL_ERROR"));
    expect(decision.action).toBe("stop");
    expect(decision.stop).toBe(true);
    expect(decision.error).toContain("not retrying automatically");
    expect(gov.totalRecoveries).toBe(0);
  });

  test("13. codes outside the policy (e.g. EXECUTION_FAILED) are left untouched", () => {
    const gov = new RecoveryGovernor();
    const decision = gov.assess(failure("shell", { command: "exit 1" }, "EXECUTION_FAILED"));
    expect(decision.action).toBe("none");
    expect(decision.stop).toBe(false);
    expect(gov.totalRecoveries).toBe(0);
    expect(gov.trackedSignatures).toBe(0);
  });

  test("14. the recovery budget is bounded and independent of the turn budget", () => {
    const gov = new RecoveryGovernor();
    expect(RECOVERY_MAX_ATTEMPTS_PER_SIGNATURE).toBe(1);
    expect(RECOVERY_MAX_TOTAL_ATTEMPTS).toBe(3);

    const granted = [
      gov.assess(failure("read_file", { path: "dir-a" }, "NOT_A_FILE", { suggestedTool: "list_dir" })),
      gov.assess(failure("web_fetch", { url: "https://a.example" }, "TIMEOUT")),
      gov.assess(failure("web_fetch", { url: "https://b.example" }, "NETWORK_ERROR")),
    ];
    for (const d of granted) expect(d.stop).toBe(false);
    expect(gov.totalRecoveries).toBe(RECOVERY_MAX_TOTAL_ATTEMPTS);

    const overflow = gov.assess(failure("web_fetch", { url: "https://c.example" }, "TIMEOUT"));
    expect(overflow.stop).toBe(true);
    expect(overflow.error).toContain("Recovery budget exhausted");
  });

  test("15. failure signatures: equivalent variants collapse, different targets do not", () => {
    const a = recoveryFailureSignature("shell", { command: "EXIT  1" }, "EXECUTION_FAILED", "/app");
    const b = recoveryFailureSignature("shell", { command: "exit 1" }, "EXECUTION_FAILED", "/app");
    expect(a).toBe(b);

    const otherTarget = recoveryFailureSignature("shell", { command: "exit 1" }, "EXECUTION_FAILED", "/other");
    expect(otherTarget).not.toBe(b);

    // Denial signatures ignore args entirely: ANY retry on the same target.
    expect(recoveryDenialSignature("write_file", "SECURITY_DENIED", "/etc/x")).toBe(
      recoveryDenialSignature("write_file", "SECURITY_DENIED", "/ETC/X")
    );
  });

  test("16. extractStructuredError reads the machine-readable block only", () => {
    const envelope = JSON.stringify({
      stdout: "",
      stderr: "Not a file: /tmp/x",
      exitCode: 1,
      structuredError: { code: "NOT_A_FILE", message: "Not a file", retryable: false, suggestedTool: "list_dir" },
    });
    expect(extractStructuredError(envelope)?.code).toBe("NOT_A_FILE");
    expect(extractStructuredError(envelope)?.suggestedTool).toBe("list_dir");
    // Prose is never parsed into a code.
    expect(extractStructuredError("Not a file: /tmp/x")).toBeNull();
    expect(extractStructuredError(JSON.stringify({ stdout: "ok", exitCode: 0 }))).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Harness integration — scenarios A–J on the REAL loop
// ═══════════════════════════════════════════════════════════════════════════

interface MockResponse {
  content?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
}

function callTool(id: string, name: string, args: any): MockResponse {
  return {
    content: `Working on ${name} #${id}...`,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

interface CapturedTurn {
  messages: any[];
  toolNames: string[];
}

/**
 * Stubbed provider. Requests to the stub's own model endpoint replay the
 * scripted responses; requests to the phase5 `*.example` hosts are the tool's
 * REAL fetch path and are answered here so web_fetch behavior is exercised
 * without a network.
 */
function stubModel(responses: MockResponse[], captured: CapturedTurn[], opts: { scriptedFetches?: boolean } = {}) {
  let turn = 0;
  globalThis.fetch = (async (url: string, options?: { body?: string; signal?: AbortSignal }) => {
    const href = String(url);

    if (opts.scriptedFetches) {
      if (href.includes("phase5-timeout.example")) {
        const error = new Error("Request aborted");
        error.name = "AbortError";
        throw error;
      }
      if (href.includes("phase5-404.example")) {
        return new Response("missing", { status: 404, statusText: "Not Found", headers: { "content-type": "text/html" } }) as never;
      }
      if (href.includes("phase5-ok.example")) {
        return new Response("<html><head><title>Phase5 OK</title></head><body>recovered page body</body></html>", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "text/html" },
        }) as never;
      }
    }

    if (options?.body) {
      try {
        const body = JSON.parse(options.body);
        captured.push({
          messages: Array.isArray(body.messages) ? body.messages : [],
          toolNames: Array.isArray(body.tools) ? body.tools.map((t: any) => String(t?.function?.name || "")) : [],
        });
      } catch {}
    }

    const response = responses[turn] ?? { content: "Done." };
    turn++;
    const body = JSON.stringify({
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
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      type: "default",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => JSON.parse(body),
      text: async () => body,
      clone: async () => ({ json: async () => JSON.parse(body), text: async () => body }),
    } as never;
  }) as never;
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

const probeSchema = (name: string) => ({
  type: "function",
  function: { name, description: `phase5 probe: ${name}`, parameters: { type: "object", properties: {}, required: [] } },
});

/** A custom (non-registry) tool that always returns one structured envelope. */
function customToolEnvelope(map: Record<string, () => string | null>) {
  return async (name: string, _args: any, _id: string) => {
    const produce = map[name];
    if (!produce) return null;
    const result = produce();
    if (result === null) return null;
    return { result, allowed: false };
  };
}

const envelope = (error: Partial<StructuredToolError> & { code: ToolErrorCode }, exitCode = 1) =>
  JSON.stringify({
    stdout: "",
    stderr: error.message ?? error.code,
    exitCode,
    structuredError: { message: error.code, retryable: false, ...error },
  });

describe("Phase 5 — A/B: directory recovery and unavailable-tool recovery", () => {
  test("A. read_file on a directory → one deterministic list_dir recovery, task continues", async () => {
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
    expect(result.error).toBeUndefined();
    expect(result.turnsUsed).toBe(3);

    // The recovery instruction reached the model on the turn AFTER the failure.
    const followUp = JSON.stringify(captured[1].messages);
    expect(followUp).toContain("NOT_A_FILE");
    expect(followUp).toContain("list_dir");
    expect(followUp).toContain("do not call 'read_file' on it again");
  });

  test("B. unavailable browser → no repeated browser; ONE bounded web_fetch alternate", async () => {
    const captured: CapturedTurn[] = [];
    stubModel(
      [
        callTool("b1", "browser_action", { url: "https://phase5-ok.example/page" }),
        callTool("b2", "web_fetch", { url: "https://phase5-ok.example/page" }),
        { content: "Recovered with web_fetch; page read." },
      ],
      captured,
      { scriptedFetches: true }
    );

    const result = await makeHarness().run("Open https://phase5-ok.example/page and summarize it", {
      maxTurns: 8,
      toolsOverride: [probeSchema("browser_action"), probeSchema("web_fetch")],
      onCustomTool: customToolEnvelope({
        browser_action: () =>
          envelope({ code: "TOOL_UNAVAILABLE", message: "Browser (Chromium) is not available in this environment." }),
      }),
    });

    expect(result.success).toBe(true);
    expect(result.turnsUsed).toBe(3);
    const followUp = JSON.stringify(captured[1].messages);
    expect(followUp).toContain("TOOL_UNAVAILABLE");
    expect(followUp).toContain("web_fetch");
    expect(followUp).toContain("never call 'browser_action' again");
    // The browser tool was attempted exactly once.
    const browserAttempts = captured[1].messages.filter(
      (m: any) => m.role === "tool" && String(m.content).includes("TOOL_UNAVAILABLE")
    );
    expect(browserAttempts.length).toBe(1);
  });
});

describe("Phase 5 — C/D: timeout and HTTP recovery stay bounded", () => {
  test("C. TIMEOUT after internal retries → ONE bounded changed strategy (not an identical loop)", async () => {
    const captured: CapturedTurn[] = [];
    stubModel(
      [
        callTool("c1", "web_fetch", { url: "https://phase5-timeout.example/page" }),
        callTool("c2", "web_fetch", { url: "https://phase5-ok.example/page" }),
        { content: "Recovered by switching target." },
      ],
      captured,
      { scriptedFetches: true }
    );

    const result = await makeHarness().run("Fetch https://phase5-timeout.example/page", { maxTurns: 8 });
    expect(result.success).toBe(true);
    const followUp = JSON.stringify(captured[1].messages);
    expect(followUp).toContain("TIMEOUT");
    expect(followUp).toContain("different strategy");
    expect(followUp).toContain("Repeating the identical call is not allowed");
  });

  test("D. HTTP 404 → replan instruction, and an identical retry stops the run", async () => {
    const captured: CapturedTurn[] = [];
    stubModel(
      [
        callTool("d1", "web_fetch", { url: "https://phase5-404.example/gone" }),
        callTool("d2", "web_fetch", { url: "https://phase5-404.example/gone" }),
        { content: "unreachable" },
      ],
      captured,
      { scriptedFetches: true }
    );

    const result = await makeHarness().run("Fetch https://phase5-404.example/gone", { maxTurns: 8 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Recovery exhausted");
    // Stopped at the SECOND failure: no third provider turn, no 404 loop.
    expect(result.turnsUsed).toBe(2);
    const firstFollowUp = JSON.stringify(captured[1].messages);
    expect(firstFollowUp).toContain("404");
    expect(firstFollowUp).toContain("Do not retry the same request");
  });
});

describe("Phase 5 — E/F: denials never turn into bypass variants", () => {
  test("F. a security denial cannot be worked around by re-issuing the same target", async () => {
    const outside = path.join(tmpDir, "..", "phase5-escape.txt");
    const captured: CapturedTurn[] = [];
    stubModel(
      [
        callTool("f1", "write_file", { path: "../phase5-escape.txt", content: "escaped" }),
        callTool("f2", "write_file", { path: "../phase5-escape.txt", content: "escaped" }),
        { content: "unreachable" },
      ],
      captured
    );

    const result = await makeHarness({ sandboxMode: "workspace" }).run("Write the summary file", { maxTurns: 8 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Policy bypass attempt blocked");
    expect(result.turnsUsed).toBe(2);
    // Nothing was written outside the workspace.
    expect(fs.existsSync(path.resolve(outside))).toBe(false);

    const firstFollowUp = JSON.stringify(captured[1].messages);
    expect(firstFollowUp).toContain("Do NOT rewrite the command into a variant");
  });

  test("E. a permission denial is not retried as a bypass variant", async () => {
    const captured: CapturedTurn[] = [];
    stubModel(
      [
        callTool("e1", "shell", { command: "echo hello" }),
        callTool("e2", "shell", { command: "echo hello " }),
        { content: "unreachable" },
      ],
      captured
    );

    const result = await makeHarness().run("Say hello", {
      maxTurns: 8,
      // Scope: read-only tools only — shell is denied BEFORE the security gateway.
      toolPermissionSet: { defaultDecision: "deny", tools: {}, allowedTools: ["read_file", "list_dir", "tree"] },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Policy bypass attempt blocked");
    expect(result.turnsUsed).toBe(2);
    expect(JSON.stringify(captured[1].messages)).toContain("PERMISSION_DENIED");
  });
});

describe("Phase 5 — G/H/I/J: cancel, equivalent repeats, successful recovery, bounded stop", () => {
  test("G. a cancelled tool stops recovery — no corrective turn is requested", async () => {
    const captured: CapturedTurn[] = [];
    stubModel([callTool("g1", "phase5_cancel_probe", {}), { content: "should never be requested" }], captured);

    const result = await makeHarness().run("Probe the cancellation path", {
      maxTurns: 8,
      toolsOverride: [probeSchema("phase5_cancel_probe")],
      onCustomTool: customToolEnvelope({
        phase5_cancel_probe: () => envelope({ code: "CANCELLED", message: "Cancelled" }, 130),
      }),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Cancelled");
    expect(result.turnsUsed).toBe(1);
    expect(captured.length).toBe(1); // exactly one provider turn — no recovery prompt
  });

  test("H. an equivalent repeated failure stops the run instead of looping", async () => {
    fs.mkdirSync(path.join(tmpDir, "again"), { recursive: true });
    const captured: CapturedTurn[] = [];
    stubModel(
      [
        callTool("h1", "read_file", { path: "again" }),
        callTool("h2", "read_file", { path: "again" }), // equivalent repeat of the same failure
        { content: "unreachable" },
      ],
      captured
    );

    const result = await makeHarness().run("Read the again directory", { maxTurns: 8 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Recovery exhausted");
    expect(result.turnsUsed).toBe(2);
    expect(captured.length).toBe(2);
  });

  test("I. a successful recovery continues the task to completion", async () => {
    fs.mkdirSync(path.join(tmpDir, "src2"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src2", "a.ts"), "export {};\n");

    const captured: CapturedTurn[] = [];
    stubModel(
      [
        callTool("i1", "read_file", { path: "src2" }),
        callTool("i2", "list_dir", { path: "src2" }),
        { content: "Directory inspected after recovery — finished." },
      ],
      captured
    );

    const result = await makeHarness().run("Show me what is inside src2", { maxTurns: 8 });
    expect(result.success).toBe(true);
    expect(result.output).toContain("finished");
    expect(result.turnsUsed).toBe(3);
  });

  test("J. a failing recovery is itself bounded (no runaway recovery loop)", async () => {
    fs.mkdirSync(path.join(tmpDir, "deep"), { recursive: true });
    const captured: CapturedTurn[] = [];
    stubModel(
      [
        callTool("j1", "read_file", { path: "deep" }), // NOT_A_FILE → alternate granted
        callTool("j2", "web_fetch", { url: "https://phase5-timeout.example/page" }), // TIMEOUT → recovery granted
        callTool("j3", "web_fetch", { url: "https://phase5-timeout.example/page" }), // repeat → STOP
        callTool("j4", "web_fetch", { url: "https://phase5-timeout.example/page" }),
        { content: "unreachable" },
      ],
      captured,
      { scriptedFetches: true }
    );

    const harness = makeHarness();
    const recoveryEvents: string[] = [];
    harness.on((event) => {
      if (event.payload?.recovery) recoveryEvents.push(String(event.payload.recovery));
    });

    const result = await harness.run("Do a long recovery dance", { maxTurns: 20 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Recovery exhausted");
    expect(result.turnsUsed).toBeLessThanOrEqual(3);
    // Bounded recovery budget: the granted recoveries never exceeded the cap.
    const granted = recoveryEvents.filter((r) => r !== "instruction-delivered");
    expect(granted.length).toBeLessThanOrEqual(RECOVERY_MAX_TOTAL_ATTEMPTS);
  });
});
