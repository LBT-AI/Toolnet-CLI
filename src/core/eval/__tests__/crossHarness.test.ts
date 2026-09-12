/**
 * Phase 81 §13/§14/§15 — harness-aware eval.
 *
 * The runner is NOT forked: the same `EvalRunner` takes a harness profile and
 * records it, so "which policy produced this result?" is answerable from stored
 * runs. The upstream model is scripted by a REAL local HTTP server, so the
 * harness, router, adapter and registry all run their production paths.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { providerRegistry } from "../../models/registry";
import { formatModelRef } from "../../models/ref";
import { EvalRunner, harnessVersionOf, resolveHarnessId } from "../runner";
import { EvalStore } from "../store";
import { codingSuite, type EvalSuite } from "../index";
import { createFakeOpenAiServer, scripts, type FakeOpenAiServer } from "./helpers/fakeOpenAiServer";

const PROVIDER = "phase81cross";
const MODEL_ID = "cross-model";
const MODEL_REF = formatModelRef(PROVIDER, MODEL_ID);

let server: FakeOpenAiServer;
let storeDir: string;
let store: EvalStore;

function freshStore(): void {
  if (storeDir) {
    try {
      fs.rmSync(storeDir, { recursive: true, force: true });
    } catch {}
  }
  storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase81-eval-store-"));
  store = new EvalStore({ dir: storeDir });
}

/** One tiny suite: a verified write, so the case passes under any profile. */
const miniSuite: EvalSuite = {
  id: "mini",
  version: "1.0.0",
  name: "Mini",
  description: "Minimal harness comparison suite",
  cases: [
    {
      id: "write",
      name: "write a file",
      type: "CODE",
      prompt: "create result.txt with hello",
      grader: { kind: "file-mutation", path: "result.txt", expectExists: true },
    },
  ],
};

beforeAll(() => {
  freshStore();
  server = createFakeOpenAiServer({
    models: [MODEL_ID],
    script: scripts.writeFile("result.txt", "hello\n"),
  });

  providerRegistry.register(
    {
      id: PROVIDER,
      name: "Phase 81 Cross-Harness Fixture",
      kind: "openai-compatible",
      baseURL: server.url,
      authentication: { apiKeyEnv: "PHASE81_CROSS_KEY", scheme: "bearer", hasApiKey: false },
      models: [
        {
          id: MODEL_REF,
          providerId: PROVIDER,
          apiModelId: MODEL_ID,
          displayName: "Cross Model",
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
  try {
    server?.close();
  } catch {}
  try {
    fs.rmSync(storeDir, { recursive: true, force: true });
  } catch {}
});

afterEach(() => {
  try {
    fs.rmSync(storeDir, { recursive: true, force: true });
  } catch {}
  fs.mkdirSync(storeDir, { recursive: true });
});

describe("Phase 81 §13 — harness identity on eval records", () => {
  it("resolveHarnessId defaults to the identity profile", () => {
    expect(resolveHarnessId(undefined)).toBe("default");
    expect(resolveHarnessId("  ")).toBe("default");
    expect(resolveHarnessId("Coding")).toBe("coding");
  });

  it("harnessVersionOf reads the canonical registry", () => {
    expect(harnessVersionOf("coding")).not.toBe("unknown");
    expect(harnessVersionOf("ghost-profile")).toBe("unknown");
  });

  it("a run records the harness id and version", async () => {
    const runner = new EvalRunner({ store, workspacesRoot: os.tmpdir() });
    const record = await runner.runSuite(miniSuite, MODEL_REF, { harness: "coding" });

    expect(record.harnessId).toBe("coding");
    expect(record.harnessVersion).toBe(harnessVersionOf("coding"));
    expect(record.model).toBe(MODEL_ID);
    expect(record.cases[0].harnessId).toBe("coding");
    expect(record.cases[0].pass).toBe(true);
  });

  it("defaults to the identity profile when no harness is given", async () => {
    const runner = new EvalRunner({ store, workspacesRoot: os.tmpdir() });
    const record = await runner.runSuite(miniSuite, MODEL_REF);
    expect(record.harnessId).toBe("default");
    expect(record.cases[0].harnessId).toBe("default");
  });

  it("the runner-level harness applies to every case", async () => {
    const runner = new EvalRunner({ store, workspacesRoot: os.tmpdir() });
    const record = await runner.runSuite(miniSuite, MODEL_REF, { harness: "tool-heavy" });
    for (const entry of record.cases) expect(entry.harnessId).toBe("tool-heavy");
  });

  it("a case-level harness wins over the runner-level one", async () => {
    const runner = new EvalRunner({
      store,
      workspacesRoot: os.tmpdir(),
      harness: "default",
    });
    const suite: EvalSuite = {
      ...miniSuite,
      cases: [{ ...miniSuite.cases[0], harness: "minimal" }],
    };
    const record = await runner.runSuite(suite, MODEL_REF);
    expect(record.harnessId).toBe("default");
    expect(record.cases[0].harnessId).toBe("minimal");
  });

  it("stored runs remain readable when harness attribution is absent", () => {
    // A record written before Phase 81 has no harnessId; readers must not
    // assume `default` for it.
    const legacy = {
      schemaVersion: 1,
      runId: "legacy",
      suiteId: "mini",
      suiteVersion: "1.0.0",
      model: MODEL_ID,
      provider: PROVIDER,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1,
      passed: 1,
      failed: 0,
      metrics: { passRate: 1, meanDurationMs: 1, meanInputTokens: 0, meanOutputTokens: 0, totalToolCalls: 0, totalFailedToolCalls: 0, byType: {} },
      cases: [],
    };
    store.append(legacy as never);
    const found = store.get("legacy");
    expect(found).toBeDefined();
    expect(found?.harnessId).toBeUndefined();
  });
});

describe("Phase 81 §14 — the same model under different harnesses is measurable", () => {
  it("produces separate, attributable runs", async () => {
    const runner = new EvalRunner({ store, workspacesRoot: os.tmpdir() });
    const a = await runner.runSuite(miniSuite, MODEL_REF, { harness: "default" });
    const b = await runner.runSuite(miniSuite, MODEL_REF, { harness: "coding" });

    expect(a.runId).not.toBe(b.runId);
    expect(a.harnessId).toBe("default");
    expect(b.harnessId).toBe("coding");

    const stored = store.bySuite("mini");
    expect(stored.filter((record) => record.harnessId === "default")).toHaveLength(1);
    expect(stored.filter((record) => record.harnessId === "coding")).toHaveLength(1);
  });

  it("a wrong-profile id fails the cases honestly instead of silently passing", async () => {
    const runner = new EvalRunner({ store, workspacesRoot: os.tmpdir() });
    const record = await runner.runSuite(miniSuite, MODEL_REF, { harness: "ghost" });
    expect(record.failed).toBe(miniSuite.cases.length);
    expect(record.cases[0].failureClass).toBe("CORE_RUNTIME");
    expect(record.cases[0].detail).toContain("Unknown harness profile");
  });

  it("records turns so harnesses can be compared on cost, not only pass rate", async () => {
    const runner = new EvalRunner({ store, workspacesRoot: os.tmpdir() });
    const record = await runner.runSuite(miniSuite, MODEL_REF, { harness: "coding" });
    expect(typeof record.metrics.meanTurns).toBe("number");
    expect(typeof record.cases[0].turns).toBe("number");
  });

  it("uses the coding suite's real fixtures through the production path", async () => {
    // Same runner, one real built-in suite, an explicit profile.
    const runner = new EvalRunner({ store, workspacesRoot: os.tmpdir() });
    const oneCase: EvalSuite = {
      ...codingSuite,
      cases: codingSuite.cases.slice(0, 1),
    };
    const record = await runner.runSuite(oneCase, MODEL_REF, { harness: "coding" });
    expect(record.harnessId).toBe("coding");
    expect(record.cases).toHaveLength(1);
  });
});
