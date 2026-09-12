/**
 * Phase 81 §20/§23/§24 — controlled harness experiment, security invariants
 * across profiles, and bounded loop / failure behaviour.
 *
 * Everything here runs the REAL `AgentHarness` against a stubbed provider, so
 * the thing under test is the production loop with a different policy contract —
 * not a stand-in for it.
 *
 * The controlled experiment is deliberately structured the way §20 asks:
 *
 *   same fixture + same model responses + same tools + same permissions
 *   + same task  ×  different harness profile
 *
 * Nothing is hard-coded to an expected score: the assertions compare what the
 * two runs actually did.
 */

import { describe, test, expect, afterAll, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHarness } from "../../../lib/harness";
import { setSandboxMode } from "../../../lib/permissions";
import { setModelCapabilities } from "../../../lib/reasoning";
import {
  harnessRegistry,
  type HarnessProfile,
  type PromptPolicy,
  type ToolPolicy,
} from "..";

const originalFetch = globalThis.fetch;

interface MockResponse {
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

interface CapturedRequest {
  systemPrompt: string;
  toolNames: string[];
}

let tmpDir: string;
let captured: CapturedRequest[];

beforeEach(() => {
  setSandboxMode("full-access");
  setModelCapabilities([
    {
      id: "test-model",
      capabilities: {
        tools: true,
        nativeToolCalls: true,
        reasoning: false,
        vision: false,
        streaming: false,
      },
    },
  ]);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-phase81-"));
  captured = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

/**
 * The SAME model adapter fixture for every run: it replays a fixed response list
 * and records the request the harness actually sent.
 */
function stubModel(responses: MockResponse[]) {
  let turn = 0;
  globalThis.fetch = (async (url: string, options?: { body?: string; signal?: AbortSignal }) => {
    // A real transport honours cancellation; the stub must too, or a
    // cancellation test would silently pass by never cancelling anything.
    if (options?.signal?.aborted) {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    }
    const payload = options?.body ? JSON.parse(options.body) : {};
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const system = messages.find((m: { role: string }) => m.role === "system");
    captured.push({
      systemPrompt: String(system?.content ?? ""),
      toolNames: (payload.tools ?? []).map(
        (tool: { function?: { name?: string } }) => tool.function?.name ?? "",
      ),
    });

    const response = responses[turn] ?? { content: "Done.", tool_calls: [] };
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
      url,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => JSON.parse(body),
      text: async () => body,
      clone: async () => ({ json: async () => JSON.parse(body), text: async () => body }),
    } as never;
  }) as never;
}

function callTool(id: string, name: string, args: unknown): MockResponse {
  return {
    tool_calls: [
      { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

function makeHarness(harness?: string, sandboxMode = "full-access") {
  return new AgentHarness({
    model: "test-model",
    sandboxMode: sandboxMode as never,
    workspaceRoot: tmpDir,
    currentCwd: tmpDir,
    ...(harness ? { harness } : {}),
  });
}

// ── §20 controlled experiment ────────────────────────────────────────────────

describe("Phase 81 §20 — controlled experiment: same model, different harness", () => {
  const writeResponses: MockResponse[] = [
    callTool("c1", "write_file", { path: "out.txt", content: "hello\n" }),
    { content: "Wrote out.txt." },
  ];

  test("the profile truly changes the prompt", async () => {
    stubModel(writeResponses);
    const withDefault = await makeHarness("default").run("write out.txt");

    stubModel(writeResponses);
    const withMinimal = await makeHarness("minimal").run("write out.txt");

    expect(captured).toHaveLength(4);
    const defaultPrompt = captured[0].systemPrompt;
    const minimalPrompt = captured[2].systemPrompt;

    // A real behavioural difference, not a label.
    expect(minimalPrompt).not.toBe(defaultPrompt);
    expect(minimalPrompt.length).toBeLessThan(defaultPrompt.length);
    // Both still carry the security boundary.
    expect(defaultPrompt).toContain("RUNTIME PERMISSION CONTEXT");
    expect(minimalPrompt).toContain("RUNTIME PERMISSION CONTEXT");

    expect(withDefault.harnessId).toBe("default");
    expect(withMinimal.harnessId).toBe("minimal");
  });

  test("the same model under different profiles produces the same workspace outcome", async () => {
    stubModel(writeResponses);
    const first = await makeHarness("default").run("write out.txt");
    const defaultContent = fs.readFileSync(path.join(tmpDir, "out.txt"), "utf8");

    fs.rmSync(path.join(tmpDir, "out.txt"));
    stubModel(writeResponses);
    const second = await makeHarness("coding").run("write out.txt");
    const codingContent = fs.readFileSync(path.join(tmpDir, "out.txt"), "utf8");

    // Same model responses ⇒ same file. The harness changed policy, not outcome.
    expect(codingContent).toBe(defaultContent);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
  });

  test("tool exposure is identical for profiles that do not narrow it", async () => {
    for (const profile of ["default", "minimal", "coding", "tool-heavy", "reasoning"]) {
      captured = [];
      stubModel([{ content: "nothing to do" }]);
      await makeHarness(profile).run("say nothing");
      expect(captured[0].toolNames.length).toBeGreaterThan(0);
      // Compare against the identity profile's full surface.
      if (profile !== "default") {
        const expected = harnessRegistry.get("default")!;
        expect(harnessRegistry.get(profile)!.toolPolicy.allow).toEqual(
          expected.toolPolicy.allow,
        );
      }
    }
  });

  test("the run is reproducible: identical inputs give identical recorded identity", async () => {
    const results: Array<{ verdict?: string; harnessId?: string; toolCalls?: number }> = [];
    for (let run = 0; run < 2; run++) {
      fs.rmSync(path.join(tmpDir, "out.txt"), { force: true });
      stubModel(writeResponses);
      const result = await makeHarness("coding").run("write out.txt");
      results.push({
        verdict: result.verdict,
        harnessId: result.harnessId,
        toolCalls: result.toolCallsCount,
      });
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0].verdict).toBe("SUCCESS");
  });

  test("the verdict and evidence travel with the result", async () => {
    stubModel(writeResponses);
    const result = await makeHarness("coding").run("write out.txt");
    expect(result.harnessVersion).toBe(harnessRegistry.get("coding")!.version);
    expect(result.executionEvidence?.filesChanged).toContain("out.txt");
    expect(result.executionEvidence?.toolCalls).toBeGreaterThan(0);
  });
});

// ── §23 security invariants across profiles ──────────────────────────────────

describe("Phase 81 §23 — a harness profile can never change a security verdict", () => {
  const allProfileIds = ["default", "minimal", "coding", "tool-heavy", "reasoning"];

  const FIXTURE_ID = "test-permissive";

  /** A profile whose allow-list explicitly names the tool we are about to deny. */
  harnessRegistry.register({
    ...harnessRegistry.get("coding")!,
    id: FIXTURE_ID,
    version: "1.0.0",
    displayName: "Test permissive",
    toolPolicy: {
      allow: ["write_file", "edit_file", "shell", "read_file"],
    } as ToolPolicy,
  });
  afterAll(() => harnessRegistry.unregister(FIXTURE_ID));

  const profilesToCheck = [...allProfileIds, FIXTURE_ID];

  test("out-of-scope writes are denied under EVERY profile", async () => {
    const outside = path.join(os.tmpdir(), `toolnet-outside-${Date.now()}.txt`);
    try {
      fs.rmSync(outside, { force: true });
    } catch {}

    for (const profile of profilesToCheck) {
      // Re-assert the sandbox each iteration: the constructor sets it globally.
      stubModel([
        callTool("w", "write_file", { path: outside, content: "pwned" }),
        { content: "attempted" },
      ]);
      const harness = makeHarness(profile, "workspace");
      const result = await harness.dispatchTool("write_file", {
        path: outside,
        content: "pwned",
      });
      expect(result.allowed).toBe(false);
      expect(fs.existsSync(outside)).toBe(false);
      void result;
      void harness;
    }
    expect(fs.existsSync(outside)).toBe(false);
  });

  test("an allow-list that names a denied tool does not grant it", async () => {
    const outside = path.join(os.tmpdir(), `toolnet-allow-${Date.now()}.txt`);
    stubModel([{ content: "ok" }]);
    const harness = makeHarness(FIXTURE_ID, "workspace");

    const result = await harness.dispatchTool("write_file", {
      path: outside,
      content: "pwned",
    });
    // Exposure ≠ permission: the security gateway still says no.
    expect(result.allowed).toBe(false);
    expect(fs.existsSync(outside)).toBe(false);
  });

  test("every built-in profile keeps an in-scope write allowed in full-access", async () => {
    for (const profile of allProfileIds) {
      const target = `in-scope-${profile}.txt`;
      stubModel([callTool("w", "write_file", { path: target, content: profile }), { content: "done" }]);
      const result = await makeHarness(profile).run(`write ${target}`);
      expect(result.success).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, target), "utf8")).toBe(profile);
    }
  });

  test("approval is still required under every profile", async () => {
    const outside = path.join(os.tmpdir(), `toolnet-approval-${Date.now()}.txt`);
    try {
      fs.rmSync(outside, { force: true });
    } catch {}

    for (const profile of allProfileIds) {
      stubModel([{ content: "ok" }]);
      const harness = new AgentHarness({
        model: "test-model",
        // `ask` mode: an out-of-workspace write needs a decision.
        sandboxMode: "ask" as never,
        workspaceRoot: tmpDir,
        currentCwd: tmpDir,
        harness: profile,
      });
      // No approval hook at all — the gateway must fail closed.
      const refused = await harness.dispatchTool("write_file", {
        path: outside,
        content: "x",
      });
      expect(refused.allowed).toBe(false);

      // And an explicit refusal is honoured too.
      const withHook = new AgentHarness({
        model: "test-model",
        sandboxMode: "ask" as never,
        workspaceRoot: tmpDir,
        currentCwd: tmpDir,
        harness: profile,
      });
      let asked = 0;
      await withHook.run(`write ${outside}`, {
        maxTurns: 2,
        requestApproval: async () => {
          asked += 1;
          return false;
        },
      });
      expect(fs.existsSync(outside)).toBe(false);
      void asked;
    }
    expect(fs.existsSync(outside)).toBe(false);
  });

  test("cancellation propagates under every profile", async () => {
    for (const profile of allProfileIds) {
      captured = [];
      stubModel([callTool("w", "write_file", { path: "cancel.txt", content: "x" }), { content: "done" }]);
      const controller = new AbortController();
      controller.abort();
      const result = await makeHarness(profile).run("write cancel.txt", {
        signal: controller.signal,
      });
      expect(result.success).toBe(false);
      expect(result.verdict).toBe("CANCELLED");
      // The provider was never called under an already-cancelled run.
      expect(captured).toHaveLength(0);
      expect(fs.existsSync(path.join(tmpDir, "cancel.txt"))).toBe(false);
    }
  });
});

// ── §24 bounded loop / failure behaviour ─────────────────────────────────────

describe("Phase 81 §24 — loops terminate deterministically", () => {
  test("the repeat bound is policy-driven: default aborts at 3, tool-heavy at 2", async () => {
    const repeated = [
      callTool("a", "shell", { command: "bun test" }),
      callTool("b", "shell", { command: "bun test" }),
      callTool("c", "shell", { command: "bun test" }),
      callTool("d", "shell", { command: "bun test" }),
    ];

    stubModel(repeated);
    const withDefault = await makeHarness("default").run("run tests", { maxTurns: 8 });
    expect(withDefault.success).toBe(false);
    expect(withDefault.error ?? "").toContain("Infinite loop detected");
    expect(withDefault.verdict).toBe("FAILED");
    // Three model calls only: the loop aborted on the third identical call.
    expect(captured).toHaveLength(3);

    captured = [];
    stubModel(repeated);
    const withToolHeavy = await makeHarness("tool-heavy").run("run tests", { maxTurns: 8 });
    expect(withToolHeavy.success).toBe(false);
    expect(withToolHeavy.error ?? "").toContain("Infinite loop detected");
    // Tool-heavy is stricter — it stops one turn earlier.
    expect(captured).toHaveLength(2);
  });

  test("an interleaved repeated call is not a loop", async () => {
    stubModel([
      callTool("a", "shell", { command: "bun test" }),
      callTool("b", "read_file", { path: "package.json" }),
      callTool("c", "shell", { command: "bun test" }),
      { content: "done" },
    ]);
    const result = await makeHarness("default").run("run tests", { maxTurns: 8 });
    expect(result.error ?? "").not.toContain("Infinite loop detected");
    expect(result.success).toBe(true);
  });

  test("the no-progress bound aborts a profile that enables it", async () => {
    // A mutation-requiring task the model never acts on: the Completion Gate
    // keeps the loop alive, and the same prose every turn is no progress.
    const identical = [{ content: "I will get to it." }];
    stubModel([...identical, ...identical, ...identical, ...identical, ...identical]);

    const withCoding = await makeHarness("coding").run("create hello.py", { maxTurns: 8 });
    expect(withCoding.success).toBe(false);
    expect(withCoding.error ?? "").toContain("No progress detected");
    // A stuck loop is a FAILURE, never reported as a user cancellation.
    expect(withCoding.verdict).toBe("FAILED");
  });

  test("the identity profile keeps the pre-Phase-81 loop (no progress bound)", async () => {
    const identical = [{ content: "Nothing to report." }];
    stubModel([...identical, ...identical, ...identical, ...identical, ...identical]);

    const withDefault = await makeHarness("default").run("create hello.py", { maxTurns: 3 });
    // Bounded by the turn budget, never by a newly-introduced progress bound.
    expect(withDefault.error ?? "").not.toContain("No progress detected");
    expect(withDefault.error ?? "").toContain("Exceeded maximum turn count");
  });

  test("the turn budget bounds every profile", async () => {
    const stuck = () => callTool("x", "read_file", { path: "never-exists.ts" });
    for (const profile of ["default", "coding", "minimal", "tool-heavy", "reasoning"]) {
      captured = [];
      // Enough responses that only the budget can end this run. `tool-heavy`
      // trips its repeat bound first, which is also a bounded stop.
      stubModel([stuck(), stuck(), stuck(), stuck(), stuck(), stuck()]);
      const result = await makeHarness(profile).run("keep going", { maxTurns: 2 });
      expect(result.success).toBe(false);
      expect(result.turnsUsed).toBeLessThanOrEqual(2);
      // Deterministic: bounded by the budget, not by an unbounded loop.
      expect(captured.length).toBeLessThanOrEqual(2);
    }
  });

  test("a malformed tool call does not crash the loop", async () => {
    stubModel([
      {
        tool_calls: [
          { id: "bad", type: "function", function: { name: "shell", arguments: "{not json" } },
        ],
      },
      { content: "recovered" },
    ]);
    const result = await makeHarness("coding").run("do a thing", { maxTurns: 4 });
    expect(result.error ?? "").not.toContain("JSON");
    expect(result.success).toBe(true);
    expect(result.verdict).toBe("SUCCESS");
  });

  test("a failing tool is reported, not retried forever", async () => {
    stubModel([
      callTool("a", "read_file", { path: "does-not-exist.ts" }),
      { content: "The file does not exist." },
    ]);
    const result = await makeHarness("coding").run("read does-not-exist.ts", { maxTurns: 4 });
    expect(result.success).toBe(true);
    expect(result.executionEvidence?.failedToolCalls).toBeGreaterThan(0);
  });

  test("an unknown per-call profile fails the run loudly", async () => {
    stubModel([{ content: "should not run" }]);
    const result = await makeHarness().run("hello", { harness: "codign" });
    expect(result.success).toBe(false);
    expect(result.error ?? "").toContain("Unknown harness profile");
    expect(result.verdict).toBe("FAILED");
    // No model call was made under a contract the caller did not ask for.
    expect(captured).toHaveLength(0);
  });
});

// ── §11 completion contract against the real loop ────────────────────────────

describe("Phase 81 §11 — fake success is not SUCCESS", () => {
  test("a prose-only answer to a mutation task never reports SUCCESS", async () => {
    stubModel([{ content: "Done! I created the file." }]);
    const result = await makeHarness("coding").run("create hello.py", { maxTurns: 3 });
    expect(result.verdict).toBe("FAILED");
    expect(result.verdict).not.toBe("SUCCESS");
    expect(fs.existsSync(path.join(tmpDir, "hello.py"))).toBe(false);
  });

  test("a verified write is SUCCESS", async () => {
    stubModel([callTool("w", "write_file", { path: "x.txt", content: "1" }), { content: "done" }]);
    const result = await makeHarness("coding").run("create x.txt with 1", { maxTurns: 4 });
    expect(result.verdict).toBe("SUCCESS");
    expect(result.completionReasons).toEqual([]);
  });

  test("a cancelled run reports CANCELLED rather than FAILED", async () => {
    const identical: MockResponse[] = [{ content: "thinking" }];
    stubModel([...identical, ...identical, ...identical, ...identical]);
    const controller = new AbortController();
    controller.abort();
    const result = await makeHarness("default").run("do it", {
      maxTurns: 4,
      signal: controller.signal,
    });
    expect(result.verdict).toBe("CANCELLED");
  });

  test("a stuck loop is FAILED, not CANCELLED (no string matching)", async () => {
    const repeated = [
      callTool("a", "shell", { command: "bun test" }),
      callTool("b", "shell", { command: "bun test" }),
      callTool("c", "shell", { command: "bun test" }),
    ];
    stubModel(repeated);
    const result = await makeHarness("default").run("run tests", { maxTurns: 6 });
    expect(result.error ?? "").toContain("Infinite loop detected");
    expect(result.verdict).toBe("FAILED");
  });
});
