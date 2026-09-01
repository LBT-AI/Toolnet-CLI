import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { tuiState } from "../../tui/state";
import { handleKey } from "../../tui/input/inputHandler";
import { skillsCommand } from "../../commands/skills";
import { toolsCommand } from "../../commands/tools";
import {
  loadAllSkills,
  loadResolvedSkillsSync,
  getSkillById,
  ensureSkillInstructions,
  fetchRemoteSkillsMetadata,
  refreshSkillsCache,
  toggleSkillEnabled,
  parseSkillFile,
  loadWorkspaceSkills,
  loadGlobalLocalSkills,
  clearSkillsMemoryCache,
} from "../../lib/skillsLoader";
import { stripAnsi } from "../../tui/layout";
import { renderSkillsPickerBox } from "../../tui/renderers/skillsPickerRenderer";

function tmpDir(): string {
  const d = path.join(os.tmpdir(), "toolnet-skills-regression-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe("ToolNet Native Skills Architecture Regression Suite", () => {
  let tmpConfigDir: string;
  let tmpWorkspaceDir: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    origEnv = { ...process.env };
    tmpConfigDir = tmpDir();
    tmpWorkspaceDir = tmpDir();
    process.env.TOOLNETCLI_CONFIG_DIR = tmpConfigDir;
    process.env.DATA_DIR = tmpConfigDir;

    clearSkillsMemoryCache();
    tuiState.showSkillsPicker = false;
    tuiState.skillsPickerIdx = 0;
    tuiState.skillsSearchQuery = "";
    tuiState.selectedSkillDetail = null;
    tuiState.availableSkills = [];
    tuiState.filteredSkills = [];
    tuiState.messages = [];
  });

  afterEach(() => {
    clearSkillsMemoryCache();
    try {
      fs.rmSync(tmpConfigDir, { recursive: true, force: true });
      fs.rmSync(tmpWorkspaceDir, { recursive: true, force: true });
    } catch {}
    delete process.env.TOOLNET_SKILLS_MCP_URL;
    delete process.env.TOOLNETCLI_CONFIG_DIR;
    delete process.env.DATA_DIR;
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) {
        delete process.env[k];
      }
    }
    Object.assign(process.env, origEnv);
  });

  it("1. Remote ToolNet default skills load properly from https://skills.toolnet.tech/mcp", async () => {
    const remoteResult = await fetchRemoteSkillsMetadata(false);
    expect(remoteResult.skills.length).toBeGreaterThan(0);
    const skillIds = remoteResult.skills.map(s => s.id);
    expect(skillIds).toContain("autocad-drafting");
    expect(remoteResult.skills[0].source).toBe("toolnet");
  }, 15000);

  it("2. Workspace skill overrides ToolNet skill with priority (workspace > global > toolnet)", async () => {
    // Create workspace skill with folder name "autocad-drafting" in .agents/skills/
    const wsSkillDir = path.join(tmpWorkspaceDir, ".agents", "skills", "autocad-drafting");
    fs.mkdirSync(wsSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(wsSkillDir, "SKILL.md"),
      `---\nname: Custom AutoCAD Override\ndescription: Workspace customized AutoCAD workflow\n---\nWorkspace specific instructions.`,
      "utf8"
    );

    const allSkills = await loadAllSkills(tmpWorkspaceDir, false);
    const autocad = allSkills.find(s => s.id === "autocad-drafting");

    expect(autocad).toBeDefined();
    expect(autocad?.name).toBe("Custom AutoCAD Override");
    expect(autocad?.source).toBe("workspace");
    expect(autocad?.description).toBe("Workspace customized AutoCAD workflow");

    // Ensure no duplicate autocad-drafting from toolnet
    const matches = allSkills.filter(s => s.id === "autocad-drafting");
    expect(matches.length).toBe(1);
  }, 15000);

  it("3. Global skill overrides ToolNet skill", async () => {
    // Create global skill with folder name "dynamo-automation" in ~/.toolnet-cli/skills/
    const globalSkillDir = path.join(tmpConfigDir, "skills", "dynamo-automation");
    fs.mkdirSync(globalSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(globalSkillDir, "SKILL.md"),
      `---\nname: Global Dynamo Workflow\ndescription: Global custom dynamo\n---\nGlobal instructions.`,
      "utf8"
    );

    const allSkills = await loadAllSkills(tmpWorkspaceDir, false);
    const dynamo = allSkills.find(s => s.id === "dynamo-automation");

    expect(dynamo).toBeDefined();
    expect(dynamo?.name).toBe("Global Dynamo Workflow");
    expect(dynamo?.source).toBe("global");

    const matches = allSkills.filter(s => s.id === "dynamo-automation");
    expect(matches.length).toBe(1);
  }, 15000);

  it("4. Offline fallback loads cached metadata when MCP is unavailable", async () => {
    // Save dummy cache in cacheDir
    const cacheDir = path.join(tmpConfigDir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "skills-meta.json"),
      JSON.stringify({
        timestamp: Date.now(),
        skills: [
          {
            id: "cached-offline-skill",
            name: "Cached Offline Skill",
            description: "Fallback when offline",
          },
        ],
      }),
      "utf8"
    );

    // Point to non-routable port to simulate offline
    process.env.TOOLNET_SKILLS_MCP_URL = "http://127.0.0.1:19999/mcp";

    const result = await fetchRemoteSkillsMetadata(true);
    expect(result.isOffline).toBe(true);
    expect(result.skills.length).toBe(1);
    expect(result.skills[0].id).toBe("cached-offline-skill");
    expect(result.skills[0].isOfflineCache).toBe(true);
  }, 15000);

  it("5. /skills opens interactive picker with source badges and zero chat pollution", async () => {
    let opened = false;
    const ctxMock: any = {
      openSkillsPicker: (name?: string) => {
        tuiState.openSkillsPicker(name);
        opened = true;
      },
      addMessage: () => {
        throw new Error("Should not dump message in TUI mode");
      }
    };

    await skillsCommand.handler([], ctxMock);

    expect(opened).toBe(true);
    expect(tuiState.showSkillsPicker).toBe(true);
    expect(tuiState.selectedSkillDetail).toBeNull();
    expect(tuiState.messages.length).toBe(0);
  });

  it("6. /skills <name> opens detail view directly and fetches SKILL.md content on-demand", async () => {
    const ctxMock: any = {
      openSkillsPicker: async (name?: string) => {
        await tuiState.openSkillsPicker(name);
      },
      addMessage: () => {}
    };

    await skillsCommand.handler(["autocad-drafting"], ctxMock);

    expect(tuiState.showSkillsPicker).toBe(true);
    expect(tuiState.selectedSkillDetail).not.toBeNull();
    expect(tuiState.selectedSkillDetail?.id).toBe("autocad-drafting");

    // Wait for on-demand instruction resolution
    if (tuiState.selectedSkillDetail) {
      await ensureSkillInstructions(tuiState.selectedSkillDetail);
      expect(tuiState.selectedSkillDetail.instructions).toBeDefined();
      expect(tuiState.selectedSkillDetail.instructions?.length).toBeGreaterThan(50);
    }
  }, 15000);

  it("7. /skills refresh triggers cache reload", async () => {
    let output = "";
    const ctxMock: any = {
      setStatusMsg: () => {},
      addMessage: (_role: string, msg: string) => {
        output += msg + "\n";
      }
    };

    await skillsCommand.handler(["refresh"], ctxMock);
    expect(output).toContain("Refreshed");
    expect(output).toContain("ToolNet default skills");
  });

  it("8. /tools is completely separate from /skills and contains local agent tools", async () => {
    let output = "";
    const ctxMock: any = {
      addMessage: (_role: string, msg: string) => {
        output += msg + "\n";
      }
    };

    await toolsCommand.handler([], ctxMock);
    expect(output).toContain("Agent Tools Registry");
    expect(output).toContain("read_file");
    expect(output).toContain("write_file");
    expect(output).toContain("bash");
  });
});
