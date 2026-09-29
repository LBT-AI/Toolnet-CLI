import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyShellCommand, assessRedirection, filesystemRedirectTargets } from "../commandClassifier";
import { securityEngine } from "../securityEngine";
import { parseShellCommand } from "../shellParser";

// ── Phase 4 / TN-R0-007B ──────────────────────────────────────────────────
// Redirections are FD-aware: `2>/dev/null`, `2>>/dev/null`, `>&2`, `2>&1` and
// `> /dev/null` never touch persistent state and are NOT system tampering.
// Real filesystem writes keep full protection (`/etc` writes stay SYSTEM_TAMPERING,
// out-of-workspace writes stay gated).

test("2>/dev/null is a discard sink, not system tampering", () => {
  const cmd = "echo hello 2>/dev/null";
  const ast = parseShellCommand(cmd);
  // The parser still records the raw target; the classifier interprets it.
  expect(ast.allRedirectTargets).toContain("/dev/null");
  expect(filesystemRedirectTargets(ast)).toEqual([]);

  const analysis = classifyShellCommand(cmd);
  expect(analysis.category).toBe("READ_ONLY");
  expect(analysis.riskLevel).toBe("SAFE_READ");

  const result = securityEngine.evaluate("shell", { command: cmd }, "workspace");
  expect(result.decision).toBe("ALLOW");
  expect(result.allowed).toBe(true);
});

test("2>>/dev/null is also a discard sink", () => {
  const cmd = "echo hello 2>>/dev/null";
  const ast = parseShellCommand(cmd);
  expect(ast.allRedirectTargets).toContain("/dev/null");
  expect(filesystemRedirectTargets(ast)).toEqual([]);

  const analysis = classifyShellCommand(cmd);
  expect(analysis.category).not.toBe("SYSTEM_TAMPERING");
  expect(analysis.riskLevel).toBe("SAFE_READ");
  expect(securityEngine.evaluate("shell", { command: cmd }, "workspace").decision).toBe("ALLOW");
});

test("> /dev/null is a discard sink", () => {
  const cmd = "echo hello > /dev/null";
  const analysis = classifyShellCommand(cmd);
  expect(analysis.category).not.toBe("SYSTEM_TAMPERING");
  expect(securityEngine.evaluate("shell", { command: cmd }, "workspace").decision).toBe("ALLOW");
});

test("2>&1 is fd duplication, never a filesystem write", () => {
  const cmd = "echo hello 2>&1";
  const ast = parseShellCommand(cmd);
  expect(filesystemRedirectTargets(ast)).toEqual([]);
  expect(assessRedirection({ type: "2>&1", target: "1" }).writesFilesystem).toBe(false);

  const analysis = classifyShellCommand(cmd);
  expect(analysis.category).toBe("READ_ONLY");
  expect(securityEngine.evaluate("shell", { command: cmd }, "workspace").decision).toBe("ALLOW");
});

test("Control case: workspace write", () => {
  const cmd = "echo hello > ./safe.txt";
  const analysis = classifyShellCommand(cmd, process.cwd(), process.cwd());
  expect(analysis.category).not.toBe("SYSTEM_TAMPERING");
  expect(securityEngine.evaluate("shell", { command: cmd }, "workspace", process.cwd(), process.cwd()).decision).toBe("ALLOW");
});

test("Control case: protected system write stays SYSTEM_TAMPERING", () => {
  const cmd = "echo test > /etc/toolnet-test";
  const analysis = classifyShellCommand(cmd);
  expect(analysis.category).toBe("SYSTEM_TAMPERING");
  expect(analysis.riskLevel).toBe("CRITICAL_DENY");

  expect(securityEngine.evaluate("shell", { command: cmd }, "workspace").decision).toBe("DENY");
  expect(securityEngine.evaluate("shell", { command: cmd }, "ask").decision).toBe("DENY");
  expect(securityEngine.evaluate("shell", { command: cmd }, "full-access").decision).toBe("DENY");
});

test("Control case: a discard sink does not launder a protected write", () => {
  const cmd = "echo hello 2>/dev/null > /etc/crontab";
  const analysis = classifyShellCommand(cmd);
  expect(analysis.category).toBe("SYSTEM_TAMPERING");
  expect(analysis.riskLevel).toBe("CRITICAL_DENY");
  expect(securityEngine.evaluate("shell", { command: cmd }, "workspace").decision).toBe("DENY");
});

test("Control case: /dev/null as an argument is not an out-of-workspace path", () => {
  const cmd = "cat /dev/null";
  expect(securityEngine.evaluate("shell", { command: cmd }, "workspace", process.cwd(), process.cwd()).decision).toBe("ALLOW");
});

// ── Platform temp dirs ────────────────────────────────────────────────────
// `/var` is a protected system prefix, but on macOS the OS temp dir IS
// `/var/folders/...` (realpath `/private/var/folders/...`). Containment has to
// win over the prefix veto, otherwise a workspace that lives in the platform
// temp dir — the normal case for tests and for macOS TMPDIR in general — could
// never write its own files in 'workspace' mode.

test("a workspace under a protected prefix may still redirect into itself", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-redirect-ws-"));
  try {
    const cmd = `echo hello > ${ws}/nested.txt`;
    const analysis = classifyShellCommand(cmd, ws, ws);
    expect(analysis.category).not.toBe("SYSTEM_TAMPERING");
    expect(analysis.isDangerous).toBe(false);

    const result = securityEngine.evaluate("shell", { command: cmd }, "workspace", ws, ws);
    expect(result.decision).toBe("ALLOW");
    expect(result.allowed).toBe(true);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("a redirect into the platform temp dir outside the workspace is not system tampering", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-redirect-outside-"));
  const sink = path.join(os.tmpdir(), `toolnet-redirect-sink-${process.pid}.txt`);
  try {
    const analysis = classifyShellCommand(`echo hello > ${sink}`, ws, ws);
    expect(analysis.category).not.toBe("SYSTEM_TAMPERING");
    expect(analysis.category).not.toBe("WORKSPACE_ESCAPE");
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("an out-of-workspace redirect outside temp dirs stays gated", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-redirect-escape-"));
  try {
    const outside = path.join(os.homedir(), "toolnet-outside-write.txt");
    const analysis = classifyShellCommand(`echo hello > ${outside}`, ws, ws);
    expect(analysis.isDangerous).toBe(true);
    expect(["WORKSPACE_ESCAPE", "SYSTEM_TAMPERING", "SENSITIVE_FILE_ACCESS"]).toContain(analysis.category);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
