import { describe, it, expect } from "bun:test";
import { getSubagentRolePrompt } from "../subagentRuntime";
import fs from "node:fs";
import path from "node:path";

describe("Subagent Custom Personas", () => {
  it("returns default prompt for standard roles", () => {
    const prompt = getSubagentRolePrompt("CODER" as any, "Refactor database queries");
    expect(prompt).toContain("ToolNet Sub-Agent [CODER]");
    expect(prompt).toContain("Refactor database queries");
  });

  it("loads and applies custom persona from .toolnet/personas.json when present", () => {
    const toolnetDir = path.join(process.cwd(), ".toolnet");
    const personasPath = path.join(toolnetDir, "personas.json");
    if (!fs.existsSync(toolnetDir)) fs.mkdirSync(toolnetDir, { recursive: true });

    try {
      fs.writeFileSync(personasPath, JSON.stringify({
        SECURITY_AUDITOR: "You are ToolNet Specialized Security Auditor. Audit vulnerabilities and verify hash chains.",
      }), "utf8");

      const prompt = getSubagentRolePrompt("SECURITY_AUDITOR" as any, "Audit token authentication");
      expect(prompt).toContain("Specialized Security Auditor");
    } finally {
      if (fs.existsSync(personasPath)) fs.unlinkSync(personasPath);
    }
  });
});
