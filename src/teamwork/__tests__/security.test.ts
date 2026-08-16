import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { isDangerousCommand } from "../../lib/agentTools";
import {
  evaluatePermission,
  isPathInsideWorkspace,
  isDangerousShellCommand,
  setSandboxMode,
  getSandboxMode,
} from "../../lib/permissions";
import { resolve, join } from "node:path";
import fs from "node:fs";
import os from "node:os";

describe("Security & Permissions", () => {
  const cwd = process.cwd();

  beforeEach(() => {
    setSandboxMode("ask");
  });

  afterEach(() => {
    setSandboxMode("workspace");
  });

  test("P1-6: isDangerousCommand blocks dangerous run_command", () => {
    expect(isDangerousCommand("run_command", { command: "rm -rf /" }, cwd)).toBe(true);
    expect(isDangerousCommand("run_command", { command: "sudo su" }, cwd)).toBe(true);
    expect(isDangerousCommand("run_command", { command: "mkfs.ext4 /dev/sda1" }, cwd)).toBe(true);
    expect(isDangerousCommand("run_command", { command: "ls -la" }, cwd)).toBe(false);
  });

  test("P1-6: isDangerousCommand blocks writing outside workspace", () => {
    expect(isDangerousCommand("write_file", { path: "../outside.txt" }, cwd)).toBe(true);
    expect(isDangerousCommand("edit_file", { path: "/etc/passwd" }, cwd)).toBe(true);
    expect(isDangerousCommand("replace_all", { path: resolve(cwd, "../parent.ts") }, cwd)).toBe(true);
    expect(isDangerousCommand("write_file", { path: "inside.txt" }, cwd)).toBe(false);
    expect(isDangerousCommand("write_file", { path: resolve(cwd, "inside2.txt") }, cwd)).toBe(false);
  });

  test("3 Sandbox Modes (workspace, ask, full-access)", () => {
    // Mode: workspace (strict workspace isolation)
    setSandboxMode("workspace");
    const wsRead = evaluatePermission("read_file", { path: "/etc/passwd" }, "workspace", cwd, cwd);
    expect(wsRead.allowed).toBe(false);

    const wsWrite = evaluatePermission("write_file", { path: "../outside.txt" }, "workspace", cwd, cwd);
    expect(wsWrite.allowed).toBe(false);

    const wsShell = evaluatePermission("shell", { command: "rm -rf /" }, "workspace", cwd, cwd);
    expect(wsShell.allowed).toBe(false);

    // Mode: ask (prompt user for outside access / dangerous commands)
    setSandboxMode("ask");
    const askRead = evaluatePermission("read_file", { path: "/etc/passwd" }, "ask", cwd, cwd);
    expect(askRead.allowed).toBe(true);
    expect(askRead.needsApproval).toBe(true);

    const askInside = evaluatePermission("read_file", { path: "package.json" }, "ask", cwd, cwd);
    expect(askInside.allowed).toBe(true);
    expect(askInside.needsApproval).toBe(false);

    // Mode: full-access (unrestricted)
    setSandboxMode("full-access");
    const fullRead = evaluatePermission("read_file", { path: "/etc/passwd" }, "full-access", cwd, cwd);
    expect(fullRead.allowed).toBe(true);
    expect(fullRead.needsApproval).toBe(false);
  });

  test("Absolute path traversal & symlink escape prevention", () => {
    const tmpDir = fs.mkdtempSync(join(os.tmpdir(), "toolnet-sec-test-"));
    const outerDir = join(tmpDir, "outer");
    const innerDir = join(tmpDir, "workspace");

    fs.mkdirSync(outerDir, { recursive: true });
    fs.mkdirSync(innerDir, { recursive: true });

    const targetOutside = join(outerDir, "secret.txt");
    fs.writeFileSync(targetOutside, "secret");

    // Create a symlink inside workspace pointing to outer file
    const symlinkPath = join(innerDir, "symlink_secret.txt");
    try {
      fs.symlinkSync(targetOutside, symlinkPath);
    } catch {}

    // Check normal relative path inside
    const checkInner = isPathInsideWorkspace("file.txt", innerDir, innerDir);
    expect(checkInner.isInside).toBe(true);

    // Check absolute path outside
    const checkAbsOutside = isPathInsideWorkspace(targetOutside, innerDir, innerDir);
    expect(checkAbsOutside.isInside).toBe(false);

    // Check symlink escape
    if (fs.existsSync(symlinkPath)) {
      const checkSymlink = isPathInsideWorkspace(symlinkPath, innerDir, innerDir);
      expect(checkSymlink.isInside).toBe(false);
    }

    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test("Dangerous shell command analysis", () => {
    expect(isDangerousShellCommand("ls -la").isDangerous).toBe(false);
    expect(isDangerousShellCommand("npm test").isDangerous).toBe(false);
    expect(isDangerousShellCommand("cat /etc/passwd").isDangerous).toBe(true);
    expect(isDangerousShellCommand("sudo systemctl restart nginx").isDangerous).toBe(true);
    expect(isDangerousShellCommand("rm -rf ./build").isDangerous).toBe(true);
    expect(isDangerousShellCommand("cat ../secret.env").isDangerous).toBe(true);
  });
});
