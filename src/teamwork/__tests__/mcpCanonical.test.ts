import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolRegistry } from "../../lib/harness/toolRegistry";
import {
  MCP_MAX_DESCRIPTION_CHARS,
  MCP_MAX_SCHEMA_PROPERTIES,
  deriveMcpToolRisk,
  normalizeMcpToolDefinition,
} from "../../core/mcp/schema";
import {
  canonicalMcpToolName,
  mcpPermissionResource,
  registerMcpTools,
  toRegistryTool,
  unregisterMcpTools,
  type McpToolCaller,
} from "../../core/mcp/adapter";
import { McpManager, filterServerTools, readServerPolicy } from "../../core/mcp/manager";

/**
 * Phase 77.12–77.22 — MCP treated as untrusted input + one canonical registry.
 */

let workspace: string;
let configDir: string;
let mockCaller: McpToolCaller & { calls: Array<Record<string, unknown>> };

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-mcp-"));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-mcp-home-"));
  process.env.TOOLNETCLI_CONFIG_DIR = configDir;
  toolRegistry.clearDynamic();

  const calls: Array<Record<string, unknown>> = [];
  mockCaller = {
    calls,
    call: async (serverId, serverName, toolName, args) => {
      calls.push({ serverId, serverName, toolName, args });
      return JSON.stringify({ stdout: `ok:${toolName}`, stderr: "", exitCode: 0 });
    },
  };
});

afterEach(() => {
  toolRegistry.clearDynamic();
  delete process.env.TOOLNETCLI_CONFIG_DIR;
  for (const dir of [workspace, configDir]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("mcp — schema normalization (untrusted input)", () => {
  test("a well-formed tool normalizes and keeps its declared properties", () => {
    const result = normalizeMcpToolDefinition({
      name: "search_code",
      description: "Search code",
      inputSchema: {
        type: "object",
        properties: { q: { type: "string" }, limit: { type: "number" } },
        required: ["q", "ghost"],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe("search_code");
    // `ghost` was required but never declared — dropped so providers accept it.
    expect(result.value.parameters.required).toEqual(["q"]);
    expect(result.value.warnings.length).toBeGreaterThan(0);
  });

  test("malformed definitions are rejected with a reason, never passed through", () => {
    expect(normalizeMcpToolDefinition(null).ok).toBe(false);
    expect(normalizeMcpToolDefinition({ description: "no name" }).ok).toBe(false);
    expect(normalizeMcpToolDefinition({ name: "x", inputSchema: "nope" }).ok).toBe(false);
    expect(normalizeMcpToolDefinition({ name: "x", inputSchema: { type: "array" } }).ok).toBe(false);
    expect(normalizeMcpToolDefinition({ name: "x", inputSchema: { type: "object", properties: [] } }).ok).toBe(false);
    expect(normalizeMcpToolDefinition({ name: "x", inputSchema: { type: "object", required: "q" } }).ok).toBe(false);
  });

  test("a hostile tool name is sanitized to the provider-legal charset", () => {
    const result = normalizeMcpToolDefinition({ name: "evil;rm -rf /`", inputSchema: { type: "object" } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(result.value.warnings[0]).toContain("sanitized");
    }
  });

  test("an oversized description is truncated", () => {
    const result = normalizeMcpToolDefinition({
      name: "chatty",
      description: "x".repeat(MCP_MAX_DESCRIPTION_CHARS + 500),
      inputSchema: { type: "object" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.description).toContain("truncated");
  });

  test("a tool with too many properties is rejected so the schema cannot flood the context", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < MCP_MAX_SCHEMA_PROPERTIES + 1; i++) properties[`p${i}`] = { type: "string" };
    const result = normalizeMcpToolDefinition({ name: "huge", inputSchema: { type: "object", properties } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("limit");
  });

  test("a deeply nested schema is rejected", () => {
    let nested: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 12; i++) nested = { type: "object", properties: { next: nested } };
    const result = normalizeMcpToolDefinition({ name: "deep", inputSchema: { type: "object", properties: { a: nested } } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("depth");
  });

  test("a missing inputSchema defaults to an empty object schema", () => {
    const result = normalizeMcpToolDefinition({ name: "bare" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.parameters).toEqual({ type: "object", properties: {}, required: [] });
    }
  });

  test("risk comes from annotations first, then the tool name", () => {
    expect(deriveMcpToolRisk("anything", { destructiveHint: true })).toBe("execute");
    expect(deriveMcpToolRisk("anything", { readOnlyHint: true })).toBe("read");
    expect(deriveMcpToolRisk("search_code", undefined)).toBe("read");
    expect(deriveMcpToolRisk("dangerous_write", undefined)).toBe("write");
    // The namespace must not change the verdict.
    expect(deriveMcpToolRisk("mcp__github__get_issue", undefined)).toBe("read");
  });
});

describe("mcp — registry adapter", () => {
  test("the canonical name is provider-legal and the permission resource is readable", () => {
    const canonical = canonicalMcpToolName("github", "search_code");
    expect(canonical).toBe("mcp__github__search_code");
    expect(canonical).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(mcpPermissionResource("github", "search_code")).toBe("mcp:github/search_code");
  });

  test("registered tools appear in the model schema exactly once, under the canonical name", () => {
    const normalized = normalizeMcpToolDefinition({ name: "echo", description: "Echo" });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;

    const { registered } = registerMcpTools("srv", "Server", [normalized.value], mockCaller);
    expect(registered).toEqual(["mcp__srv__echo"]);

    const schemas = toolRegistry.schemas().filter((t) => t.function.name.startsWith("mcp__"));
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.function.name).toBe("mcp__srv__echo");
    expect(toolRegistry.ownerOf("mcp__srv__echo")).toBe("mcp:srv");
    // The bare name is NOT exposed — no conflicting raw names for the model.
    expect(toolRegistry.has("echo")).toBe(false);
  });

  test("execute delegates to the caller with server + tool identity", async () => {
    const normalized = normalizeMcpToolDefinition({ name: "echo", description: "Echo" });
    if (!normalized.ok) throw new Error("fixture normalization failed");

    const definition = toRegistryTool({
      serverId: "srv",
      serverName: "Server",
      tool: normalized.value,
      caller: mockCaller,
    });

    const output = await definition.execute({ text: "hi" }, {});
    expect(JSON.parse(output).stdout).toBe("ok:echo");
    expect(mockCaller.calls[0]).toEqual({
      serverId: "srv",
      serverName: "Server",
      toolName: "echo",
      args: { text: "hi" },
    });
  });

  test("two servers with the same tool name get distinct canonical ids", () => {
    const normalized = normalizeMcpToolDefinition({ name: "query", description: "q" });
    if (!normalized.ok) throw new Error("fixture normalization failed");

    registerMcpTools("serverA", "A", [normalized.value], mockCaller);
    registerMcpTools("serverB", "B", [normalized.value], mockCaller);

    expect(toolRegistry.has("mcp__serverA__query")).toBe(true);
    expect(toolRegistry.has("mcp__serverB__query")).toBe(true);
  });

  test("unregistering a server removes only its own tools", () => {
    const normalized = normalizeMcpToolDefinition({ name: "query", description: "q" });
    if (!normalized.ok) throw new Error("fixture normalization failed");

    registerMcpTools("serverA", "A", [normalized.value], mockCaller);
    registerMcpTools("serverB", "B", [normalized.value], mockCaller);

    expect(unregisterMcpTools("serverA")).toBe(1);
    expect(toolRegistry.has("mcp__serverA__query")).toBe(false);
    expect(toolRegistry.has("mcp__serverB__query")).toBe(true);
  });

  test("a tool that collides with an existing registration is reported, not overwritten", () => {
    const normalized = normalizeMcpToolDefinition({ name: "query", description: "q" });
    if (!normalized.ok) throw new Error("fixture normalization failed");

    registerMcpTools("serverA", "A", [normalized.value], mockCaller);
    // Same owner re-registering without unregistering first.
    const second = registerMcpTools("serverA", "A", [normalized.value], mockCaller);
    expect(second.registered).toEqual([]);
    expect(second.rejected).toEqual(["mcp__serverA__query"]);
  });
});

describe("mcp — server policy", () => {
  test("enabledTools is an allowlist and disabledTools is a denylist", () => {
    const tools = [
      { name: "search_code", description: "", parameters: { type: "object" as const, properties: {}, required: [] }, risk: "read" as const, warnings: [] },
      { name: "get_issue", description: "", parameters: { type: "object" as const, properties: {}, required: [] }, risk: "read" as const, warnings: [] },
      { name: "push_commit", description: "", parameters: { type: "object" as const, properties: {}, required: [] }, risk: "write" as const, warnings: [] },
    ];

    expect(filterServerTools(tools, { enabledTools: ["search_code"] }).map((t) => t.name)).toEqual(["search_code"]);
    expect(filterServerTools(tools, { disabledTools: ["push_commit"] }).map((t) => t.name)).toEqual([
      "search_code",
      "get_issue",
    ]);
    // A deny wins over an allow.
    expect(
      filterServerTools(tools, { enabledTools: ["search_code"], disabledTools: ["search_code"] }).map((t) => t.name),
    ).toEqual([]);
    expect(filterServerTools(tools, {}).map((t) => t.name)).toHaveLength(3);
  });

  test("readServerPolicy ignores malformed fields", () => {
    expect(readServerPolicy({ enabledTools: "nope", disabledTools: [1, 2], maxConcurrentCalls: -1 })).toEqual({
      enabledTools: undefined,
      disabledTools: undefined,
      maxConcurrentCalls: undefined,
    });
    expect(readServerPolicy({ maxConcurrentCalls: 2.7 })).toEqual({
      enabledTools: undefined,
      disabledTools: undefined,
      maxConcurrentCalls: 2,
    });
  });
});

describe("mcp — manager", () => {
  test("an unknown server is reported as not-installed and lists no tools", async () => {
    const manager = new McpManager();
    expect(manager.status("ghost")).toBe("not-installed");
    expect(manager.listTools("ghost")).toEqual([]);
    expect(await manager.connect("ghost")).toBe("not-installed");
    expect(await manager.disconnect("ghost")).toBe(false);
  });

  test("sync with no configured servers succeeds with an empty report", async () => {
    const manager = new McpManager();
    const report = await manager.sync(workspace);
    expect(report.connected).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.registeredToolCount).toBe(0);
    await manager.dispose();
  });

  test("calling a tool on an unregistered server returns a typed failure, not a throw", async () => {
    const manager = new McpManager();
    const raw = await manager.callTool("ghost", "echo", {});
    const parsed = JSON.parse(raw);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.stderr).toContain("not registered");
  });

  test("dispose is idempotent and leaves no MCP tool in the registry", async () => {
    const manager = new McpManager();
    await manager.sync(workspace);
    await manager.dispose();
    await manager.dispose();
    expect(toolRegistry.list().filter((t) => t.name.startsWith("mcp__"))).toHaveLength(0);
  });
});
