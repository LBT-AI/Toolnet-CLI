import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  disabled?: boolean;
}

export interface LocalMcpServer {
  name: string;
  config: McpServerConfig;
  sourceFile: string;
}

export interface McpToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
  serverName: string;
  originalName: string;
}

export interface ActiveMcpClient {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: McpToolDefinition[];
}

export interface McpManagerStatus {
  connectedServers: string[];
  totalTools: number;
  failedServers: Array<{ name: string; error: string }>;
}

const activeClientsMap = new Map<string, ActiveMcpClient>();
const toolRoutingMap = new Map<string, { serverName: string; originalName: string }>();

/**
 * Loads stdio MCP configurations from mcp.json or .gemini/mcp.json or .toolnet/mcp.json.
 * Supports both standard Claude Desktop style `{ "mcpServers": { "name": { "command": ... } } }`
 * and direct map formats `{ "name": { "command": ... } }`.
 * @param baseDir Optional base directory (defaults to process.cwd()).
 */
export function loadLocalMcpConfig(baseDir: string = process.cwd()): Record<string, McpServerConfig> {
  const candidatePaths = [
    path.join(baseDir, "mcp.json"),
    path.join(baseDir, ".gemini", "mcp.json"),
    path.join(baseDir, ".toolnet", "mcp.json"),
  ];

  const configs: Record<string, McpServerConfig> = {};

  for (const filePath of candidatePaths) {
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const servers = parsed.mcpServers || parsed.servers || parsed;

        if (servers && typeof servers === "object") {
          for (const [name, cfg] of Object.entries(servers)) {
            if (cfg && typeof cfg === "object" && typeof (cfg as any).command === "string") {
              if (!configs[name]) {
                configs[name] = cfg as McpServerConfig;
              }
            }
          }
        }
      } catch {
        // Ignore read/parse error gracefully
      }
    }
  }

  return configs;
}

/**
 * Returns array of LocalMcpServer objects including source file path information.
 * @param baseDir Optional base directory (defaults to process.cwd()).
 */
export function getLocalMcpServers(baseDir: string = process.cwd()): LocalMcpServer[] {
  const candidatePaths = [
    path.join(baseDir, "mcp.json"),
    path.join(baseDir, ".gemini", "mcp.json"),
    path.join(baseDir, ".toolnet", "mcp.json"),
  ];

  const serversMap = new Map<string, LocalMcpServer>();

  for (const filePath of candidatePaths) {
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const servers = parsed.mcpServers || parsed.servers || parsed;

        if (servers && typeof servers === "object") {
          for (const [name, cfg] of Object.entries(servers)) {
            if (cfg && typeof cfg === "object" && typeof (cfg as any).command === "string") {
              if (!serversMap.has(name)) {
                serversMap.set(name, {
                  name,
                  config: cfg as McpServerConfig,
                  sourceFile: filePath,
                });
              }
            }
          }
        }
      } catch {
        // Ignore parse error
      }
    }
  }

  return Array.from(serversMap.values());
}

/**
 * Spawns a stdio MCP server child process based on config.
 */
export function spawnMcpServer(name: string, config: McpServerConfig, baseDir: string = process.cwd()): ChildProcess {
  const env = { ...process.env, ...(config.env || {}) };
  const cwd = config.cwd ? path.resolve(baseDir, config.cwd) : baseDir;

  return spawn(config.command, config.args || [], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Converts MCP JSON Schema tool definition into OpenAI function definition schema.
 */
export function convertMcpToolToAgentTool(mcpTool: any, serverName: string): McpToolDefinition {
  const toolName = mcpTool.name;
  return {
    type: "function",
    function: {
      name: toolName,
      description: mcpTool.description || `MCP Tool '${toolName}' from server '${serverName}'`,
      parameters: mcpTool.inputSchema || { type: "object", properties: {}, required: [] },
    },
    serverName,
    originalName: toolName,
  };
}

/**
 * Initializes MCP clients for all configured local stdio MCP servers.
 * Connects to servers via JSON-RPC, queries available tools via tools/list,
 * and populates the active client and tool routing registry.
 */
export async function initMcpClients(baseDir: string = process.cwd()): Promise<McpManagerStatus> {
  await closeMcpClients();

  const servers = getLocalMcpServers(baseDir);
  const connectedServers: string[] = [];
  const failedServers: Array<{ name: string; error: string }> = [];
  let totalTools = 0;

  for (const server of servers) {
    if (server.config.disabled) {
      continue;
    }

    try {
      const envRecord: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string") envRecord[k] = v;
      }
      if (server.config.env) {
        for (const [k, v] of Object.entries(server.config.env)) {
          if (typeof v === "string") envRecord[k] = v;
        }
      }

      const transport = new StdioClientTransport({
        command: server.config.command,
        args: server.config.args || [],
        env: envRecord,
        cwd: server.config.cwd ? path.resolve(baseDir, server.config.cwd) : baseDir,
      });

      const client = new Client(
        { name: `toolnet-cli-${server.name}`, version: "1.0.0" },
        { capabilities: {} }
      );

      await Promise.race([
        client.connect(transport),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`MCP server '${server.name}' connect timeout after 5000ms`)), 5000)
        ),
      ]);

      const listResult = await client.listTools();
      const rawTools = listResult.tools || [];
      const mcpTools: McpToolDefinition[] = [];

      for (const rawTool of rawTools) {
        const converted = convertMcpToolToAgentTool(rawTool, server.name);
        mcpTools.push(converted);
        toolRoutingMap.set(converted.function.name, {
          serverName: server.name,
          originalName: rawTool.name,
        });
      }

      activeClientsMap.set(server.name, {
        name: server.name,
        client,
        transport,
        tools: mcpTools,
      });

      connectedServers.push(server.name);
      totalTools += mcpTools.length;
    } catch (err: any) {
      failedServers.push({
        name: server.name,
        error: err?.message || String(err),
      });
    }
  }

  return {
    connectedServers,
    totalTools,
    failedServers,
  };
}

/**
 * Returns OpenAI-compatible function parameter objects for all active MCP tools.
 */
export function getMcpAgentTools(): Array<any> {
  const tools: Array<any> = [];
  for (const clientInfo of activeClientsMap.values()) {
    for (const toolDef of clientInfo.tools) {
      tools.push({
        type: toolDef.type,
        function: toolDef.function,
      });
    }
  }
  return tools;
}

/**
 * Dispatches execution of an MCP tool call (tools/call) to the responsible stdio client.
 * Returns null if the specified tool name is not registered as an MCP tool.
 */
export async function executeMcpTool(name: string, args: Record<string, any> = {}): Promise<string | null> {
  const route = toolRoutingMap.get(name);
  if (!route) {
    return null;
  }

  const clientInfo = activeClientsMap.get(route.serverName);
  if (!clientInfo) {
    return JSON.stringify({
      stdout: "",
      stderr: `MCP server '${route.serverName}' is not active`,
      exitCode: 1,
    });
  }

  try {
    const result = await clientInfo.client.callTool({
      name: route.originalName,
      arguments: args,
    });

    const contentArray = (result as any).content || [];
    const textParts: string[] = [];

    for (const item of contentArray) {
      if (typeof item === "string") {
        textParts.push(item);
      } else if (item && typeof item === "object") {
        if (item.type === "text" && typeof item.text === "string") {
          textParts.push(item.text);
        } else {
          textParts.push(JSON.stringify(item));
        }
      }
    }

    const stdout = textParts.join("\n") || (typeof result === "object" ? JSON.stringify(result) : String(result));
    const isError = Boolean((result as any).isError);

    return JSON.stringify({
      stdout,
      stderr: isError ? stdout : "",
      exitCode: isError ? 1 : 0,
    });
  } catch (err: any) {
    return JSON.stringify({
      stdout: "",
      stderr: `Error executing MCP tool '${name}': ${err?.message || String(err)}`,
      exitCode: 1,
    });
  }
}

/**
 * Disconnects all active MCP clients and cleans up resources.
 */
export async function closeMcpClients(): Promise<void> {
  for (const clientInfo of activeClientsMap.values()) {
    try {
      await clientInfo.client.close();
    } catch {}
    try {
      await clientInfo.transport.close();
    } catch {}
  }
  activeClientsMap.clear();
  toolRoutingMap.clear();
}

process.on("SIGINT", () => {
  closeMcpClients().catch(() => {});
});
process.on("SIGTERM", () => {
  closeMcpClients().catch(() => {});
});

function editLocalMcpConfig(
  baseDir: string,
  editor: (configs: Record<string, McpServerConfig>) => void
): void {
  const candidatePaths = [
    path.join(baseDir, "mcp.json"),
    path.join(baseDir, ".gemini", "mcp.json"),
    path.join(baseDir, ".toolnet", "mcp.json"),
  ];
  
  let targetPath = candidatePaths[1];
  let existingData: any = {};
  
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      targetPath = p;
      try {
        existingData = JSON.parse(fs.readFileSync(p, "utf8"));
      } catch {}
      break;
    }
  }

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let targetField = "mcpServers";
  let configs = existingData.mcpServers || existingData.servers;
  if (!configs) {
    if (Object.keys(existingData).length > 0) {
      configs = existingData;
      targetField = "";
    } else {
      configs = {};
    }
  }

  editor(configs);

  if (targetField) {
    existingData[targetField] = configs;
  } else {
    existingData = configs;
  }

  fs.writeFileSync(targetPath, JSON.stringify(existingData, null, 2), "utf8");
}

export function addLocalMcpServer(name: string, config: McpServerConfig, baseDir: string = process.cwd()): void {
  editLocalMcpConfig(baseDir, (configs) => {
    configs[name] = config;
  });
}

export function removeLocalMcpServer(name: string, baseDir: string = process.cwd()): void {
  editLocalMcpConfig(baseDir, (configs) => {
    delete configs[name];
  });
}
