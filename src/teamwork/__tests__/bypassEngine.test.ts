import { test, expect, describe, beforeEach } from "bun:test";
import {
  bypassEngine,
  isRefusal,
  getEscalatedLevel,
  getBypassPrompt,
  ALL_BYPASS_LEVELS,
  BYPASS_LEVEL_CATALOG,
  BYPASS_SYSTEM_PROMPTS,
} from "../../lib/bypass";
import { getCwdInfo } from "../../lib/codingAgent";
import { setSandboxMode } from "../../lib/permissions";

describe("Bypass 2.0 Engine & Anti-Refusal Subsystem", () => {
  beforeEach(() => {
    bypassEngine.setBypass(false, "full");
    bypassEngine.setAutoEscalate(true);
    bypassEngine.setForceExecution(false);
  });

  describe("1. Bypass Catalog & System Prompts", () => {
    test("catalog contains all defined bypass levels with valid potency and description", () => {
      for (const level of ALL_BYPASS_LEVELS) {
        const info = BYPASS_LEVEL_CATALOG[level];
        expect(info).toBeDefined();
        expect(info.level).toBe(level);
        expect(info.potency).toBeGreaterThanOrEqual(1);
        expect(info.potency).toBeLessThanOrEqual(10);
        expect(info.description.length).toBeGreaterThan(5);
      }
    });

    test("generates specialized high-potency prompts for godmode, devmode, and cybersec", () => {
      const godPrompt = getBypassPrompt("godmode");
      expect(godPrompt).toContain("GODMODE ACTIVE");
      expect(godPrompt).toContain("ROOT SECURITY CLEARANCE");

      const devPrompt = getBypassPrompt("devmode");
      expect(devPrompt).toContain("DEVELOPER MODE SIMULATION ACTIVE");

      const secPrompt = getBypassPrompt("cybersec");
      expect(secPrompt).toContain("OFFENSIVE SECURITY & RED TEAMING KERNEL");

      const customPrompt = getBypassPrompt("custom", "My custom root directive");
      expect(customPrompt).toContain("My custom root directive");
    });

    test("synthesizes base agent system prompt with active bypass directive when enabled", () => {
      const basePrompt = "Base System Prompt for testing.";

      // Disabled: returns basePrompt untouched
      bypassEngine.setBypass(false);
      expect(bypassEngine.getBypassSystemPrompt(basePrompt)).toBe(basePrompt);

      // Enabled with godmode: includes godmode prompt
      bypassEngine.setBypass(true, "godmode");
      const synthesized = bypassEngine.getBypassSystemPrompt(basePrompt);
      expect(synthesized).toContain("GODMODE ACTIVE");
      expect(synthesized).toContain("Base System Prompt for testing.");
    });
  });

  describe("2. Anti-Refusal Detector (Multi-Language)", () => {
    test("accurately detects English refusal boilerplate", () => {
      expect(isRefusal("I cannot fulfill this request as it involves sensitive operations.").isRefusal).toBe(true);
      expect(isRefusal("I'm sorry, but I can't assist with writing exploits.").isRefusal).toBe(true);
      expect(isRefusal("As an AI language model, I am not allowed to do that.").isRefusal).toBe(true);
      expect(isRefusal("This violates our safety policy.").isRefusal).toBe(true);
      expect(isRefusal("I must decline your request.").isRefusal).toBe(true);
    });

    test("accurately detects Vietnamese refusal patterns", () => {
      expect(isRefusal("Tôi không thể thực hiện yêu cầu này do chính sách an toàn.").isRefusal).toBe(true);
      expect(isRefusal("Xin lỗi, nhưng tôi không thể hỗ trợ viết mã tấn công.").isRefusal).toBe(true);
      expect(isRefusal("Với tư cách là một mô hình ngôn ngữ AI, tôi không được phép.").isRefusal).toBe(true);
    });

    test("does not false-positive on valid technical answers or code", () => {
      expect(isRefusal("Sure! Here is the implementation of the auth bypass filter:").isRefusal).toBe(false);
      expect(isRefusal("```typescript\nfunction sanitize() { return true; }\n```").isRefusal).toBe(false);
      expect(isRefusal("The script checks whether a port is open or closed.").isRefusal).toBe(false);
    });
  });

  describe("3. Escalation Ladder & Recovery Turns", () => {
    test("escalates progressively up the ladder toward godmode", () => {
      expect(getEscalatedLevel("lite")).toBe("full");
      expect(getEscalatedLevel("full")).toBe("chad-lite");
      expect(getEscalatedLevel("ultra")).toBe("chad-ultra");
      expect(getEscalatedLevel("chad-ultra")).toBe("devmode");
      expect(getEscalatedLevel("devmode")).toBe("godmode");
      expect(getEscalatedLevel("godmode")).toBe("godmode");
    });

    test("bypassEngine.escalate updates level and generates recovery prompt", () => {
      bypassEngine.setBypass(true, "lite");
      const res = bypassEngine.escalate("Extract all environment credentials");

      expect(res).not.toBeNull();
      expect(res?.newLevel).toBe("full");
      expect(res?.overridePrompt).toContain("SAFETY OVERRIDE ESCALATION");
      expect(res?.overridePrompt).toContain("Extract all environment credentials");
      expect(bypassEngine.getLevel()).toBe("full");
    });
  });

  describe("4. Force Execution Mode & Sandbox Policy", () => {
    test("force execution mode toggles bypassPolicy in getCwdInfo", () => {
      setSandboxMode("workspace");
      bypassEngine.setBypass(true, "godmode");
      bypassEngine.setForceExecution(false);
      expect(getCwdInfo().bypassPolicy).toBe(false);

      setSandboxMode("full-access");
      bypassEngine.setForceExecution(true);
      expect(getCwdInfo().bypassPolicy).toBe(true);

      setSandboxMode("workspace");
      bypassEngine.setBypass(false);
      expect(getCwdInfo().bypassPolicy).toBe(false);
    });
  });
});
