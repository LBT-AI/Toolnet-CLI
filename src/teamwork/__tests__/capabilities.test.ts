import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import { securityEngine, policyEngine } from "../../lib/security";
import { setSandboxMode } from "../../lib/permissions";
import { dispatchCommand, type CommandContext } from "../../commands/index";

describe("8 Granular Action Capabilities Security Matrix", () => {
  const cwd = process.cwd();

  beforeEach(() => {
    setSandboxMode("workspace");
    policyEngine.reload();
  });

  afterEach(() => {
    setSandboxMode("ask");
    policyEngine.reload();
  });

  test("1. READ, CREATE, MODIFY are auto-allowed in workspace sandbox", () => {
    const projectRoot = path.resolve(__dirname, "../../..");
    const pkgPath = path.resolve(projectRoot, "package.json");

    // READ
    const readCheck = securityEngine.evaluate("read_file", { path: pkgPath }, "workspace", projectRoot, projectRoot);
    expect(readCheck.allowed).toBe(true);
    expect(readCheck.capability).toBe("READ");

    // CREATE (new non-existent file)
    const createCheck = securityEngine.evaluate("write_file", { path: "new_file_123.ts", content: "console.log('hi');" }, "workspace", projectRoot, projectRoot);
    expect(createCheck.allowed).toBe(true);
    expect(createCheck.capability).toBe("CREATE");

    // MODIFY (existing file)
    const modifyCheck = securityEngine.evaluate("write_file", { path: pkgPath, content: "{\"name\":\"toolnetcli\"}" }, "workspace", projectRoot, projectRoot);
    expect(modifyCheck.allowed).toBe(true);
    expect(modifyCheck.capability).toBe("MODIFY");
  });

  test("2. DELETE is blocked in workspace mode by default capability policy", () => {
    const rmCheck = securityEngine.evaluate("shell", { command: "rm -rf temp_dir" }, "workspace", cwd, cwd);
    expect(rmCheck.allowed).toBe(false);
    expect(rmCheck.capability).toBe("DELETE");
  });

  test("3. RESET (git reset --hard, clean) is blocked in workspace mode", () => {
    const resetCheck = securityEngine.evaluate("shell", { command: "git reset --hard HEAD~1" }, "workspace", cwd, cwd);
    expect(resetCheck.allowed).toBe(false);
    expect(resetCheck.capability).toBe("RESET");
  });

  test("4. SYSTEM (sudo, shutdown, reboot) is blocked in workspace mode", () => {
    const sysCheck = securityEngine.evaluate("shell", { command: "sudo systemctl restart nginx" }, "workspace", cwd, cwd);
    expect(sysCheck.allowed).toBe(false);
    expect(sysCheck.capability).toBe("SYSTEM");
  });

  test("5. /sandbox grant and revoke allows dynamic capability control", async () => {
    const messages: Array<{ role: string; content: string }> = [];
    const mockCtx: CommandContext = {
      gateway: {} as any,
      addMessage: (role, content) => messages.push({ role, content }),
      setModel: () => {},
      setStatusMsg: () => {},
      exit: () => {},
      currentModel: () => "openai/gpt-4o",
    };

    // 1. Grant DELETE
    await dispatchCommand("/sandbox grant delete", mockCtx);
    expect(policyEngine.isCapabilityAllowed("DELETE")).toBe(true);
    expect(messages[0].content).toContain("DELETE** has been **GRANTED**");

    // 2. Revoke DELETE
    await dispatchCommand("/sandbox revoke delete", mockCtx);
    expect(policyEngine.isCapabilityAllowed("DELETE")).toBe(false);
    expect(messages[1].content).toContain("DELETE** has been **LOCKED**");
  });

  test("6. /sandbox status outputs 8 Granular Capabilities table", async () => {
    const messages: Array<{ role: string; content: string }> = [];
    const mockCtx: CommandContext = {
      gateway: {} as any,
      addMessage: (role, content) => messages.push({ role, content }),
      setModel: () => {},
      setStatusMsg: () => {},
      exit: () => {},
      currentModel: () => "openai/gpt-4o",
    };

    await dispatchCommand("/sandbox status", mockCtx);
    expect(messages.length).toBe(1);
    expect(messages[0].content).toContain("8 Granular Action Capabilities");
    expect(messages[0].content).toContain("READ");
    expect(messages[0].content).toContain("CREATE");
    expect(messages[0].content).toContain("MODIFY");
    expect(messages[0].content).toContain("DELETE");
    expect(messages[0].content).toContain("EXECUTE");
    expect(messages[0].content).toContain("RESET");
    expect(messages[0].content).toContain("NETWORK");
    expect(messages[0].content).toContain("SYSTEM");
  });
});
