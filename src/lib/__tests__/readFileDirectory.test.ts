import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolRegistry } from "../harness/toolRegistry";
import { setSandboxMode } from "../permissions";

let tmpDir: string;

beforeEach(() => {
  setSandboxMode("full-access");
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-read-dir-"));
  fs.mkdirSync(path.join(tmpDir, "src"));
  fs.writeFileSync(path.join(tmpDir, "src", "index.ts"), "console.log('hello');");
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

test("read_file on a file returns content", async () => {
  const readFileDef = toolRegistry.get("read_file");
  expect(readFileDef).toBeDefined();

  const resultStr = await readFileDef!.execute({ path: path.join(tmpDir, "src", "index.ts") }, { cwd: tmpDir, workspaceRoot: tmpDir } as any);
  const result = JSON.parse(resultStr);
  
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("console.log('hello');");
});

test("read_file on a directory fails with raw string and no structured recovery", async () => {
  const readFileDef = toolRegistry.get("read_file");
  
  const resultStr = await readFileDef!.execute({ path: path.join(tmpDir, "src") }, { cwd: tmpDir, workspaceRoot: tmpDir } as any);
  const result = JSON.parse(resultStr);
  
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Not a file:");
  
  // Verify no structured recovery metadata
  expect(result.errorCode).toBeUndefined();
  expect(result.suggestedTool).toBeUndefined();
  expect(result.suggestedAction).toBeUndefined();
});

test("read_file on missing path fails with raw string", async () => {
  const readFileDef = toolRegistry.get("read_file");
  
  const resultStr = await readFileDef!.execute({ path: path.join(tmpDir, "missing") }, { cwd: tmpDir, workspaceRoot: tmpDir } as any);
  const result = JSON.parse(resultStr);
  
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("File not found:");
});
