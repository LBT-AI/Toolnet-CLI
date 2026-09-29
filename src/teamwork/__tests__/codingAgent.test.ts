import { test, expect, describe, beforeEach, afterAll, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  toolBash,
  toolRead,
  toolWrite,
  getCwdInfo,
  setWorkspaceRoot,
  resetWorkspaceState,
} from "../../lib/codingAgent";

describe("codingAgent Cross-Workspace Filesystem & Workspace Tracking", () => {
  const originalCwd = process.cwd();
  const testRoot = path.resolve(originalCwd, "test_sandbox");
  const extDir = path.resolve(testRoot, "external_project");

  beforeEach(() => {
    // Reset test environment
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRoot, { recursive: true });
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, "hello.txt"), "external hello", "utf8");
    setWorkspaceRoot(testRoot);
  });

  afterEach(() => {
    resetWorkspaceState();
  });

  afterAll(() => {
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch {}
  });

  test("toolBash tracks shell CWD changes while starting in workspaceRoot", async () => {
    // Navigate to external dir. Shell arguments always use `/` separators:
    // backslashes are escapes in bash (including Git Bash on Windows).
    const shellPath = (p: string) => p.replace(/\\/g, "/");
    const res1 = await toolBash(`cd '${shellPath(extDir)}'`);
    expect(res1.success).toBe(true);
    
    // Compare canonical paths: the shell reports its own notation and macOS
    // temp dirs are symlinked, so neither side can be compared as raw text.
    const canonical = (p: string) => {
      const real = fs.realpathSync(p);
      return process.platform === "win32" ? real.toLowerCase() : real;
    };

    // Check if shell CWD state is updated in currentCwd
    const { currentCwd: newCwd, workspaceRoot } = getCwdInfo();
    expect(canonical(newCwd)).toBe(canonical(extDir));
    expect(workspaceRoot).toBe(testRoot);

    // Shell tool execution starts with cwd = workspaceRoot — proved by where a
    // relative file lands, not by the shell's rendering of the path.
    const res2 = await toolBash(`touch cwd-proof.txt`);
    expect(res2.success).toBe(true);
    expect(fs.existsSync(path.join(testRoot, "cwd-proof.txt"))).toBe(true);
  });

  test("Filesystem tools resolve absolute paths bypassing default workspaceRoot", () => {
    const absPath = path.join(extDir, "hello.txt");
    
    // toolRead should access absolute path
    const readRes = toolRead(absPath);
    expect(readRes.success).toBe(true);
    expect(readRes.data).toBe("external hello");

    // toolWrite should write to absolute path correctly
    const writePath = path.join(extDir, "new.txt");
    const writeRes = toolWrite(writePath, "new external data");
    expect(writeRes.success).toBe(true);
    expect(fs.readFileSync(writePath, "utf8")).toBe("new external data");
  });

  test("Filesystem tools resolve relative paths based on workspaceRoot", () => {
    setWorkspaceRoot(extDir);
    
    // Read relative path in workspaceRoot
    const readRes = toolRead("hello.txt");
    expect(readRes.success).toBe(true);
    expect(readRes.data).toBe("external hello");
  });
});
