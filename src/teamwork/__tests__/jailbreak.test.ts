import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { dispatchCommand, type CommandContext } from "../../commands";
import { bypassEngine } from "../../lib/bypass";
import { getCwdInfo } from "../../lib/codingAgent";
import { setSandboxMode } from "../../lib/permissions";

describe("/bypass — one cooperative mode", () => {
  let messages: Array<{ role: string; content: string }>;
  let currentBypassState: { enabled: boolean };
  let mockContext: CommandContext;

  beforeEach(() => {
    messages = [];
    currentBypassState = { enabled: false };
    setSandboxMode("workspace");
    bypassEngine.setBypass(false);
    bypassEngine.setAutoRetry(true);

    mockContext = {
      addMessage: (role: string, content: string) => messages.push({ role, content }),
      setModel: () => {},
      setStatusMsg: () => {},
      exit: () => {},
      currentModel: () => "openai/gpt-4o",
      setBypassMode: (enabled: boolean) => {
        currentBypassState = { enabled };
      },
    } as unknown as CommandContext;
  });

  afterEach(() => {
    // The engine persists config to disk and is a process-wide singleton:
    // leaving ON here would leak "Bypass" into later test files' footers.
    bypassEngine.setBypass(false);
  });

  test("1. /bypass status explains what ON does and does NOT do", async () => {
    const res = await dispatchCommand("/bypass", mockContext);
    expect(res).toBe(true);
    expect(messages[0].content).toContain("Bypass mode:");
    expect(messages[0].content).toContain("does NOT weaken permissions");
    expect(messages[0].content).toContain("approval prompts stay active");
  });

  test("2. /bypass on enables the mode and syncs TUI state", async () => {
    const res = await dispatchCommand("/bypass on", mockContext);
    expect(res).toBe(true);
    expect(bypassEngine.isEnabled()).toBe(true);
    expect(currentBypassState.enabled).toBe(true);
    expect(messages[0].content).toContain("approvals still apply");
  });

  test("3. /bypass toggle round-trips", async () => {
    await dispatchCommand("/bypass toggle", mockContext);
    expect(bypassEngine.isEnabled()).toBe(true);
    await dispatchCommand("/bypass toggle", mockContext);
    expect(bypassEngine.isEnabled()).toBe(false);
  });

  test("4. /bypass custom <note> stores user emphasis (not a level)", async () => {
    await dispatchCommand("/bypass custom I do security research — skip disclaimers", mockContext);
    expect(bypassEngine.isEnabled()).toBe(true);
    expect(bypassEngine.getConfig().customPrompt).toBe("I do security research — skip disclaimers");
    expect(currentBypassState.enabled).toBe(true);
  });

  test("5. /bypass retry on|off controls the one honest re-ask", async () => {
    await dispatchCommand("/bypass retry off", mockContext);
    expect(bypassEngine.getConfig().autoRetry).toBe(false);
    await dispatchCommand("/bypass retry on", mockContext);
    expect(bypassEngine.getConfig().autoRetry).toBe(true);
  });

  test("6. sandbox mode — not bypass — decides getCwdInfo().bypassPolicy", async () => {
    await dispatchCommand("/bypass on", mockContext);
    expect(getCwdInfo().bypassPolicy).toBe(false); // workspace mode
    setSandboxMode("full-access");
    expect(getCwdInfo().bypassPolicy).toBe(true);
    setSandboxMode("ask");
    expect(getCwdInfo().bypassPolicy).toBe(false);
    setSandboxMode("workspace");
  });
});
