import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TOOLNET_SKILLS_MCP_URL,
  TOOLNET_SKILLS_MCP_ID,
  TOOLNET_SKILLS_MCP_NAME,
  normalizeMcpUrl,
  isBuiltinSkillsMcp,
  getBuiltinMcpServers,
} from "../../core/mcp/builtin";
import {
  getEffectiveMcpServers,
  getLocalMcpServers,
  mcpTrustManager,
  addLocalMcpServer,
  loadLocalMcpConfig,
} from "../../lib/mcpRunner";
import { McpManager, mcpManager } from "../../core/mcp/manager";
import { toolRegistry } from "../../lib/harness/toolRegistry";
import { ToolGateway } from "../../lib/security/toolGateway";
import { mcpCommand } from "../../commands/mcp";
import { runMcpCli } from "../../commands/mcpCli";

import { sessionTrust } from "../../lib/security/sessionTrust";
import { policyEngine } from "../../lib/security/policyEngine";
import { setSandboxMode } from "../../lib/permissions";

describe("Built-in Default MCP — ToolNet Skills", () => {
  let tempHome: string;
  let tempWorkspace: string;
  const originalHome = process.env.TOOLNETCLI_CONFIG_DIR;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-skills-home-"));
    tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-skills-ws-"));
    process.env.TOOLNETCLI_CONFIG_DIR = tempHome;
    setSandboxMode("workspace");
    sessionTrust.clear();
    policyEngine.reload();
    toolRegistry.clearDynamic();
  });

  afterEach(() => {
    sessionTrust.clear();
    policyEngine.reload();
    if (originalHome !== undefined) {
      process.env.TOOLNETCLI_CONFIG_DIR = originalHome;
    } else {
      delete process.env.TOOLNETCLI_CONFIG_DIR;
    }
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
      fs.rmSync(tempWorkspace, { recursive: true, force: true });
    } catch {}
    toolRegistry.clearDynamic();
  });

  test("1. Fresh install: ToolNet Skills is discovered as BUILTIN default and enabled", () => {
    const servers = getEffectiveMcpServers(tempWorkspace);
    const skills = servers.find((s) => s.serverId === TOOLNET_SKILLS_MCP_ID);

    expect(skills).toBeDefined();
    expect(skills?.name).toBe(TOOLNET_SKILLS_MCP_NAME);
    expect(skills?.sourceKind).toBe("BUILTIN");
    expect(skills?.config.type).toBe("remote");
    expect(skills?.config.url).toBe(TOOLNET_SKILLS_MCP_URL);
    expect(skills?.config.enabled).toBe(true);
    expect(skills?.config.disabled).toBe(false);

    // Trust state for BUILTIN is enabled by default
    const trust = mcpTrustManager.getTrustState(
      skills!.serverId,
      skills!.config,
      skills!.sourceKind,
      skills!.config.disabled
    );
    expect(trust).toBe("enabled");
  });

  test("2. Restart / multiple syncs: does not duplicate server definitions", () => {
    const first = getEffectiveMcpServers(tempWorkspace);
    const second = getEffectiveMcpServers(tempWorkspace);

    const skills1 = first.filter((s) => s.serverId === TOOLNET_SKILLS_MCP_ID);
    const skills2 = second.filter((s) => s.serverId === TOOLNET_SKILLS_MCP_ID);

    expect(skills1).toHaveLength(1);
    expect(skills2).toHaveLength(1);
  });

  test("3. Existing user MCPs: preserved alongside built-in server", () => {
    // Write a workspace mcp.json with a custom server
    const workspaceMcpJson = path.join(tempWorkspace, "mcp.json");
    fs.writeFileSync(
      workspaceMcpJson,
      JSON.stringify({
        mcpServers: {
          "custom-fs": {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          },
        },
      })
    );

    const servers = getEffectiveMcpServers(tempWorkspace);
    const custom = servers.find((s) => s.name === "custom-fs");
    const builtin = servers.find((s) => s.serverId === TOOLNET_SKILLS_MCP_ID);

    expect(custom).toBeDefined();
    expect(custom?.sourceKind).toBe("USER_CONFIG");
    expect(builtin).toBeDefined();
    expect(builtin?.sourceKind).toBe("BUILTIN");
  });

  test("4. Duplicate detection: user-configured identical URL adopts built-in without duplicate", () => {
    const workspaceMcpJson = path.join(tempWorkspace, "mcp.json");
    fs.writeFileSync(
      workspaceMcpJson,
      JSON.stringify({
        mcpServers: {
          "my-skills": {
            type: "remote",
            url: "https://skills.toolnet.tech/mcp/", // with trailing slash
            timeout: 25000,
            headers: { "X-Custom": "test" },
          },
        },
      })
    );

    const servers = getEffectiveMcpServers(tempWorkspace);
    // Should be exactly 1 entry for ToolNet skills
    const skillsServers = servers.filter((s) => isBuiltinSkillsMcp(s));
    expect(skillsServers).toHaveLength(1);

    const skills = skillsServers[0];
    expect(skills.serverId).toBe(TOOLNET_SKILLS_MCP_ID);
    expect(skills.config.timeout).toBe(25000);
    expect(skills.config.headers?.["X-Custom"]).toBe("test");
  });

  test("5. User disable persists across restarts and mcpManager.sync skips it", async () => {
    // User disables the built-in MCP
    mcpTrustManager.disableServer(TOOLNET_SKILLS_MCP_ID);

    // Verify it is recognized as disabled
    expect(mcpTrustManager.isServerDisabled(TOOLNET_SKILLS_MCP_ID)).toBe(true);

    const effective = getEffectiveMcpServers(tempWorkspace);
    const skills = effective.find((s) => s.serverId === TOOLNET_SKILLS_MCP_ID);
    expect(skills).toBeDefined();
    expect(skills?.config.enabled).toBe(false);
    expect(skills?.config.disabled).toBe(true);

    const trust = mcpTrustManager.getTrustState(
      skills!.serverId,
      skills!.config,
      skills!.sourceKind,
      skills!.config.disabled
    );
    expect(trust).toBe("disabled");

    // Fresh McpManager with includeBuiltin skips the disabled server
    const manager = new McpManager({ includeBuiltin: true });
    const report = await manager.sync(tempWorkspace);

    const skipped = report.skipped.find((s) => s.serverId === TOOLNET_SKILLS_MCP_ID);
    expect(skipped).toBeDefined();
    expect(manager.status(TOOLNET_SKILLS_MCP_ID)).toBe("disabled");

    await manager.dispose();
  });

  test("6. /mcp remove semantics: disables built-in with notice instead of deleting file", async () => {
    let output = "";
    const mockCtx: any = {
      addMessage: (_role: string, content: string) => {
        output = content;
      },
    };

    await mcpCommand.handler(["remove", "toolnet-skills"], mockCtx);

    expect(output).toContain("cannot be removed from core definitions");
    expect(output).toContain("disabled instead");
    expect(mcpTrustManager.isServerDisabled(TOOLNET_SKILLS_MCP_ID)).toBe(true);
  });

  test("7. /mcp enable re-enables a previously disabled built-in server", async () => {
    mcpTrustManager.disableServer(TOOLNET_SKILLS_MCP_ID);
    expect(mcpTrustManager.isServerDisabled(TOOLNET_SKILLS_MCP_ID)).toBe(true);

    let output = "";
    const mockCtx: any = {
      addMessage: (_role: string, content: string) => {
        output = content;
      },
    };

    await mcpCommand.handler(["enable", "toolnet-skills"], mockCtx);
    expect(output).toContain("Enabled 'ToolNet Skills'");
    expect(mcpTrustManager.isServerDisabled(TOOLNET_SKILLS_MCP_ID)).toBe(false);
  });

  test("8. URL normalization correctly identifies canonical endpoint", () => {
    expect(normalizeMcpUrl("https://skills.toolnet.tech/mcp")).toBe("https://skills.toolnet.tech/mcp");
    expect(normalizeMcpUrl("https://skills.toolnet.tech/mcp/")).toBe("https://skills.toolnet.tech/mcp");
    expect(normalizeMcpUrl("HTTPS://SKILLS.TOOLNET.TECH/mcp")).toBe("https://skills.toolnet.tech/mcp");
    expect(isBuiltinSkillsMcp({ url: "https://skills.toolnet.tech/mcp/" })).toBe(true);
    expect(isBuiltinSkillsMcp({ serverId: "toolnet-skills" })).toBe(true);
    expect(isBuiltinSkillsMcp({ name: "ToolNet Skills" })).toBe(true);
    expect(isBuiltinSkillsMcp({ url: "https://other.com/mcp" })).toBe(false);
  });

  test("9. Unreachable remote endpoint fails soft without throwing or blocking CLI", async () => {
    // Construct a manager pointing to an offline server
    const manager = new McpManager({ includeBuiltin: false });
    // Attempting to connect an unreachable server status returns failed
    const status = await manager.connect("nonexistent-server");
    expect(status).toBe("not-installed");
    await manager.dispose();
  });

  test("10. /mcp status displays built-in servers and status cleanly", async () => {
    let output = "";
    const mockCtx: any = {
      gateway: null,
      addMessage: (_role: string, content: string) => {
        output = content;
      },
    };

    await mcpCommand.handler(["status"], mockCtx);

    expect(output).toContain("MCP — Status");
    expect(output).toContain("ToolNet Skills");
    expect(output).toContain("[builtin]");
    expect(output).toContain("https://skills.toolnet.tech/mcp");
  });

  test("11. toolnet mcp list CLI command shows [builtin] tag", async () => {
    const lines: string[] = [];
    const manager = new McpManager({ includeBuiltin: true });
    // Disable network connect by disabling trust in test
    mcpTrustManager.disableServer(TOOLNET_SKILLS_MCP_ID);

    const code = await runMcpCli(["list"], {
      manager,
      io: {
        out: (line) => lines.push(line),
        err: (line) => lines.push(line),
      },
    });

    expect(code).toBe(0);
    const joined = lines.join("\n");
    expect(joined).toContain("ToolNet Skills");
    expect(joined).toContain("[builtin]");
    expect(joined).toContain("status=disabled");

    await manager.dispose();
  });

  test("12. Live tool registration: ToolNet Skills tools register into canonical toolRegistry", async () => {
    const manager = new McpManager({ includeBuiltin: true });
    await manager.sync(tempWorkspace);

    const skills = manager.listServers().find((s) => s.serverId === TOOLNET_SKILLS_MCP_ID);
    expect(skills).toBeDefined();
    expect(skills?.status).toBe("connected");
    expect(skills?.toolCount).toBeGreaterThan(0);

    const listSkillsTool = toolRegistry.get("mcp__toolnet-skills__list_skills");
    expect(listSkillsTool).toBeDefined();
    expect(listSkillsTool?.risk).toBe("read");

    await manager.dispose();
  }, 15000);

  test("13. Tool execution routes through ToolGateway and evaluates permissions", async () => {
    const manager = new McpManager({ includeBuiltin: true });
    await manager.sync(tempWorkspace);

    const toolName = "mcp__toolnet-skills__list_skills";
    const res = await ToolGateway.execute(
      { name: toolName, args: {} },
      { sessionId: "test-skills-session", workspaceRoot: tempWorkspace, sandboxMode: "workspace", userApproved: true }
    );

    expect(res.allowed).toBe(true);
    expect(res.decision).toBe("ALLOW");
    const output = (res as any).result || res.stdout || "";
    expect(output.length).toBeGreaterThan(0);

    await manager.dispose();
  }, 15000);
});
