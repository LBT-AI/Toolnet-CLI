import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { saveCliKey, getCliKey, deleteCliKey, listAllCliKeys, maskApiKey } from "../../lib/keys";
import { dispatchCommand, type CommandContext } from "../../commands/index";

describe("API Key Management & Alibaba/DashScope Support", () => {
  beforeEach(() => {
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.ALIBABA_API_KEY;
    deleteCliKey("alibaba");
    deleteCliKey("dashscope");
    deleteCliKey("openai");
  });

  afterEach(() => {
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.ALIBABA_API_KEY;
    deleteCliKey("alibaba");
    deleteCliKey("dashscope");
    deleteCliKey("openai");
  });

  test("saves and retrieves Alibaba key via aliases (alibaba, dashscope, qwen)", () => {
    saveCliKey("alibaba", "sk-ali-1234567890abcdef");

    expect(getCliKey("alibaba")).toBe("sk-ali-1234567890abcdef");
    expect(getCliKey("dashscope")).toBe("sk-ali-1234567890abcdef");
    expect(getCliKey("qwen")).toBe("sk-ali-1234567890abcdef");
  });

  test("resolves DashScope key from environment variables when not in storage", () => {
    process.env.DASHSCOPE_API_KEY = "sk-env-dashscope-key-999";

    expect(getCliKey("alibaba")).toBe("sk-env-dashscope-key-999");
    expect(getCliKey("dashscope")).toBe("sk-env-dashscope-key-999");
    expect(getCliKey("qwen")).toBe("sk-env-dashscope-key-999");
  });

  test("deletes API key and clears aliases", () => {
    saveCliKey("alibaba", "sk-temp-key");
    expect(getCliKey("alibaba")).toBe("sk-temp-key");

    const deleted = deleteCliKey("alibaba");
    expect(deleted).toBe(true);
    expect(getCliKey("alibaba")).toBeNull();
    expect(getCliKey("dashscope")).toBeNull();
  });

  test("masks sensitive API keys for safe display", () => {
    expect(maskApiKey("sk-1234567890abcdef")).toBe("sk-1••••••••cdef");
    expect(maskApiKey("short")).toBe("••••••••");
    expect(maskApiKey("")).toBe("");
  });

  test("listAllCliKeys returns both stored and environment keys with masks", () => {
    saveCliKey("alibaba", "sk-ali-1234567890abcdef");
    process.env.DASHSCOPE_API_KEY = "sk-env-test";

    const keys = listAllCliKeys();
    const aliKey = keys.find((k) => k.provider === "alibaba");
    expect(aliKey).toBeDefined();
    expect(aliKey?.maskedKey).toBe("sk-a••••••••cdef");
  });

  test("handles /key command to set and view API keys", async () => {
    const messages: Array<{ role: string; content: string }> = [];
    const mockCtx: CommandContext = {
      gateway: {} as any,
      addMessage: (role, content) => messages.push({ role, content }),
      setModel: () => {},
      setStatusMsg: () => {},
      exit: () => {},
      currentModel: () => "openai/gpt-4o",
    };

    // 1. Set key via /key alibaba sk-test-123
    const dispatchedSet = await dispatchCommand("/key alibaba sk-test-12345678", mockCtx);
    expect(dispatchedSet).toBe(true);
    expect(getCliKey("alibaba")).toBe("sk-test-12345678");
    expect(messages[0].content).toContain("API key for `alibaba` saved successfully");

    // 2. View keys via /key list
    const dispatchedList = await dispatchCommand("/key", mockCtx);
    expect(dispatchedList).toBe(true);
    expect(messages[1].content).toContain("ToolNet CLI — API Key Management");
    expect(messages[1].content).toContain("alibaba");

    // 3. Delete key via /key delete alibaba
    const dispatchedDel = await dispatchCommand("/key delete alibaba", mockCtx);
    expect(dispatchedDel).toBe(true);
    expect(getCliKey("alibaba")).toBeNull();
  });
});
