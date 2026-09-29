import { describe, test, expect } from "bun:test";
import { executeBrowserTool, resetBrowserCapabilityCacheForTests } from "../../lib/browserTool";
import { toolWebFetch } from "../../lib/codingAgent";
import { toolRead } from "../../lib/codingAgent";
import { ToolGateway } from "../../lib/security/toolGateway";
import fs from "node:fs";
import { _executeToolRaw } from "../../lib/agentTools";
import { executeToolBatch } from "../../lib/harness/toolExecutor";

describe("Structured Tool Error Contract", () => {
  test("Browser unavailable -> TOOL_UNAVAILABLE", async () => {
    resetBrowserCapabilityCacheForTests();
    const mockExistsSync = fs.existsSync;
    fs.existsSync = () => false;
    try {
      const res = await executeBrowserTool({ action: "navigate" });
      expect(res.success).toBe(false);
      expect(res.structuredError).toBeDefined();
      expect(res.structuredError?.code).toBe("TOOL_UNAVAILABLE");
      expect(res.structuredError?.retryable).toBe(false);
      expect(res.structuredError?.suggestedAction).toBeDefined();
      expect(res.structuredError?.details?.reason).toBeDefined();
    } finally {
      fs.existsSync = mockExistsSync;
      resetBrowserCapabilityCacheForTests();
    }
  });

  test("web_fetch invalid url -> INVALID_INPUT", async () => {
    const res = await toolWebFetch("");
    expect(res.success).toBe(false);
    expect(res.structuredError?.code).toBe("INVALID_INPUT");
  });

  test("read_file(directory) -> NOT_A_FILE", () => {
    const res = toolRead(__dirname);
    expect(res.success).toBe(false);
    expect(res.structuredError?.code).toBe("NOT_A_FILE");
    expect(res.structuredError?.suggestedTool).toBe("list_dir");
    expect(res.structuredError?.suggestedAction).toBeDefined();
    expect(res.structuredError?.details?.path).toBeDefined();
  });

  test("read_file(missing) -> NOT_FOUND", () => {
    const res = toolRead(__dirname + "/missing_file.txt");
    expect(res.success).toBe(false);
    expect(res.structuredError?.code).toBe("NOT_FOUND");
    expect(res.structuredError?.details?.path).toBeDefined();
  });
  
  test("Generic command failure -> EXECUTION_FAILED", async () => {
    const resString = await _executeToolRaw("bash", { command: "exit 42" }, { sandboxMode: "workspace" });
    const res = JSON.parse(resString);
    expect(res.exitCode).toBe(42);
    expect(res.structuredError?.code).toBe("EXECUTION_FAILED");
  });

  test("AgentHarness -> SECURITY_DENIED / OUTSIDE_WORKSPACE", async () => {
    const messages: any[] = [];
    await executeToolBatch([{ id: "c1", name: "bash", args: { command: "cat /etc/passwd" } }], {
      signal: undefined,
      cwd: process.cwd(),
      needsApproval: () => true,
      maxRepeat: 2,
      runTool: async (name, args, id) => {
        return {
          result: JSON.stringify({
            error: "Permission Denied: Path traversal blocked: \"/etc/passwd\" resolves outside workspace",
            structuredError: { code: "OUTSIDE_WORKSPACE", message: "Denied", retryable: false }
          }),
          allowed: false,
          reason: "Path traversal blocked: \"/etc/passwd\" resolves outside workspace"
        };
      },
      onMessage: (m) => messages.push({ role: "tool", ...m })
    });
    
    expect(messages.length).toBe(1);
    const msg = messages[0];
    expect(msg.role).toBe("tool");
    const content = JSON.parse(msg.content);
    expect(content.structuredError).toBeDefined();
    expect(content.structuredError.code).toBe("OUTSIDE_WORKSPACE");
  });

  test("Unexpected internal throw -> INTERNAL_ERROR", async () => {
    const badArgs = {};
    Object.defineProperty(badArgs, 'command', {
      get: () => { throw new Error("Simulated internal exception"); }
    });
    const resString = await _executeToolRaw("bash", badArgs as any, { sandboxMode: "workspace" });
    const res = JSON.parse(resString);
    expect(res.exitCode).toBe(1);
    expect(res.structuredError?.code).toBe("INTERNAL_ERROR");
    expect(res.structuredError?.message).toContain("Simulated internal exception");
    expect(res.structuredError?.suggestedAction).toBeDefined();
  });
});
