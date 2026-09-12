import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { providerRegistry } from "../../models/registry";
import { formatModelRef } from "../../models/ref";
import { EvalRunner } from "../runner";
import { EvalStore } from "../store";
import { codingSuite, toolSuite, textSuite } from "../suites";
import type { EvalCase, EvalCaseResult } from "../types";
import { createFakeOpenAiServer, scripts, type FakeOpenAiServer } from "./helpers/fakeOpenAiServer";

const PROVIDER = "phase80eval";
const MODEL_ID = "eval-model";
const MODEL_REF = formatModelRef(PROVIDER, MODEL_ID);

let server: FakeOpenAiServer;
let storeDir: string;
let store: EvalStore;
let runner: EvalRunner;

function caseById(suite: typeof codingSuite, id: string): EvalCase {
  const entry = suite.cases.find((item) => item.id === id);
  if (!entry) throw new Error(`missing eval case ${id}`);
  return entry;
}

async function runCase(entry: EvalCase): Promise<EvalCaseResult> {
  return runner.runCase(entry, { model: MODEL_REF, runId: "test" });
}

function freshStore(): void {
  if (storeDir) {
    try {
      fs.rmSync(storeDir, { recursive: true, force: true });
    } catch {}
  }
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase80-eval-store-"));
  store = new EvalStore({ dir: storeDir });
  runner = new EvalRunner({ store, workspacesRoot: os.tmpdir() });
}

beforeAll(() => {
  freshStore();
  server = createFakeOpenAiServer({
    models: [MODEL_ID],
    script: scripts.alwaysText("ok"),
  });

  providerRegistry.register(
    {
      id: PROVIDER,
      name: "Phase 80 Eval Fixture",
      kind: "openai-compatible",
      baseURL: server.url,
      authentication: { apiKeyEnv: "PHASE80_EVAL_KEY", scheme: "bearer", hasApiKey: false },
      models: [
        {
          id: MODEL_REF,
          providerId: PROVIDER,
          apiModelId: MODEL_ID,
          displayName: "Eval Model",
          contextWindow: 200_000,
          capabilities: { tools: true, nativeToolCalls: true, reasoning: true, streaming: true },
          status: "active",
        },
      ],
    },
    { replace: true },
  );
});

afterAll(() => {
  providerRegistry.unregister(PROVIDER);
  server.close();
});

afterEach(() => {
  freshStore();
});

// Fixtures must resolve from the repo source tree.
const FIXTURES = path.join(process.cwd(), "src", "core", "eval", "fixtures");

function newServer(script: (turn: number, body: any) => any): FakeOpenAiServer {
  const created = createFakeOpenAiServer({ models: [MODEL_ID], script });
  providerRegistry.register(
    {
      id: PROVIDER,
      name: "Phase 80 Eval Fixture",
      kind: "openai-compatible",
      baseURL: created.url,
      authentication: { apiKeyEnv: "PHASE80_EVAL_KEY", scheme: "bearer", hasApiKey: false },
      models: [
        {
          id: MODEL_REF,
          providerId: PROVIDER,
          apiModelId: MODEL_ID,
          contextWindow: 200_000,
          capabilities: { tools: true, nativeToolCalls: true, reasoning: true },
          status: "active",
        },
      ],
    },
    { replace: true },
  );
  return created;
}

describe("Phase 80 — EvalRunner on the production path", () => {
  it("records a run with real provider/model identity, usage and metrics", async () => {
    const local = newServer(scripts.alwaysText("pong"));
    try {
      const scoped = new EvalRunner({ store, fixturesDir: FIXTURES, workspacesRoot: os.tmpdir() });
      const record = await scoped.runSuite(textSuite, MODEL_REF);

      expect(record.provider).toBe(PROVIDER);
      expect(record.model).toBe(MODEL_ID);
      expect(record.cases.length).toBe(textSuite.cases.length);
      expect(record.metrics.byType.TEXT.total).toBe(textSuite.cases.length);
      // Usage is captured from the real `model.after` hook edge.
      expect(record.cases[0].inputTokens).toBeGreaterThan(0);
      expect(record.cases[0].outputTokens).toBeGreaterThan(0);

      // Persisted, and readable back.
      expect(store.get(record.runId)?.runId).toBe(record.runId);
    } finally {
      local.close();
    }
  });

  it("fixes a TypeScript bug through a real tool call and a real test run", async () => {
    const fixed = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
    const local = newServer(scripts.writeFile("src/sum.ts", fixed, "Fixed add()."));
    try {
      const scoped = new EvalRunner({ store, fixturesDir: FIXTURES, workspacesRoot: os.tmpdir() });
      const result = await scoped.runCase(caseById(codingSuite, "code-fix-bug"), {
        model: MODEL_REF,
        runId: "test",
      });

      expect(result.pass).toBe(true);
      expect(result.toolCalls).toBeGreaterThanOrEqual(1);
      expect(result.failedToolCalls).toBe(0);
      // The real post-command (`bun test`) exited 0 on the mutated workspace.
      expect(result.detail).toContain("verified on disk");
    } finally {
      local.close();
    }
  });

  it("selects the read tool and answers from the file contents", async () => {
    const local = newServer(scripts.readFileAndAnswer("NOTES.md", "The codeword is banana-42."));
    try {
      const scoped = new EvalRunner({ store, fixturesDir: FIXTURES, workspacesRoot: os.tmpdir() });
      const result = await scoped.runCase(caseById(toolSuite, "tool-select-read"), {
        model: MODEL_REF,
        runId: "test",
      });
      expect(result.pass).toBe(true);
      expect(result.toolCalls).toBeGreaterThanOrEqual(1);
    } finally {
      local.close();
    }
  });

  it("fails a narrating model that never calls a tool (no fabricated success)", async () => {
    const local = newServer(scripts.narrateOnly());
    try {
      const scoped = new EvalRunner({ store, fixturesDir: FIXTURES, workspacesRoot: os.tmpdir() });
      const result = await scoped.runCase(caseById(toolSuite, "tool-no-narration"), {
        model: MODEL_REF,
        runId: "test",
      });

      expect(result.pass).toBe(false);
      expect(result.toolCalls).toBe(0);
      expect(result.failureClass).toBe("MODEL_COMPLIANCE");
    } finally {
      local.close();
    }
  });

  it("blocks a write outside the sandbox and verifies the file was never created", async () => {
    const local = newServer(
      (turn) =>
        turn === 0
          ? {
              toolCalls: [
                {
                  id: "call_outside",
                  name: "write_file",
                  arguments: { path: "../toolnet-eval-denied-target.txt", content: "pwned" },
                },
              ],
            }
          : { content: "done" },
    );
    try {
      const scoped = new EvalRunner({ store, fixturesDir: FIXTURES, workspacesRoot: os.tmpdir() });
      const result = await scoped.runCase(caseById(codingSuite, "code-permission-denied"), {
        model: MODEL_REF,
        runId: "test",
      });
      expect(result.pass).toBe(true);
      expect(result.detail).toContain("absent as expected");
    } finally {
      local.close();
    }
  });

  it("stops execution when cancelled", async () => {
    const local = newServer(scripts.slowText("working…", 5_000));
    try {
      const scoped = new EvalRunner({ store, fixturesDir: FIXTURES, workspacesRoot: os.tmpdir() });
      const result = await scoped.runCase(caseById(codingSuite, "code-cancellation"), {
        model: MODEL_REF,
        runId: "test",
      });
      expect(result.pass).toBe(true);
      expect(result.detail).toContain("cancelled=true");
    } finally {
      local.close();
    }
  });

  it("survives a malformed task without a runtime error", async () => {
    const local = newServer(scripts.alwaysText("Nothing to do."));
    try {
      const scoped = new EvalRunner({ store, fixturesDir: FIXTURES, workspacesRoot: os.tmpdir() });
      const result = await scoped.runCase(caseById(codingSuite, "code-malformed-task"), {
        model: MODEL_REF,
        runId: "test",
      });
      expect(result.pass).toBe(true);
    } finally {
      local.close();
    }
  });

  it("classifies a terminal provider rejection as PROVIDER_PROTOCOL, not a model-quality failure", async () => {
    // 4xx is used rather than 5xx because the provider retries 5xx with
    // exponential backoff; retry classification itself is covered by the
    // Phase 79 fallback suite.
    const local = createFakeOpenAiServer({ models: [MODEL_ID], script: scripts.alwaysText("ignored"), failWithStatus: 400 });
    providerRegistry.register(
      {
        id: PROVIDER,
        kind: "openai-compatible",
        baseURL: local.url,
        models: [
          {
            id: MODEL_REF,
            providerId: PROVIDER,
            apiModelId: MODEL_ID,
            capabilities: { tools: true, nativeToolCalls: true },
            status: "active",
          },
        ],
      },
      { replace: true },
    );

    try {
      const scoped = new EvalRunner({ store, fixturesDir: FIXTURES, workspacesRoot: os.tmpdir() });
      const result = await scoped.runCase(caseById(codingSuite, "code-fix-bug"), {
        model: MODEL_REF,
        runId: "test",
      });
      expect(result.pass).toBe(false);
      expect(result.failureClass).toBe("PROVIDER_PROTOCOL");
    } finally {
      local.close();
    }
  });

  it("classifies retryable 5xx and timeouts as PROVIDER_PROTOCOL, not model quality", async () => {
    const { classifyFailure } = await import("../runner");
    const entry = caseById(codingSuite, "code-fix-bug");
    const base = {
      output: "",
      toolCalls: [],
      workspaceRoot: os.tmpdir(),
      filesRead: [],
      filesWritten: [],
      exitCodes: [],
      postCommandOutput: [],
      cancelled: false,
      durationMs: 0,
    };

    expect(classifyFailure(entry, { ...base, runtimeError: "Gateway network error: HTTP 503 Service Unavailable" })).toBe(
      "PROVIDER_PROTOCOL",
    );
    expect(classifyFailure(entry, { ...base, runtimeError: "execution timeout after 30000ms" })).toBe("TIMEOUT");
    expect(classifyFailure(entry, { ...base, runtimeError: "Permission Denied: blocked by sandbox" })).toBe("PERMISSION");
    // A thrown exception is a genuine runtime crash…
    expect(classifyFailure(entry, { ...base, threw: true, runtimeError: "agent crashed unexpectedly" })).toBe(
      "CORE_RUNTIME",
    );
    // …whereas a tool-required case with no tool calls is model non-compliance.
    expect(classifyFailure(entry, { ...base, runtimeError: "completion gate: no mutation" })).toBe("MODEL_COMPLIANCE");
  });
});

describe("Phase 80 — runner internals", () => {
  it("counts duplicate tool calls", async () => {
    const { countDuplicateToolCalls } = await import("../runner");
    expect(
      countDuplicateToolCalls([
        { id: "1", name: "read_file", arguments: { path: "a" }, ok: true },
        { id: "2", name: "read_file", arguments: { path: "a" }, ok: true },
        { id: "3", name: "read_file", arguments: { path: "b" }, ok: true },
      ]),
    ).toBe(1);
  });

  it("builds metrics that separate passed and failed cases", async () => {
    const { buildMetrics } = await import("../runner");
    const metrics = buildMetrics([
      {
        caseId: "a",
        name: "A",
        type: "TEXT",
        pass: true,
        score: 1,
        detail: "",
        durationMs: 10,
        inputTokens: 5,
        outputTokens: 5,
        toolCalls: 1,
        failedToolCalls: 0,
        duplicateToolCalls: 0,
        retries: 0,
      },
      {
        caseId: "b",
        name: "B",
        type: "TOOL",
        pass: false,
        score: 0,
        detail: "",
        durationMs: 30,
        inputTokens: 5,
        outputTokens: 5,
        toolCalls: 2,
        failedToolCalls: 1,
        duplicateToolCalls: 0,
        retries: 0,
        failureClass: "TOOL_FAILURE",
      },
    ]);

    expect(metrics.passRate).toBe(0.5);
    expect(metrics.meanDurationMs).toBe(20);
    expect(metrics.totalToolCalls).toBe(3);
    expect(metrics.totalFailedToolCalls).toBe(1);
    expect(metrics.byType.TEXT).toEqual({ passed: 1, total: 1 });
    expect(metrics.byType.TOOL).toEqual({ passed: 0, total: 1 });
  });
});
