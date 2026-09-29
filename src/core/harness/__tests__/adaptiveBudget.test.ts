/**
 * Phase 3 — Adaptive turn budget (bounded adaptive continuation).
 *
 * Replaces "10 turns then die" with: soft budget (resolved exactly as before)
 * + progress-based bounded extensions + no-progress guard + hard safety cap.
 * All constants centralized in core/harness/continuation.ts.
 *
 * Deterministic: the model is a stubbed fetch (same technique as
 * maxTurnsProgress.test.ts), the filesystem is a temp dir, no real provider,
 * no timers.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentHarness } from "../../../lib/harness";
import { setSandboxMode } from "../../../lib/permissions";
import { setModelCapabilities } from "../../../lib/reasoning";
import {
  ADAPTIVE_HARD_CAP,
  ADAPTIVE_EXTENSION_CHUNK,
  decideAdaptiveExtension,
  semanticFailureSignature,
  hardCapError,
  equivalentFailureLoopError,
} from "../../../core/harness/continuation";

const originalFetch = globalThis.fetch;

interface MockResponse {
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

let tmpDir: string;

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-phase3-"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

function stubModel(responses: MockResponse[]) {
  let turn = 0;
  globalThis.fetch = (async (url: string, options?: { body?: string; signal?: AbortSignal }) => {
    if (options?.signal?.aborted) {
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
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

function callTool(id: string, name: string, args: any): MockResponse {
  return {
    content: `Working on ${name} #${id}...`,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function makeHarness(profile = "default"): AgentHarness {
  return new AgentHarness({
    workspaceRoot: tmpDir,
    currentCwd: tmpDir,
    model: "test-model",
    harness: profile,
  });
}

describe("Phase 3 — A/B: meaningful progress earns bounded continuation", () => {
  test("A. 15 meaningful unique turns → completes (soft budget extended)", async () => {
    // 15 turns each doing a DIFFERENT successful read (distinct evidence),
    // then a final synthesis. Soft budget 10 → must extend, not die.
    const responses: MockResponse[] = [];
    for (let i = 1; i <= 15; i++) {
      fs.writeFileSync(path.join(tmpDir, `note-${i}.md`), `content ${i}`);
      responses.push(callTool(`a${i}`, "read_file", { path: `note-${i}.md` }));
    }
    responses.push({ content: "All fifteen steps verified complete." });
    stubModel(responses);

    const result = await makeHarness().run("Do 15 distinct reads then report", { maxTurns: 10 });
    expect(result.success).toBe(true);
    expect(result.turnsUsed).toBe(16); // 15 work turns + 1 synthesis
    expect(result.error).toBeUndefined();
  });

  test("B. 25 progressing turns → bounded continuation under the hard cap", async () => {
    const responses: MockResponse[] = [];
    for (let i = 1; i <= 25; i++) {
      fs.writeFileSync(path.join(tmpDir, `item-${i}.md`), `content ${i}`);
      responses.push(callTool(`b${i}`, "read_file", { path: `item-${i}.md` }));
    }
    responses.push({ content: "Twenty-five progressing steps completed." });
    stubModel(responses);

    const result = await makeHarness().run("Long progressing task", { maxTurns: 10 });
    expect(result.success).toBe(true);
    expect(result.turnsUsed).toBe(26); // 25 work + 1 synthesis
    // Still bounded: far below the hard cap, extensions were granted.
    expect(result.turnsUsed).toBeLessThan(ADAPTIVE_HARD_CAP);
  });

  test("Final synthesis boundary: at the tool-work ceiling the run gets ONE synthesis turn and completes", async () => {
    // 28 distinct reads + 2 verified mutations = 30 distinct successful calls
    // (the ceiling). At the ceiling the boundary denies further extension but
    // the task is effectively complete (verifiedWork ≥ 2) → ONE reserve turn
    // is granted for the final synthesis → the run completes with SUCCESS
    // instead of dying with an error at the cap.
    const responses: MockResponse[] = [];
    for (let i = 1; i <= 28; i++) {
      fs.writeFileSync(path.join(tmpDir, `r-${i}.md`), `content ${i}`);
      responses.push(callTool(`z${i}`, "read_file", { path: `r-${i}.md` }));
    }
    responses.push(callTool("z-w1", "write_file", { path: "out-1.txt", content: "result 1" }));
    responses.push(callTool("z-w2", "write_file", { path: "out-2.txt", content: "result 2" }));
    responses.push({ content: "All 30 steps done — final synthesis of the whole task." });
    stubModel(responses);

    const result = await makeHarness().run("Reach the ceiling then synthesize", { maxTurns: 10 });
    expect(result.success).toBe(true);
    expect(result.turnsUsed).toBe(31); // 30 work turns + 1 reserve synthesis
    expect(result.error).toBeUndefined();
    expect(result.output).toContain("final synthesis");
  });
});

describe("Phase 3 — C/D: no-progress and loop guards stop early", () => {
  test("C. infinite same tool (identical args) → stops early with loop error", async () => {
    const responses: MockResponse[] = [];
    for (let i = 1; i <= 40; i++) {
      responses.push(callTool(`c${i}`, "shell", { command: "echo loop" }));
    }
    stubModel(responses);

    const result = await makeHarness().run("Loop forever", { maxTurns: 10 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Infinite loop detected");
    expect(result.turnsUsed).toBeLessThan(ADAPTIVE_HARD_CAP);
  });

  test("D. equivalent failed command variants → stops (semantic loop guard)", async () => {
    // Each response is a DISTINCT variant of the same failing command
    // (equivalent after semantic normalization). The 3rd DISTINCT variant
    // trips the guard (bound 2 → stop on the 3rd).
    const responses: MockResponse[] = [
      callTool("d1", "shell", { command: "exit 1" }),
      callTool("d2", "shell", { command: "EXIT 1" }), // equivalent variant
      callTool("d3", "shell", { command: "exit 1 " }), // equivalent variant
      { content: "I keep failing." },
    ];
    stubModel(responses);

    const result = await makeHarness().run("Retry the same broken thing", { maxTurns: 10 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("equivalent argument variants");
    expect(result.turnsUsed).toBeLessThan(10); // stopped EARLY
  });
});

describe("Phase 3 — E/F: legitimate cycles allowed, failures do not grant budget", () => {
  test("E. edit/test iterations with changing evidence → allowed", async () => {
    fs.writeFileSync(path.join(tmpDir, "fix.txt"), "v0");
    const responses: MockResponse[] = [];
    for (let i = 1; i <= 12; i++) {
      responses.push(callTool(`e-w${i}`, "write_file", { path: "fix.txt", content: `v${i}` }));
      responses.push(callTool(`e-t${i}`, "shell", { command: `bun test fix-v${i}.test.ts` }));
    }
    responses.push({ content: "Edit/test cycle converged; all tests pass." });
    stubModel(responses);

    const result = await makeHarness().run("Fix and verify iteratively", { maxTurns: 10 });
    expect(result.success).toBe(true);
    // 12 edit/test iterations + synthesis: allowed by adaptive continuation.
    expect(result.turnsUsed).toBe(25);
    expect(result.error).toBeUndefined();
  });

  test("F. failures consume budget but do not grant endless extension", async () => {
    // Every turn is a NEW distinct command that FAILS: failures burn turns.
    // The SAME failing command re-issued as equivalent variants trips the
    // semantic loop guard — failures never extend the budget.
    const responses: MockResponse[] = [];
    const variants = ["exit 1", "exit  1", "EXIT 1", "exit 1 ", "Exit 1", "exit\t1", "EXIT  1", "exit 1", "EXIT 1 ", "exit 1", "Exit  1", "exit 1"];
    for (let i = 0; i < 12; i++) {
      responses.push(callTool(`f${i + 1}`, "shell", { command: variants[i] }));
    }
    stubModel(responses);

    const result = await makeHarness().run("Everything fails", { maxTurns: 10 });
    expect(result.success).toBe(false);
    // Stopped EARLY by the semantic loop guard — long before the budget,
    // and certainly not extended by failures.
    expect(result.turnsUsed).toBeLessThan(10);
    expect(result.error).toContain("equivalent argument variants");
  });
});

describe("Phase 3 — G/H: hard cap and mode semantics", () => {
  test("G. hard cap always terminates (unit-level: every boundary input ends)", () => {
    const cap = ADAPTIVE_HARD_CAP;
    // At the cap, NO snapshot — not even a maximally progressing one —
    // can earn an extension.
    for (const snapshot of [
      { distinctSuccessfulToolSigs: 0, verifiedMutations: 0, testsPassed: 0, verificationsPassed: 0, failedToolCalls: 0 },
      { distinctSuccessfulToolSigs: 999, verifiedMutations: 50, testsPassed: 50, verificationsPassed: 50, failedToolCalls: 0 },
    ]) {
      const decision = decideAdaptiveExtension({ turnsUsed: cap, softBudget: 10, snapshot });
      expect(decision.extended).toBe(false);
      expect(decision.stopKind).toBe("hard-cap");
      expect(decision.budget).toBe(10);
      expect(decision.reason).toContain("Hard safety cap");
    }
    expect(hardCapError(cap)).toContain(String(cap));
    // Extensions are bounded by the cap even far above the soft budget.
    const growing = decideAdaptiveExtension({
      turnsUsed: 10,
      softBudget: cap - 1, // one turn below the cap
      snapshot: { distinctSuccessfulToolSigs: 1, verifiedMutations: 0, testsPassed: 0, verificationsPassed: 0, failedToolCalls: 0 },
    });
    expect(growing.extended).toBe(true);
    expect(growing.budget).toBe(Math.min(cap - 1 + ADAPTIVE_EXTENSION_CHUNK, cap));
  });

  test("H. turbo / subagent semantics preserved (caller budget is the soft budget)", async () => {
    // TURBO keeps its 5-turn budget shape; 3 distinct successful calls then a
    // synthesis completes inside it without any extension being needed.
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "README.md"), "x");
    fs.writeFileSync(path.join(tmpDir, "docs-x.md"), "y");
    const responses: MockResponse[] = [
      callTool("h1", "read_file", { path: "package.json" }),
      callTool("h2", "read_file", { path: "README.md" }),
      callTool("h3", "read_file", { path: "docs-x.md" }),
      { content: "Turbo run done." },
    ];
    stubModel(responses);
    const result = await makeHarness().runTurbo("quick task");
    expect(result.success).toBe(true);
    expect(result.mode).toBe("TURBO");
    expect(result.turnsUsed).toBe(4); // 3 calls + synthesis, under TURBO's 5
  });

  test("H. subagent budget shape intact (8-turn soft budget respected)", async () => {
    const responses: MockResponse[] = [
      callTool("s1", "read_file", { path: "a.md" }),
      { content: "Subagent answer." },
    ];
    stubModel(responses);
    const result = await makeHarness().runSubagent("researcher" as any, "child task");
    expect(result.success).toBe(true);
    expect(result.mode).toBe("SUBAGENT");
    expect(result.turnsUsed).toBeLessThanOrEqual(8);
  });

  test("H. adaptiveContinuation: false → exact legacy hard stop", async () => {
    const responses: MockResponse[] = [];
    for (let i = 1; i <= 12; i++) {
      fs.writeFileSync(path.join(tmpDir, `f-${i}.md`), `content ${i}`);
      responses.push(callTool(`o${i}`, "read_file", { path: `f-${i}.md` }));
    }
    stubModel(responses);
    const result = await makeHarness().run("legacy", { maxTurns: 10, adaptiveContinuation: false });
    expect(result.success).toBe(false);
    expect(result.turnsUsed).toBe(10);
    expect(result.error).toContain("Exceeded maximum turn count (10)");
  });
});

describe("Phase 3 — terminal errors distinguish the stop reason", () => {
  test("user-visible error names hard cap / no-progress / repeated loop distinctly", () => {
    // The three terminal errors are mutually distinguishable strings.
    const cap = hardCapError(ADAPTIVE_HARD_CAP);
    const loop = equivalentFailureLoopError(3);
    const noProgress = "No meaningful progress: 3 failed execution(s) outweigh 0 verified result(s).";
    expect(cap).toContain("Hard safety cap");
    expect(loop).toContain("No-progress loop detected");
    expect(noProgress).toContain("No meaningful progress");
    expect(new Set([cap, loop, noProgress]).size).toBe(3);
    // None of them is the generic max-turns message.
    for (const msg of [cap, loop, noProgress]) {
      expect(msg).not.toContain("Exceeded maximum turn count");
    }
    // Semantic signature: whitespace/case/digit-normalized equivalence.
    expect(semanticFailureSignature("shell", { command: "bun --version" })).toBe(
      semanticFailureSignature("shell", { command: "BUN  --VERSION " })
    );
    expect(semanticFailureSignature("shell", { command: "bun test" })).not.toBe(
      semanticFailureSignature("shell", { command: "bun --version" })
    );
  });
});
