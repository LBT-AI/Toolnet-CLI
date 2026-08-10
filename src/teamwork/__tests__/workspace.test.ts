import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  initWorkspace,
  setWorkspaceRoot,
  getCwdInfo,
  toolRead,
  toolBash,
  resolvePath,
} from "../../lib/codingAgent";
import { pwdCommand } from "../../commands/pwd";
import { cdCommand } from "../../commands/cd";
import { workspaceCommand } from "../../commands/workspace";
import type { CommandContext } from "../../commands/index";

describe("Workspace Management & Path Resolution", () => {
  const originalCwd = process.cwd();
  const testRoot = path.resolve(originalCwd, "test_workspace_sandbox");
  const subProj = path.join(testRoot, "sub_project");

  beforeEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(subProj, { recursive: true });
    fs.writeFileSync(path.join(subProj, "sub.txt"), "hello from sub project", "utf8");
    fs.writeFileSync(path.join(testRoot, "root.txt"), "hello from root project", "utf8");

    // Initialize workspace to testRoot
    setWorkspaceRoot(testRoot);
  });

  afterEach(() => {
    setWorkspaceRoot(originalCwd);
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("setWorkspaceRoot updates workspaceRoot and currentCwd", () => {
    const success = setWorkspaceRoot(subProj);
    expect(success).toBe(true);
    const { workspaceRoot, currentCwd } = getCwdInfo();
    expect(workspaceRoot).toBe(subProj);
    expect(currentCwd).toBe(subProj);
  });

  test("setWorkspaceRoot fails for non-existent path", () => {
    const invalidPath = path.join(testRoot, "non_existent_dir_123");
    const success = setWorkspaceRoot(invalidPath);
    expect(success).toBe(false);
  });

  test("initWorkspace resolves custom path correctly", () => {
    initWorkspace(subProj);
    const { workspaceRoot } = getCwdInfo();
    expect(workspaceRoot).toBe(subProj);
  });

  test("resolvePath resolves relative paths against workspaceRoot", () => {
    setWorkspaceRoot(subProj);
    const resolved = resolvePath("sub.txt");
    expect(resolved).toBe(path.join(subProj, "sub.txt"));
  });

  test("toolRead resolves relative path from workspaceRoot", () => {
    setWorkspaceRoot(subProj);
    const res = toolRead("sub.txt");
    expect(res.success).toBe(true);
    expect(res.data).toBe("hello from sub project");
  });

  test("path traversal outside workspace is blocked for relative paths", () => {
    setWorkspaceRoot(subProj);
    // Relative path escaping subProj
    const res = toolRead("../root.txt");
    expect(res.success).toBe(false);
    expect(res.error).toContain("Path traversal blocked");
  });

  test("toolBash runs command with cwd = workspaceRoot", async () => {
    setWorkspaceRoot(subProj);
    const res = await toolBash("pwd");
    expect(res.success).toBe(true);
    expect(res.stdout?.trim()).toBe(subProj);
  });

  test("/pwd command prints process.cwd(), workspaceRoot, shell cwd", async () => {
    setWorkspaceRoot(subProj);
    const messages: string[] = [];
    const dummyCtx: CommandContext = {
      gateway: {} as any,
      addMessage: (_role, content) => messages.push(content),
      setModel: () => {},
      setStatusMsg: () => {},
      exit: () => {},
      currentModel: () => "default",
    };

    await pwdCommand.handler([], dummyCtx);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("process.cwd()");
    expect(messages[0]).toContain("workspaceRoot");
    expect(messages[0]).toContain("shell cwd");
    expect(messages[0]).toContain(subProj);
  });

  test("/cd command updates workspaceRoot", async () => {
    setWorkspaceRoot(testRoot);
    const messages: string[] = [];
    const dummyCtx: CommandContext = {
      gateway: {} as any,
      addMessage: (_role, content) => messages.push(content),
      setModel: () => {},
      setStatusMsg: () => {},
      exit: () => {},
      currentModel: () => "default",
    };

    await cdCommand.handler([subProj], dummyCtx);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("Workspace root changed to");
    expect(getCwdInfo().workspaceRoot).toBe(subProj);
  });

  test("/workspace command displays active workspaceRoot", async () => {
    setWorkspaceRoot(subProj);
    const messages: string[] = [];
    const dummyCtx: CommandContext = {
      gateway: {} as any,
      addMessage: (_role, content) => messages.push(content),
      setModel: () => {},
      setStatusMsg: () => {},
      exit: () => {},
      currentModel: () => "default",
    };

    await workspaceCommand.handler([], dummyCtx);
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain(`Current workspace: ${subProj}`);
  });
});
