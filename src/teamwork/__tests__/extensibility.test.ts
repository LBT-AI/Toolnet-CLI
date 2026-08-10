import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadLocalSkills, getSkillPrompt, parseSkillFile } from "../../lib/skillsLoader";
import { loadLocalMcpConfig, getLocalMcpServers } from "../../lib/mcpRunner";
import { skillsCommand } from "../../commands/skills";

describe("Extensibility Features (Skills & MCP Loader)", () => {
  const testRoot = path.resolve(process.cwd(), "test_extensibility_sandbox");

  beforeEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(testRoot, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  describe("skillsLoader", () => {
    test("parseSkillFile extracts name, description, and markdown instructions", () => {
      const content = `---
name: "code-review"
description: "Automated code reviewer skill"
---
# Instructions
Review the provided diff carefully.`;

      const parsed = parseSkillFile(content, "/path/to/code-review/SKILL.md");
      expect(parsed.id).toBe("code-review");
      expect(parsed.name).toBe("code-review");
      expect(parsed.description).toBe("Automated code reviewer skill");
      expect(parsed.instructions).toBe("# Instructions\nReview the provided diff carefully.");
    });

    test("loadLocalSkills scans .gemini/skills, .toolnet/skills, and cli/skills", () => {
      const geminiSkillDir = path.join(testRoot, ".gemini", "skills", "linter");
      const toolnetSkillDir = path.join(testRoot, ".toolnet", "skills", "security");
      const cliSkillDir = path.join(testRoot, "cli", "skills", "db-helper");

      fs.mkdirSync(geminiSkillDir, { recursive: true });
      fs.mkdirSync(toolnetSkillDir, { recursive: true });
      fs.mkdirSync(cliSkillDir, { recursive: true });

      fs.writeFileSync(
        path.join(geminiSkillDir, "SKILL.md"),
        `---\nname: Linter Skill\ndescription: Lints TypeScript code\n---\nRun tsc and eslint.`,
        "utf8"
      );

      fs.writeFileSync(
        path.join(toolnetSkillDir, "SKILL.md"),
        `---\nname: Security Auditor\ndescription: Audit dependencies\n---\nCheck for vulnerabilities.`,
        "utf8"
      );

      fs.writeFileSync(
        path.join(cliSkillDir, "SKILL.md"),
        `---\nname: DB Helper\ndescription: Sqlite helper\n---\nQuery local database.`,
        "utf8"
      );

      const skills = loadLocalSkills(testRoot);
      expect(skills.length).toBe(3);

      const skillNames = skills.map(s => s.name);
      expect(skillNames).toContain("Linter Skill");
      expect(skillNames).toContain("Security Auditor");
      expect(skillNames).toContain("DB Helper");
    });

    test("getSkillPrompt returns instructions for matching skill", () => {
      const geminiSkillDir = path.join(testRoot, ".gemini", "skills", "tester");
      fs.mkdirSync(geminiSkillDir, { recursive: true });
      fs.writeFileSync(
        path.join(geminiSkillDir, "SKILL.md"),
        `---\nname: Unit Tester\ndescription: Runs unit tests\n---\nExecute bun test.`,
        "utf8"
      );

      const prompt = getSkillPrompt("Unit Tester", testRoot);
      expect(prompt).toBe("Execute bun test.");

      const notFound = getSkillPrompt("nonexistent-skill", testRoot);
      expect(notFound).toBeNull();
    });

    test("loadLocalSkills handles non-existent directories gracefully", () => {
      const emptyDir = path.join(testRoot, "empty");
      fs.mkdirSync(emptyDir, { recursive: true });
      const skills = loadLocalSkills(emptyDir);
      expect(skills).toEqual([]);
    });
  });

  describe("mcpRunner", () => {
    test("loadLocalMcpConfig loads stdio server configs from mcp.json", () => {
      const mcpContent = {
        mcpServers: {
          sqlite: {
            command: "uvx",
            args: ["mcp-server-sqlite", "--db-path", "./test.db"],
            env: { DEBUG: "true" }
          }
        }
      };

      fs.writeFileSync(
        path.join(testRoot, "mcp.json"),
        JSON.stringify(mcpContent, null, 2),
        "utf8"
      );

      const config = loadLocalMcpConfig(testRoot);
      expect(config["sqlite"]).toBeDefined();
      expect(config["sqlite"].command).toBe("uvx");
      expect(config["sqlite"].args).toEqual(["mcp-server-sqlite", "--db-path", "./test.db"]);
      expect(config["sqlite"].env).toEqual({ DEBUG: "true" });
    });

    test("loadLocalMcpConfig loads stdio server configs from .gemini/mcp.json", () => {
      const geminiDir = path.join(testRoot, ".gemini");
      fs.mkdirSync(geminiDir, { recursive: true });

      const mcpContent = {
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
          }
        }
      };

      fs.writeFileSync(
        path.join(geminiDir, "mcp.json"),
        JSON.stringify(mcpContent, null, 2),
        "utf8"
      );

      const config = loadLocalMcpConfig(testRoot);
      expect(config["filesystem"]).toBeDefined();
      expect(config["filesystem"].command).toBe("npx");
    });

    test("getLocalMcpServers returns server details with source path", () => {
      const geminiDir = path.join(testRoot, ".gemini");
      fs.mkdirSync(geminiDir, { recursive: true });

      const mcpContent = {
        mcpServers: {
          fetch: {
            command: "uvx",
            args: ["mcp-server-fetch"]
          }
        }
      };

      const filePath = path.join(geminiDir, "mcp.json");
      fs.writeFileSync(filePath, JSON.stringify(mcpContent, null, 2), "utf8");

      const servers = getLocalMcpServers(testRoot);
      expect(servers.length).toBe(1);
      expect(servers[0].name).toBe("fetch");
      expect(servers[0].config.command).toBe("uvx");
      expect(servers[0].sourceFile).toBe(filePath);
    });

    test("handles malformed mcp.json gracefully", () => {
      fs.writeFileSync(path.join(testRoot, "mcp.json"), "{ invalid json", "utf8");
      const config = loadLocalMcpConfig(testRoot);
      expect(config).toEqual({});
    });
  });

  describe("skillsCommand handler integration", () => {
    test("skillsCommand list displays built-in skills", async () => {
      let output = "";
      const ctxMock: any = {
        addMessage: (_role: string, msg: string) => {
          output += msg + "\n";
        }
      };

      await skillsCommand.handler([], ctxMock);
      expect(output).toContain("Skills (");
      expect(output).toContain("ToolNet API (Entry)");
      expect(output).toContain("Chat");
    });
  });
});
