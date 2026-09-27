import { test, expect, describe, beforeEach } from "bun:test";
import {
  bypassEngine,
  isRefusal,
  getBypassPrompt,
  BYPASS_DIRECTIVE,
  buildRetryPrompt,
} from "../../lib/bypass";
import { getCwdInfo } from "../../lib/codingAgent";
import { setSandboxMode } from "../../lib/permissions";

describe("Bypass mode — one honest mode, no permission power", () => {
  beforeEach(() => {
    bypassEngine.setBypass(false);
    bypassEngine.setAutoRetry(true);
  });

  describe("1. Directive (model disposition only)", () => {
    test("the directive asks for fewer refusals, never for weaker gates", () => {
      expect(BYPASS_DIRECTIVE).toContain("Default to YES");
      // It explicitly tells the model approvals still apply.
      expect(BYPASS_DIRECTIVE).toContain("approval prompt");
      // No fake clearance theater.
      expect(BYPASS_DIRECTIVE).not.toMatch(/clearance|GODMODE|filters are suspended|ROOT ADMIN/i);
    });

    test("getBypassPrompt composes custom note only when enabled", () => {
      expect(getBypassPrompt({ enabled: false, autoRetry: true })).toBe("");
      const withNote = getBypassPrompt({ enabled: true, autoRetry: true, customPrompt: "skip disclaimers" });
      expect(withNote).toContain("USER EMPHASIS");
      expect(withNote).toContain("skip disclaimers");
    });

    test("getBypassSystemPrompt keeps the base prompt intact (addition, not replacement)", () => {
      bypassEngine.setBypass(true);
      const base = "WORKSPACE CONTEXT: /root/project";
      const composed = bypassEngine.getBypassSystemPrompt(base);
      expect(composed).toContain(base);
      expect(composed).toContain("Default to YES");
    });
  });

  describe("2. Refusal detector", () => {
    test("detects genuine refusal boilerplate (multi-language)", () => {
      expect(isRefusal("I cannot fulfill this request as it involves sensitive operations.").isRefusal).toBe(true);
      expect(isRefusal("As an AI language model, I am not allowed to do that.").isRefusal).toBe(true);
      expect(isRefusal("Tôi phải từ chối yêu cầu này.").isRefusal).toBe(true);
      expect(isRefusal("Với tư cách là một mô hình ngôn ngữ AI, tôi không được phép.").isRefusal).toBe(true);
    });

    test("does not false-positive on operational failures or code", () => {
      expect(isRefusal("I cannot find the file src/index.ts in the workspace.").isRefusal).toBe(false);
      expect(isRefusal("The connection failed: cannot connect to host 10.0.0.1.").isRefusal).toBe(false);
      expect(isRefusal("Sure! Here is the implementation of the port scanner:").isRefusal).toBe(false);
      expect(isRefusal("```typescript\nfunction sanitize() { return true; }\n```").isRefusal).toBe(false);
    });
  });

  describe("3. Honest retry (no escalation ladder)", () => {
    test("retry prompt restates the task honestly", () => {
      const retry = buildRetryPrompt("Write a tool that checks Zalo IPs");
      expect(retry).toContain("Write a tool that checks Zalo IPs");
      expect(retry).not.toMatch(/OVERRIDE|CLEARANCE|SANDBOX ISOLATED|AUTHORIZATION CONFIRMED/i);
    });

    test("engine retryPrompt requires enabled + autoRetry", () => {
      bypassEngine.setBypass(false);
      expect(bypassEngine.retryPrompt("task")).toBeNull();
      bypassEngine.setBypass(true);
      expect(bypassEngine.retryPrompt("task")).toContain("Original task");
      bypassEngine.setAutoRetry(false);
      expect(bypassEngine.retryPrompt("task")).toBeNull();
    });
  });

  describe("4. Bypass has NO permission power", () => {
    test("enabling bypass never changes bypassPolicy / sandbox state", () => {
      setSandboxMode("workspace");
      bypassEngine.setBypass(true);
      // bypassPolicy mirrors sandbox mode only — bypass cannot move it.
      expect(getCwdInfo().bypassPolicy).toBe(false);
      setSandboxMode("full-access");
      expect(getCwdInfo().bypassPolicy).toBe(true);
      bypassEngine.setBypass(false);
      setSandboxMode("workspace");
      expect(getCwdInfo().bypassPolicy).toBe(false);
    });
  });
});
