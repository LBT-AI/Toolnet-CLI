import { test, expect, describe, beforeEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  toolBash,
  toolRead,
  toolWrite,
  getCwdInfo,
  setWorkspaceRoot,
} from "../../lib/codingAgent";

describe("codingAgent Cross-Workspace Filesystem & Workspace Tracking", () => {
  const testRoot = path.resolve(process.cwd(), "test_sandbox");
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

  test("toolBash tracks shell CWD changes while starting in workspaceRoot", async () => {
    // Navigate to external dir
    const res1 = await toolBash(`cd ${extDir}`);
    expect(res1.success).toBe(true);
    
    // Check if shell CWD state is updated in currentCwd
    const { currentCwd: newCwd, workspaceRoot } = getCwdInfo();
    expect(newCwd).toBe(extDir);
    expect(workspaceRoot).toBe(testRoot);

    // Shell tool execution starts with cwd = workspaceRoot
    const res2 = await toolBash(`pwd`);
    expect(res2.success).toBe(true);
    expect(res2.stdout?.trim()).toBe(testRoot);
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
