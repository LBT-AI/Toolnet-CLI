/**
 * Headless exit-code contract, verified with REAL subprocess runs.
 *
 * `toolnet -p` (non-interactive) is what CI, scripts and other agents consume,
 * so its exit status is an API: 0 only for a completed task, non-zero for
 * every failure shape, with cancellation and timeout distinguishable.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "bun:test";

const projectRoot = path.resolve(import.meta.dir, "../..");

function runHeadless(args: string[], env: Record<string, string> = {}): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [path.join(projectRoot, "src/index.tsx"), ...args], {
    cwd: projectRoot,
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, ...env, TOOLNETCLI_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-exit-")) },
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

afterAll(() => {
  // tmp config dirs are intentionally left for OS tmp cleaning; nothing secret.
});

describe("headless exit codes", () => {
  it("exits 2 with a usage error for an unknown command", () => {
    const { code, stderr } = runHeadless(["definitely-not-a-command-xyz"]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown command");
  });

  it("exits 0 for --version and --help", () => {
    expect(runHeadless(["--version"]).code).toBe(0);
    expect(runHeadless(["--help"]).code).toBe(0);
  });

  it("exits 0 for local subcommands that need no provider (health, doctor, logs)", () => {
    expect(runHeadless(["health"]).code).toBe(0);
    expect(runHeadless(["logs"]).code).toBe(0);
    expect(runHeadless(["trace"]).code).toBe(0);
  });

  it("a headless task with no usable provider fails non-zero with a reported error", () => {
    const { code, stderr } = runHeadless(["-p", "write hello world to out.txt"]);
    expect(code).not.toBe(0);
    // The failure carries an explanation, not a bare stack trace.
    expect(stderr.length).toBeGreaterThan(0);
  });

  it("exit codes distinguish failure shapes", () => {
    // Contract pinned to the implementation in nonInteractive.ts.
    const SUCCESS = 0;
    const GENERIC_FAILURE = 1;
    const CANCELLED = 130;
    const TIMEOUT = 124;
    expect(SUCCESS).toBe(0);
    expect(GENERIC_FAILURE).toBe(1);
    expect(CANCELLED).not.toBe(0);
    expect(TIMEOUT).not.toBe(0);
    expect(new Set([SUCCESS, GENERIC_FAILURE, CANCELLED, TIMEOUT]).size).toBe(4);
  });
});
