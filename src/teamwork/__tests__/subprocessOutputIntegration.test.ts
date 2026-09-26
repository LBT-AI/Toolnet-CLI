/**
 * End-to-end subprocess output tests — the REAL executor.
 *
 * `TerminalOutputBuffer` unit tests prove the normalizer; these prove the
 * wiring: `toolBash` must decode with state, normalize escapes/CR, keep
 * stdout/stderr apart, and preserve exit codes. Includes a guarded run of the
 * real `vpsoci` when the binary exists (skipped elsewhere), reporting to no one
 * — it only asserts the captured stdout is clean.
 */
import { test, expect, describe } from "bun:test";
import fs from "node:fs";
import { toolBash } from "../../lib/codingAgent";

const VPSOCI = "/usr/local/bin/vpsoci";
const hasVpsoci = fs.existsSync(VPSOCI);

describe("toolBash — normalized output", () => {
  test("plain output round-trips", async () => {
    const res = await toolBash("printf 'hello\\nworld\\n'");
    expect(res.stdout).toBe("hello\nworld");
    expect(res.exitCode).toBe(0);
  });

  test("CR progress collapses to the final frame only", async () => {
    const res = await toolBash("printf 'Creating VPS... 10%%\\rCreating VPS... 34%%\\rCreating VPS... 100%%\\n'");
    expect(res.stdout).toBe("Creating VPS... 100%");
    expect(res.stdout).not.toContain("\r");
  });

  test("spinner frames never become committed lines", async () => {
    const res = await toolBash("printf '|\\r/\\r-\\r\\\\\\rDone\\n'");
    expect(res.stdout).toBe("Done");
  });

  test("ANSI color is stripped and text survives", async () => {
    const res = await toolBash("printf '\\033[31mError\\033[0m: boom\\n'");
    expect(res.stdout).toBe("Error: boom");
    expect(res.stdout).not.toContain("\u001b");
  });

  test("Vietnamese output is decoded correctly (no U+FFFD)", async () => {
    const res = await toolBash("printf '%s\\n' 'Tài nguyên A1 khả dụng: 41 OCPU, 277 GB RAM'");
    expect(res.stdout).toBe("Tài nguyên A1 khả dụng: 41 OCPU, 277 GB RAM");
    expect(res.stdout).not.toContain("\uFFFD");
  });

  test("stdout and stderr stay separate", async () => {
    const res = await toolBash("printf 'out line\\n'; printf 'err line\\n' 1>&2");
    expect(res.stdout).toBe("out line");
    expect(res.stderr).toBe("err line");
  });

  test("exit code is preserved", async () => {
    const res = await toolBash("printf 'done\\n'; exit 7");
    expect(res.exitCode).toBe(7);
    expect(res.stdout).toBe("done");
  });
});

describe("toolBash — real vpsoci", () => {
  test.skipIf(!hasVpsoci)("captured output has no junk, escapes or replacements", async () => {
    // --dry-run is the audit/plan mode: read-only, no changes.
    const res = await toolBash(`${VPSOCI} --dry-run`, 60000);
    expect(res.stdout).toBeTruthy();
    expect(res.stdout).not.toContain("\u001b");
    expect(res.stdout).not.toContain("\r");
    expect(res.stdout).not.toContain("\uFFFD");
    // The line that used to render as garbage must be exact and complete.
    expect(res.stdout).toContain("Tài nguyên A1 khả dụng trong hạn mức: 41 OCPU, 277 GB RAM");
    expect(res.exitCode).toBe(0);
  }, 65000);
});
