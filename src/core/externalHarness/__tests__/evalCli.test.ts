/**
 * Phase 83 §17/§18/§20 — eval integration + CLI tests.
 *
 * Eval: the executionTarget dimension reuses the SAME EvalRunner, graders and
 * isolated workspace; an unavailable external harness is recorded as
 * ENVIRONMENT (never a model-quality failure).
 *
 * CLI: `harness external list|show|run` through the canonical registry, with
 * argv-forwarded extra args and namespace-validated session resume.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { EvalRunner } from "../../eval/runner";
import { harnessExecutionService, HarnessExecutionService, ExternalHarnessRunner } from "../index";
import { runHarnessCli, HARNESS_CLI_USAGE } from "../../../commands/harnessCli";
import { createOpenCodeAdapter } from "../adapters";
import { ExternalHarnessRegistry } from "../registry";

// ── §17/§18 — eval over execution targets ──────────────────────────────────

describe("Phase 83 §17 — eval executionTarget dimension", () => {
  const suite = {
    id: "phase83-external",
    version: "1.0.0",
    name: "External target isolation",
    description: "Verifies the external execution path records honest identity.",
    cases: [
      {
        id: "ext-unknown-harness",
        name: "unknown external harness is ENVIRONMENT, not model failure",
        type: "TEXT" as const,
        prompt: "say OK",
        executionTarget: "no-such-harness",
        grader: { kind: "contains" as const, containsAll: ["OK"] },
      },
    ],
  };

  it("records executionTarget and classifies unavailability as ENVIRONMENT", async () => {
    const runner = new EvalRunner();
    const record = await runner.runSuite(suite, "unknown/model-for-phase83", { executionTarget: "native" });
    // The case-level target comes from the case; the run-level target was native.
    expect(record.executionTarget).toBe("native");
    const caseResult = record.cases[0];
    expect(caseResult.executionTarget).toBe("no-such-harness");
    expect(caseResult.pass).toBe(false);
    expect(caseResult.failureClass).toBe("ENVIRONMENT");
    expect(caseResult.detail).toContain("target=no-such-harness");
  });

  it("external eval runs in an isolated workspace that is cleaned up", async () => {
    const workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "phase83-eval-"));
    const before = fs.readdirSync(workspacesRoot);
    const runner = new EvalRunner({ workspacesRoot });
    await runner.runSuite(
      {
        ...suite,
        cases: [{ ...suite.cases[0], executionTarget: "also-missing" }],
      },
      "unknown/model-for-phase83",
    );
    const after = fs.readdirSync(workspacesRoot);
    expect(before.length).toBe(0);
    expect(after.length).toBe(0); // workspace destroyed after the case
    fs.rmSync(workspacesRoot, { recursive: true, force: true });
  });
});

// ── §16 — HarnessExecutionService dispatch ──────────────────────────────────

describe("Phase 83 §16 — HarnessExecutionService dispatch", () => {
  it("native is the default target; unknown ids are structured errors", async () => {
    expect(harnessExecutionService.resolveTarget("").kind).toBe("native");
    expect(harnessExecutionService.resolveTarget("native").kind).toBe("native");
    expect(harnessExecutionService.resolveTarget("toolnet").kind).toBe("native");
    expect(() => harnessExecutionService.resolveTarget("definitely-not-registered")).toThrow(/not registered/);
  });

  it("external targets dispatch to the runner with capability gating", async () => {
    const registry = new ExternalHarnessRegistry();
    registry.register({
      ...createOpenCodeAdapter(),
      id: "fakeext",
      // Self-contained: the child is `bun -e` (fast, offline, no external binary).
      executable: process.execPath,
      capabilities: { ...createOpenCodeAdapter().capabilities, sessionFork: false },
      detect: async () => ({ available: true, version: "0.0.0" }),
      buildInvocation: () => ({ argv: ["-e", "console.log('say ok')"] }),
      parseEvent: (line) => (line.includes("ok") ? [{ kind: "completed", terminalSuccess: true }] : []),
    });
    const service = new HarnessExecutionService({ registry, runner: new ExternalHarnessRunner(registry) });
    const outcome = await service.run({
      target: "fakeext",
      prompt: "say ok",
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "phase83-svc-")),
      timeoutMs: 30_000,
    });
    expect(outcome.target).toBe("external");
    expect(outcome.executionTrust).toBe("external_managed");
    expect(outcome.external?.status).toBe("SUCCESS");

    // Capability gate: resume on a fork-incapable harness is a typed error,
    // not a silent behavior change.
    await expect(
      service.run({
        target: "fakeext",
        prompt: "x",
        resume: { harnessId: "fakeext", externalSessionId: "s1" },
        forkSession: true,
      }),
    ).rejects.toThrow(/session fork/);
  });
});

// ── §20 — CLI ───────────────────────────────────────────────────────────────

describe("Phase 83 §20 — harness external CLI", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
      stdout: () => out.join("\n"),
      stderr: () => err.join("\n"),
    };
  }

  it("external list shows all registered harnesses with availability", async () => {
    const { io, stdout } = capture();
    const code = await runHarnessCli(["external", "list"], { io });
    expect(code).toBe(0);
    expect(stdout()).toContain("opencode");
    expect(stdout()).toContain("codex");
    expect(stdout()).toContain("claude");
    expect(stdout()).toContain("hermes");
  });

  it("external list --json emits machine-readable status", async () => {
    const { io, stdout } = capture();
    const code = await runHarnessCli(["external", "list", "--json"], { io });
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((entry: { id: string }) => entry.id === "opencode")).toBe(true);
  });

  it("external show prints capabilities and the trust boundary", async () => {
    const { io, stdout } = capture();
    const code = await runHarnessCli(["external", "show", "opencode"], { io });
    expect(code).toBe(0);
    expect(stdout()).toContain("external_managed");
    expect(stdout()).toContain("OUTSIDE ToolNet's permission system");
  });

  it("external show with an unknown id fails cleanly", async () => {
    const { io, stderr } = capture();
    const code = await runHarnessCli(["external", "show", "ghost"], { io });
    expect(code).toBe(1);
    expect(stderr()).toContain("not registered");
  });

  it("external run without --prompt prints usage and fails", async () => {
    const { io, stderr } = capture();
    const code = await runHarnessCli(["external", "run", "opencode"], { io });
    expect(code).toBe(1);
    expect(stderr()).toContain("--prompt");
  });

  it("external run with a malformed session id is rejected before spawn", async () => {
    const { io, stderr } = capture();
    const code = await runHarnessCli(
      ["external", "run", "opencode", "--prompt", "x", "--session", "raw-native-id"],
      { io },
    );
    expect(code).toBe(1);
    expect(stderr()).toContain("external:<harness>");
  });

  it("usage documents the external subcommands", () => {
    expect(HARNESS_CLI_USAGE).toContain("external list");
    expect(HARNESS_CLI_USAGE).toContain("external run");
  });

  it("external run forwards post-`--` args verbatim as argv (smoke through runner seam)", async () => {
    const seen: unknown[] = [];
    const { io, stdout } = capture();
    const code = await runHarnessCli(
      ["external", "run", "opencode", "--prompt", "p", "--", "--flag-a", "--flag-b value"],
      { io, externalRun: async (request) => {
          seen.push(request.extraArgs);
          return {
            harnessId: request.harnessId,
            status: "SUCCESS",
            durationMs: 1,
            events: [],
            metadata: { argv: [], cwd: "/tmp", truncated: false },
          };
        } },
    );
    expect(code).toBe(0);
    expect(seen[0]).toEqual(["--flag-a", "--flag-b value"]);
  });
});
