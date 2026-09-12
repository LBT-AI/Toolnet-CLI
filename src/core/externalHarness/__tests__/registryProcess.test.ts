/**
 * Phase 83 §23 — External harness registry, security and process tests.
 *
 * Nothing here requires an external harness to be installed: process tests
 * use `bun` itself as the child binary, which is guaranteed present.
 */

import { describe, expect, it } from "bun:test";
import { ExternalHarnessRegistry } from "../registry";
import { harnessChildEnv, normalizeCwd, safeSpawn } from "../process";
import {
  HarnessNotFoundError,
  HarnessSpawnError,
  HarnessUnavailableError,
} from "../errors";
import type { ExternalHarnessDefinition } from "../types";

function fakeDefinition(id: string, executable = "definitely-not-a-real-binary-xyz"): ExternalHarnessDefinition {
  return {
    id,
    displayName: id,
    executable,
    executionTrust: "external_managed",
    envAllowlist: ["NO_COLOR"],
    capabilities: {
      structuredOutput: true,
      streaming: true,
      modelOverride: true,
      providerOverride: false,
      sessionResume: true,
      sessionFork: false,
      workingDirectory: true,
      stdinPrompt: false,
      fileAttachments: false,
      nonInteractive: true,
      abort: true,
      nativePermissions: "unknown",
    },
    detect: async () => ({ available: false, detail: "executable not found on PATH" }),
    buildInvocation: (context) => ({ argv: ["run", context.prompt] }),
    parseEvent: () => [],
    normalizeResult: ({ exitCode }) => ({ status: exitCode === 0 ? "SUCCESS" : "FAILED" }),
  };
}

describe("Phase 83 §3 — registry", () => {
  it("registers, refuses duplicates, resolves and reports unknowns", () => {
    const registry = new ExternalHarnessRegistry();
    registry.register(fakeDefinition("alpha"));
    expect(registry.ids()).toEqual(["alpha"]);
    expect(() => registry.register(fakeDefinition("alpha"))).toThrow(/already registered/);
    expect(registry.resolve("alpha").id).toBe("alpha");
    // `external:` namespace form is accepted.
    expect(registry.resolve("external:alpha").id).toBe("alpha");
    expect(() => registry.resolve("ghost")).toThrow(HarnessNotFoundError);
  });

  it("detect caches results and invalidateDetection forces a re-probe", async () => {
    const registry = new ExternalHarnessRegistry();
    let calls = 0;
    registry.register({
      ...fakeDefinition("beta"),
      detect: async () => {
        calls += 1;
        return { available: true, version: "1.2.3" };
      },
    });
    const first = await registry.detect("beta");
    const second = await registry.detect("beta");
    expect(calls).toBe(1);
    expect(second).toEqual(first);
    registry.invalidateDetection("beta");
    await registry.detect("beta");
    expect(calls).toBe(2);
  });

  it("a throwing detector degrades to unavailable, never throws", async () => {
    const registry = new ExternalHarnessRegistry();
    registry.register({
      ...fakeDefinition("gamma"),
      detect: async () => {
        throw new Error("detector exploded");
      },
    });
    const state = await registry.detect("gamma");
    expect(state.available).toBe(false);
    expect(state.detail).toContain("exploded");
  });

  it("statusOf reports verified-true capabilities only", async () => {
    const registry = new ExternalHarnessRegistry();
    registry.register({
      ...fakeDefinition("delta"),
      detect: async () => ({ available: true, version: "9.9.9" }),
    });
    const view = await registry.statusOf("delta");
    expect(view.detection.available).toBe(true);
    expect(view.executionTrust).toBe("external_managed");
    expect(view.capabilities.structuredOutput).toBe(true);
  });
});

describe("Phase 83 §12 — detection against missing binaries", () => {
  it("reports structured unavailable for a missing executable", async () => {
    const registry = new ExternalHarnessRegistry();
    const definition = fakeDefinition("missing");
    registry.register(definition);
    const state = await registry.detect("missing", { force: true });
    expect(state.available).toBe(false);
  });

  it("runner.run on an unavailable harness throws HarnessUnavailableError", async () => {
    const registry = new ExternalHarnessRegistry();
    registry.register(fakeDefinition("ghost-harness"));
    const { ExternalHarnessRunner } = await import("../runner");
    const runner = new ExternalHarnessRunner(registry);
    await expect(runner.run({ harnessId: "ghost-harness", prompt: "hi" })).rejects.toThrow(HarnessUnavailableError);
  });
});

describe("Phase 83 §5 — safe process execution", () => {
  it("runs argv children and captures stdout/stderr/exit code", async () => {
    const outcome = await safeSpawn({
      executable: process.execPath,
      args: ["-e", 'console.log("out-42"); console.error("err-7");'],
      cwd: normalizeCwd(process.cwd()),
      envAllowlist: [],
      timeoutMs: 30_000,
    });
    expect(outcome.exitCode).toBe(0);
    expect(String(outcome.stdout)).toContain("out-42");
    expect(String(outcome.stderrTail)).toContain("err-7");
    expect(outcome.killed).toBe(false);
  });

  it("shell metacharacters in args stay inert data (no shell interpretation)", async () => {
    const evil = '"; rm -rf /tmp/phase83-should-not-exist; echo $(whoami); `id` && cat /etc/passwd || echo ${HOME}';
    const outcome = await safeSpawn({
      executable: process.execPath,
      args: ["-e", `console.log(process.argv[1])`, evil],
      cwd: normalizeCwd(process.cwd()),
      envAllowlist: [],
      timeoutMs: 30_000,
    });
    // The poison string arrives as ONE argv element, unexecuted.
    expect(outcome.stdout.trim()).toBe(evil);
  });

  it("timeout kills the child (and its process group)", async () => {
    const outcome = await safeSpawn({
      executable: process.execPath,
      args: ["-e", "setTimeout(() => console.log('never'), 60_000);"],
      cwd: normalizeCwd(process.cwd()),
      envAllowlist: [],
      timeoutMs: 300,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.killed).toBe(true);
    expect(outcome.exitCode).not.toBe(0);
  });

  it("abort kills the child", async () => {
    const controller = new AbortController();
    const run = safeSpawn({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
      cwd: normalizeCwd(process.cwd()),
      envAllowlist: [],
      signal: controller.signal,
      timeoutMs: 60_000,
    });
    setTimeout(() => controller.abort(), 200);
    const outcome = await run;
    expect(outcome.killed).toBe(true);
  });

  it("spawn of a nonexistent binary yields a typed spawn error", async () => {
    const { ExternalHarnessRunner } = await import("../runner");
    const registry = new ExternalHarnessRegistry();
    registry.register({ ...fakeDefinition("liar"), detect: async () => ({ available: true }) });
    const runner = new ExternalHarnessRunner(registry);
    await expect(runner.run({ harnessId: "liar", prompt: "hi", timeoutMs: 10_000 })).rejects.toThrow(HarnessSpawnError);
  });

  it("env passthrough honors the allowlist and never leaks secret-named vars", () => {
    process.env.PHASE83_TEST_MARKER = "visible";
    process.env.PHASE83_TEST_API_KEY = "must-not-pass";
    const env = harnessChildEnv(process.env, ["PHASE83_TEST_MARKER", "PHASE83_TEST_API_KEY"]);
    expect(env.PHASE83_TEST_MARKER).toBe("visible");
    expect(env.PHASE83_TEST_API_KEY).toBeUndefined();
    delete process.env.PHASE83_TEST_MARKER;
    delete process.env.PHASE83_TEST_API_KEY;
  });

  it("large output is truncated, not OOM", async () => {
    const outcome = await safeSpawn({
      executable: process.execPath,
      args: ["-e", "console.log('x'.repeat(64 * 1024 * 1024));"],
      cwd: normalizeCwd(process.cwd()),
      envAllowlist: [],
      timeoutMs: 60_000,
    });
    expect(outcome.truncated).toBe(true);
    expect(outcome.stdout.length).toBeLessThan(64 * 1024 * 1024);
  });

  it("cwd is validated (missing directory rejected)", () => {
    expect(() => normalizeCwd("/definitely/not/a/real/dir-phase83")).toThrow(/cwd/);
    expect(() => normalizeCwd("")).toThrow(/cwd/);
  });
});
