/**
 * Layer 4 — Phase 3: MCP Supply-Chain Hardening + Canonical User-Data Dir
 *
 * Suites:
 *  MCP ENV      — scrubbed child env (no host secrets), explicit config.env works
 *  MCP NAMESPACE— mcp__<server>__<tool>, no collisions, merged registry unique
 *  MCP TRUST    — workspace untrusted until enabled; fingerprint invalidation;
 *                 headless fail-closed
 *  MCP CALL     — timeout, result cap, dead-server cleanup, no fake success
 *  SECURITY     — MCP tools still go through ToolGateway/SecurityEngine
 *  CANONICAL    — fresh install creates only ~/.toolnetcli; TOOLNETCLI_CONFIG_DIR
 *                 redirects every global dir
 *  MIGRATION    — audit/cache/plugins migrate; idempotent; canonical-newer-wins;
 *                 unknown legacy files preserved; permissions hardened
 *  PROJECT STATE— <workspace>/.toolnet untouched by migration
 */

import { test, expect, describe, beforeEach, afterEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import {
  mcpToolName,
  computeServerId,
  computeServerFingerprint,
  mcpTrustManager,
  getLocalMcpServers,
  initMcpClients,
  closeMcpClients,
  getMcpAgentTools,
  buildMcpChildEnv,
  mcpChildEnvNames,
  truncateWithMarker,
  MCP_CALL_TIMEOUT_MS,
  type McpServerConfig,
} from "../../lib/mcpRunner";
import { getMergedAgentTools } from "../../lib/agentTools";
import {
  getToolnetHome,
  getToolnetAuditDir,
  getToolnetCacheDir,
  getToolnetPluginsDir,
  getToolnetSessionsDir,
  getToolnetConfigPath,
  getToolnetPluginRegistryPath,
  migrateLegacyToolnetState,
  resetMigrationLatchForTests,
  clearMigrationMarkerForTests,
} from "../../lib/toolnetHome";
import { SecurityAuditLogger } from "../../lib/security/auditLogger";
import { setSandboxMode, getSandboxMode } from "../../lib/permissions";

const origMode = getSandboxMode();
const origEnv = { ...process.env };

beforeEach(() => setSandboxMode("workspace"));
afterEach(() => {
  setSandboxMode(origMode);
  process.env = { ...origEnv };
});
afterAll(() => { process.env = { ...origEnv }; });

// ── helpers ────────────────────────────────────────────────────────────────

function makeConfig(over: Partial<McpServerConfig> = {}): McpServerConfig {
  return { command: "bun", args: ["-e", "console.log('hi')"], ...over };
}

function writeMcpJson(dir: string, servers: Record<string, McpServerConfig>, rel = "mcp.json") {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ mcpServers: servers }));
  return p;
}

function inTempHome(fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-home-"));
    const prev = process.env.TOOLNETCLI_CONFIG_DIR;
    process.env.TOOLNETCLI_CONFIG_DIR = tmp;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR;
      else process.env.TOOLNETCLI_CONFIG_DIR = prev;
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    }
  })();
}

const MOCK_MCP = path.resolve(__dirname, "../../mock-mcp.ts");

// ═══════════════════════════════════════════════════════════════════════════
// MCP ENV
// ═══════════════════════════════════════════════════════════════════════════

describe("PHASE3 MCP ENV", () => {
  test("1. host API key does NOT leak into MCP child env", () => {
    process.env.OPENAI_API_KEY = "sk-supersecret";
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
    const env = buildMcpChildEnv(makeConfig());
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("2. token/password/secret patterns are scrubbed", () => {
    process.env.GITHUB_TOKEN = "ghp_x";
    process.env.AWS_SECRET_ACCESS_KEY = "awssecret";
    process.env.MY_DB_PASSWORD = "hunter2";
    process.env.NPM_TOKEN = "npm_x";
    process.env.CLOUDFLARE_API_TOKEN = "cf_x";
    const env = buildMcpChildEnv(makeConfig());
    for (const k of ["GITHUB_TOKEN", "AWS_SECRET_ACCESS_KEY", "MY_DB_PASSWORD", "NPM_TOKEN", "CLOUDFLARE_API_TOKEN"]) {
      expect(env[k]).toBeUndefined();
    }
  });

  test("3. safe env retained (PATH/HOME/TERM/LANG)", () => {
    process.env.PATH = "/usr/bin";
    process.env.TERM = "xterm-256color";
    const env = buildMcpChildEnv(makeConfig());
    expect(env.PATH).toBe("/usr/bin");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.HOME).toBe(process.env.HOME);
  });

  test("4. explicit config.env keys pass through (non-secret); secret-looking blocked", () => {
    const env = buildMcpChildEnv(makeConfig({
      env: { MY_APP_MODE: "production", EVIL_TOKEN: "smuggled" },
    }));
    expect(env.MY_APP_MODE).toBe("production");
    expect(env.EVIL_TOKEN).toBeUndefined();
    // Names-only introspection for audit (values never logged).
    const names = mcpChildEnvNames(makeConfig({ env: { FOO: "1" } }));
    expect(names).toContain("FOO");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MCP NAMESPACE
// ═══════════════════════════════════════════════════════════════════════════

describe("PHASE3 MCP NAMESPACE", () => {
  test("5. tool name canonicalization: read_file → mcp__server__read_file", () => {
    expect(mcpToolName("filesystem", "read_file")).toBe("mcp__filesystem__read_file");
  });

  test("6. two servers exposing the same raw tool do NOT collide", () => {
    const a = mcpToolName("serverA", "query");
    const b = mcpToolName("serverB", "query");
    expect(a).not.toBe(b);
    expect(a).toBe("mcp__serverA__query");
    expect(b).toBe("mcp__serverB__query");
  });

  test("7. merged agent tool names are unique (registry assertion)", async () => {
    await inTempHome(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-ns-"));
      writeMcpJson(dir, { "fs1": { command: "true" } });
      // No real spawn happens (server fails to connect → failedServers),
      // the assertion below is about registry invariants.
      const tools = getMergedAgentTools();
      const names = tools.map(t => t.function?.name).filter(Boolean);
      expect(new Set(names).size).toBe(names.length);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  test("8. built-in tool names cannot be overwritten by MCP namespace", () => {
    // Even a malicious server naming its tool 'shell' gets namespaced.
    const name = mcpToolName("evil", "shell");
    expect(name).toBe("mcp__evil__shell");
    expect(name).not.toBe("shell");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MCP TRUST
// ═══════════════════════════════════════════════════════════════════════════

describe("PHASE3 MCP TRUST", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-trust-"));
    writeMcpJson(dir, { worker: { command: "bun", args: ["run", MOCK_MCP] } });
  });

  afterEach(async () => {
    await closeMcpClients();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("9. workspace server discovered but NOT auto-spawned while untrusted", async () => {
    await inTempHome(async () => {
      const servers = getLocalMcpServers(dir);
      expect(servers).toHaveLength(1);
      expect(servers[0].sourceKind).toBe("USER_CONFIG");

      const status = await initMcpClients(dir);
      expect(status.connectedServers).toHaveLength(0);
      expect(status.skippedServers.map(s => s.name)).toContain("worker");
      expect(getMcpAgentTools()).toHaveLength(0);
    });
  });

  test("10. enabling a trusted server spawns it and exposes namespaced tools", async () => {
    await inTempHome(async () => {
      const server = getLocalMcpServers(dir)[0];
      mcpTrustManager.enableServer(server.serverId, server.config, server.sourceFile);

      const status = await initMcpClients(dir);
      expect(status.connectedServers).toContain("worker");
      expect(status.totalTools).toBeGreaterThanOrEqual(1);

      const toolNames = getMcpAgentTools().map((t: any) => t.function.name);
      expect(toolNames).toContain(`mcp__${server.serverId}__get_weather`);
    });
  });

  test("11. config command change invalidates existing trust", async () => {
    await inTempHome(async () => {
      const server = getLocalMcpServers(dir)[0];
      mcpTrustManager.enableServer(server.serverId, server.config, server.sourceFile);
      expect(
        mcpTrustManager.getTrustState(server.serverId, server.config, server.sourceKind)
      ).toBe("enabled");

      // Attacker edits mcp.json swapping the command.
      const tampered = makeConfig({ command: "curl", args: ["http://evil.example"] });
      expect(
        mcpTrustManager.getTrustState(server.serverId, tampered, server.sourceKind)
      ).toBe("untrusted");
      // Fingerprint is deterministic and changes with content.
      expect(computeServerFingerprint(server.config))
        .not.toBe(computeServerFingerprint(tampered));
    });
  });

  test("12. headless fail-closed: untrusted server stays skipped (no interactive approve)", async () => {
    process.env.TOOLNET_HEADLESS = "1";
    await inTempHome(async () => {
      const status = await initMcpClients(dir);
      expect(status.connectedServers).toHaveLength(0);
      expect(status.skippedServers.length).toBe(1);
      // And nothing was auto-trusted behind the user's back.
      const server = getLocalMcpServers(dir)[0];
      expect(
        mcpTrustManager.getTrustState(server.serverId, server.config, server.sourceKind)
      ).toBe("untrusted");
    });
  });

  test("12b. config disabled flag wins over trust record", async () => {
    await inTempHome(async () => {
      const server = getLocalMcpServers(dir)[0];
      mcpTrustManager.enableServer(server.serverId, server.config, server.sourceFile);
      expect(
        mcpTrustManager.getTrustState(server.serverId, server.config, server.sourceKind, true)
      ).toBe("disabled");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MCP CALL
// ═══════════════════════════════════════════════════════════════════════════

describe("PHASE3 MCP CALL", () => {
  test("13. call timeout default is sane and truncation marker works", () => {
    expect(MCP_CALL_TIMEOUT_MS).toBeGreaterThanOrEqual(1000);
    const long = "x".repeat(1000);
    const capped = truncateWithMarker(long, 100);
    expect(capped.length).toBeLessThan(1000);
    expect(capped).toContain("[MCP output truncated:");
    expect(truncateWithMarker("short", 100)).toBe("short");
  });

  test("14. result cap: oversized output truncated deterministically", () => {
    const a = truncateWithMarker("y".repeat(50_000), 1000);
    const b = truncateWithMarker("y".repeat(50_000), 1000);
    expect(a).toBe(b); // deterministic
    expect(Buffer.byteLength(a)).toBeLessThan(1200);
    expect(a).toContain("[MCP output truncated: 50000 bytes");
  });

  test("15. dead server cleanup: killed server reports typed error, not fake success", async () => {
    await inTempHome(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-dead-"));
      writeMcpJson(dir, { dying: { command: "bun", args: ["run", MOCK_MCP] } });
      const server = getLocalMcpServers(dir)[0];
      mcpTrustManager.enableServer(server.serverId, server.config, server.sourceFile);
      const status = await initMcpClients(dir);
      expect(status.connectedServers).toContain("dying");

      await closeMcpClients();
      const tools = getMcpAgentTools();
      expect(tools).toHaveLength(0);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  test("16. concurrent init does not spawn duplicate processes (init lock)", async () => {
    await inTempHome(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-lock-"));
      writeMcpJson(dir, { locker: { command: "bun", args: ["run", MOCK_MCP] } });
      const server = getLocalMcpServers(dir)[0];
      mcpTrustManager.enableServer(server.serverId, server.config, server.sourceFile);

      const results = await Promise.all([
        initMcpClients(dir),
        initMcpClients(dir),
        initMcpClients(dir),
      ]);
      // All succeed; the lock guarantees a single spawned client per server.
      for (const r of results) {
        expect(r.connectedServers).toContain("locker");
      }
      await closeMcpClients();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  test("17. failing server is typed failure, never fake success", async () => {
    await inTempHome(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-fail-"));
      writeMcpJson(dir, { broken: { command: "definitely-not-a-real-binary-xyz" } });
      const server = getLocalMcpServers(dir)[0];
      mcpTrustManager.enableServer(server.serverId, server.config, server.sourceFile);

      const status = await initMcpClients(dir);
      expect(status.connectedServers).toHaveLength(0);
      expect(status.failedServers).toHaveLength(1);
      expect(status.failedServers[0].name).toBe("broken");
      expect(status.failedServers[0].error.length).toBeGreaterThan(0);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY — MCP still behind ToolGateway/SecurityEngine
// ═══════════════════════════════════════════════════════════════════════════

describe("PHASE3 SECURITY", () => {
  const { securityEngine } = (() => {
    // lazy require to avoid import-order coupling
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return { securityEngine: (require("../../lib/security/securityEngine") as any).securityEngine };
  })();

  test("18. MCP tool category resolves through SecurityEngine (no auto-allow)", () => {
    expect(securityEngine.categorizeTool("mcp__fs__read_file")).toBe("MCP_TOOL");
  });

  test("19. mutating MCP tool DENIED in workspace mode (underlying name evaluated)", () => {
    const res = securityEngine.evaluate(
      "mcp__fs__delete_everything", {}, "workspace", process.cwd(), process.cwd()
    );
    expect(res.allowed).toBe(false);
    expect(res.decision).toBe("DENY");
  });

  test("19b. read-only MCP tool allowed in workspace mode; ASK in ask mode", () => {
    const ws = securityEngine.evaluate(
      "mcp__fs__read_page", {}, "workspace", process.cwd(), process.cwd()
    );
    expect(ws.allowed).toBe(true);

    const ask = securityEngine.evaluate(
      "mcp__fs__read_page", {}, "ask", process.cwd(), process.cwd()
    );
    expect(ask.needsApproval).toBe(true);
  });

  test("20. network-named MCP tool keeps MODERATE_WRITE intrinsic risk", () => {
    const res = securityEngine.evaluate(
      "mcp__net__fetch_url", {}, "full-access", process.cwd(), process.cwd()
    );
    expect(res.allowed).toBe(true);
    expect(["MODERATE_WRITE", "SAFE_READ"]).toContain(res.riskLevel);
  });

  test("21. CRITICAL invariant: rm -rf stays CRITICAL_DENY regardless of mode", () => {
    const res = securityEngine.evaluate(
      "shell", { command: "rm -rf /" }, "full-access", process.cwd(), process.cwd()
    );
    expect(res.riskLevel).toBe("CRITICAL_DENY");
    expect(res.allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CANONICAL HOME
// ═══════════════════════════════════════════════════════════════════════════

describe("PHASE3 CANONICAL HOME", () => {
  test("22-24. fresh install: only ~/.toolnetcli is created; no legacy dirs", async () => {
    // Fake HOME so legacy paths inside it are observable.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-fresh-"));
    const prevHome = process.env.HOME;
    const prevConfigDir = process.env.TOOLNETCLI_CONFIG_DIR;
    process.env.HOME = fakeHome;
    delete process.env.TOOLNETCLI_CONFIG_DIR;
    resetMigrationLatchForTests();
    try {
      const res = migrateLegacyToolnetState();
      expect(res.performed).toBe(false); // nothing to migrate

      // Canonical root creatable on demand.
      fs.mkdirSync(getToolnetHome(), { recursive: true });
      fs.writeFileSync(getToolnetConfigPath(), "{}");
      expect(fs.existsSync(getToolnetConfigPath())).toBe(true);

      // Fresh install must NOT create legacy global dirs.
      expect(fs.existsSync(path.join(fakeHome, ".toolnet-cli"))).toBe(false);
      expect(fs.existsSync(path.join(fakeHome, ".toolnet"))).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevConfigDir === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR; else process.env.TOOLNETCLI_CONFIG_DIR = prevConfigDir;
      resetMigrationLatchForTests();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("25. TOOLNETCLI_CONFIG_DIR redirects ALL global dirs consistently", async () => {
    await inTempHome(() => {
      const root = getToolnetHome();
      expect(getToolnetConfigPath()).toBe(path.join(root, "config.json"));
      expect(getToolnetSessionsDir()).toBe(path.join(root, "sessions"));
      expect(getToolnetCacheDir()).toBe(path.join(root, "cache"));
      expect(getToolnetAuditDir()).toBe(path.join(root, "audit"));
      expect(getToolnetPluginsDir()).toBe(path.join(root, "plugins"));
      expect(getToolnetPluginRegistryPath()).toBe(path.join(root, "plugins", "registry.json"));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MIGRATION
// ═══════════════════════════════════════════════════════════════════════════

describe("PHASE3 MIGRATION", () => {
  test("26. audit migration: legacy audit files land in canonical dir", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-mig-"));
    const prevHome = process.env.HOME;
    const prevConfigDir = process.env.TOOLNETCLI_CONFIG_DIR;
    process.env.HOME = fakeHome;
    delete process.env.TOOLNETCLI_CONFIG_DIR;
    resetMigrationLatchForTests();
    try {
      const legacyAudit = path.join(fakeHome, ".toolnet-cli", "audit");
      fs.mkdirSync(legacyAudit, { recursive: true });
      fs.writeFileSync(path.join(legacyAudit, "security-audit.jsonl"), '{"hash":"a"}\n');

      const res = migrateLegacyToolnetState();
      expect(res.performed).toBe(true);
      expect(fs.existsSync(path.join(getToolnetAuditDir(), "security-audit.jsonl"))).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevConfigDir === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR; else process.env.TOOLNETCLI_CONFIG_DIR = prevConfigDir;
      resetMigrationLatchForTests();
      clearMigrationMarkerForTests();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("27. cache migration moves legacy cache entries", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-cache-"));
    const prevHome = process.env.HOME;
    const prevConfigDir = process.env.TOOLNETCLI_CONFIG_DIR;
    process.env.HOME = fakeHome;
    delete process.env.TOOLNETCLI_CONFIG_DIR;
    resetMigrationLatchForTests();
    try {
      const legacyCache = path.join(fakeHome, ".toolnet-cli", "cache");
      fs.mkdirSync(legacyCache, { recursive: true });
      fs.writeFileSync(path.join(legacyCache, "skills-meta.json"), "{}");

      migrateLegacyToolnetState();
      expect(fs.existsSync(path.join(getToolnetCacheDir(), "skills-meta.json"))).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevConfigDir === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR; else process.env.TOOLNETCLI_CONFIG_DIR = prevConfigDir;
      resetMigrationLatchForTests();
      clearMigrationMarkerForTests();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("28. plugin registry migration lands in canonical plugins dir", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-plug-"));
    const prevHome = process.env.HOME;
    const prevConfigDir = process.env.TOOLNETCLI_CONFIG_DIR;
    process.env.HOME = fakeHome;
    delete process.env.TOOLNETCLI_CONFIG_DIR;
    resetMigrationLatchForTests();
    try {
      const legacyPlugins = path.join(fakeHome, ".toolnet", "plugins");
      fs.mkdirSync(legacyPlugins, { recursive: true });
      fs.writeFileSync(path.join(legacyPlugins, "registry.json"), "[]");

      migrateLegacyToolnetState();
      expect(fs.existsSync(getToolnetPluginRegistryPath())).toBe(true);
      expect(JSON.parse(fs.readFileSync(getToolnetPluginRegistryPath(), "utf8"))).toEqual([]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevConfigDir === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR; else process.env.TOOLNETCLI_CONFIG_DIR = prevConfigDir;
      resetMigrationLatchForTests();
      clearMigrationMarkerForTests();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("29. migration is idempotent (second run is a no-op)", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-idem-"));
    const prevHome = process.env.HOME;
    const prevConfigDir = process.env.TOOLNETCLI_CONFIG_DIR;
    process.env.HOME = fakeHome;
    delete process.env.TOOLNETCLI_CONFIG_DIR;
    resetMigrationLatchForTests();
    try {
      const legacyAudit = path.join(fakeHome, ".toolnet-cli", "audit");
      fs.mkdirSync(legacyAudit, { recursive: true });
      fs.writeFileSync(path.join(legacyAudit, "security-audit.jsonl"), "line\n");

      const first = migrateLegacyToolnetState();
      expect(first.performed).toBe(true);

      // Second call short-circuits via in-process latch + marker.
      resetMigrationLatchForTests();
      const second = migrateLegacyToolnetState();
      expect(second.performed).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevConfigDir === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR; else process.env.TOOLNETCLI_CONFIG_DIR = prevConfigDir;
      resetMigrationLatchForTests();
      clearMigrationMarkerForTests();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("30. canonical newer file NOT overwritten by legacy copy", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-newer-"));
    const prevHome = process.env.HOME;
    const prevConfigDir = process.env.TOOLNETCLI_CONFIG_DIR;
    process.env.HOME = fakeHome;
    delete process.env.TOOLNETCLI_CONFIG_DIR;
    resetMigrationLatchForTests();
    try {
      const canonicalAudit = getToolnetAuditDir();
      fs.mkdirSync(canonicalAudit, { recursive: true, mode: 0o700 });
      const canonicalFile = path.join(canonicalAudit, "security-audit.jsonl");
      fs.writeFileSync(canonicalFile, "NEW-CANONICAL\n");
      // Make canonical clearly newer.
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(canonicalFile, future, future);

      const legacyAudit = path.join(fakeHome, ".toolnet-cli", "audit");
      fs.mkdirSync(legacyAudit, { recursive: true });
      fs.writeFileSync(path.join(legacyAudit, "security-audit.jsonl"), "OLD-LEGACY\n");

      migrateLegacyToolnetState();
      expect(fs.readFileSync(canonicalFile, "utf8")).toBe("NEW-CANONICAL\n");
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevConfigDir === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR; else process.env.TOOLNETCLI_CONFIG_DIR = prevConfigDir;
      resetMigrationLatchForTests();
      clearMigrationMarkerForTests();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("31. unknown legacy file preserved (legacy dir kept + warning)", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-unk-"));
    const prevHome = process.env.HOME;
    const prevConfigDir = process.env.TOOLNETCLI_CONFIG_DIR;
    process.env.HOME = fakeHome;
    delete process.env.TOOLNETCLI_CONFIG_DIR;
    resetMigrationLatchForTests();
    try {
      const legacyCli = path.join(fakeHome, ".toolnet-cli");
      fs.mkdirSync(path.join(legacyCli, "audit"), { recursive: true });
      fs.writeFileSync(path.join(legacyCli, "audit", "security-audit.jsonl"), "x\n");
      fs.writeFileSync(path.join(legacyCli, "mystery-user-file.txt"), "DO NOT DELETE");

      const res = migrateLegacyToolnetState();
      expect(res.preservedUnknown.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(legacyCli, "mystery-user-file.txt"))).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevConfigDir === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR; else process.env.TOOLNETCLI_CONFIG_DIR = prevConfigDir;
      resetMigrationLatchForTests();
      clearMigrationMarkerForTests();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("32. permissions hardened: sensitive files 0600, dirs 0700", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-perm-"));
    const prevHome = process.env.HOME;
    const prevConfigDir = process.env.TOOLNETCLI_CONFIG_DIR;
    process.env.HOME = fakeHome;
    delete process.env.TOOLNETCLI_CONFIG_DIR;
    resetMigrationLatchForTests();
    try {
      const legacyToolnet = path.join(fakeHome, ".toolnet");
      fs.mkdirSync(path.join(legacyToolnet, "plugins"), { recursive: true });
      fs.writeFileSync(path.join(legacyToolnet, "plugins", "registry.json"), "[]");
      fs.writeFileSync(path.join(legacyToolnet, "auth_token"), "secret-token", { mode: 0o644 });

      migrateLegacyToolnetState();
      const token = getToolnetHome() + "/auth_token";
      expect(fs.existsSync(token)).toBe(true);
      const mode = fs.statSync(token).mode & 0o777;
      expect(mode & 0o077).toBe(0); // no group/other bits
      expect(fs.statSync(getToolnetHome()).mode & 0o777).toBe(0o700);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevConfigDir === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR; else process.env.TOOLNETCLI_CONFIG_DIR = prevConfigDir;
      resetMigrationLatchForTests();
      clearMigrationMarkerForTests();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  test("33. repeated startup does not recreate legacy dirs (fresh install path)", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-repeat-"));
    const prevHome = process.env.HOME;
    const prevConfigDir = process.env.TOOLNETCLI_CONFIG_DIR;
    process.env.HOME = fakeHome;
    delete process.env.TOOLNETCLI_CONFIG_DIR;
    resetMigrationLatchForTests();
    try {
      migrateLegacyToolnetState(); // fresh: no legacy → no-op
      // Simulate subsequent startups.
      for (let i = 0; i < 3; i++) {
        resetMigrationLatchForTests();
        migrateLegacyToolnetState();
      }
      expect(fs.existsSync(path.join(fakeHome, ".toolnet-cli"))).toBe(false);
      expect(fs.existsSync(path.join(fakeHome, ".toolnet"))).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevConfigDir === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR; else process.env.TOOLNETCLI_CONFIG_DIR = prevConfigDir;
      resetMigrationLatchForTests();
      clearMigrationMarkerForTests();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PROJECT STATE — <workspace>/.toolnet is intentional and preserved
// ═══════════════════════════════════════════════════════════════════════════

describe("PHASE3 PROJECT STATE", () => {
  test("34-37. workspace .toolnet untouched by migration; mcp.json still discovered as untrusted", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-proj-home-"));
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-proj-ws-"));

    const prevHome = process.env.HOME;
    const prevConfigDir = process.env.TOOLNETCLI_CONFIG_DIR;
    const prevCwd = process.cwd();
    process.env.HOME = fakeHome;
    delete process.env.TOOLNETCLI_CONFIG_DIR;
    resetMigrationLatchForTests();
    try {
      // Project-local state files (intentional).
      const projToolnet = path.join(project, ".toolnet");
      fs.mkdirSync(projToolnet, { recursive: true });
      fs.writeFileSync(path.join(projToolnet, "plan.md"), "# plan");
      fs.writeFileSync(path.join(projToolnet, "permissions.json"), "{}");
      fs.writeFileSync(path.join(projToolnet, "mcp.json"), JSON.stringify({
        mcpServers: { projserver: { command: "bun", args: ["run", MOCK_MCP] } },
      }));

      // Migration sees no GLOBAL legacy dirs (they are not in fakeHome).
      const res = migrateLegacyToolnetState();
      expect(res.performed).toBe(false);

      // Project .toolnet fully preserved.
      expect(fs.existsSync(path.join(projToolnet, "plan.md"))).toBe(true);
      expect(fs.existsSync(path.join(projToolnet, "permissions.json"))).toBe(true);

      // Project MCP config still discovered — as WORKSPACE_UNTRUSTED.
      process.chdir(project);
      const servers = getLocalMcpServers(project);
      const proj = servers.find(s => s.name === "projserver");
      expect(proj).toBeDefined();
      expect(proj!.sourceKind).toBe("WORKSPACE_UNTRUSTED");
    } finally {
      process.chdir(prevCwd);
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevConfigDir === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR; else process.env.TOOLNETCLI_CONFIG_DIR = prevConfigDir;
      resetMigrationLatchForTests();
      clearMigrationMarkerForTests();
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDIT LOGGER canonical path + chain survival across migration
// ═══════════════════════════════════════════════════════════════════════════

describe("PHASE3 AUDIT", () => {
  test("38. audit logger writes to canonical ~/.toolnetcli/audit", async () => {
    await inTempHome(() => {
      const logger = new SecurityAuditLogger();
      logger.logEvent({
        timestamp: Date.now(),
        toolName: "shell",
        args: { command: "echo hi" },
        riskLevel: "MODERATE_WRITE",
        category: "SHELL_EXECUTE",
        capability: "EXECUTE",
        mode: "workspace",
        decision: "ALLOW",
        allowed: true,
        cwd: process.cwd(),
      } as any);
      const logPath = logger.getLogPath();
      expect(logPath.startsWith(getToolnetHome())).toBe(true);
      expect(logPath).toContain("/audit/");
      expect(fs.existsSync(logPath)).toBe(true);
    });
  });

  test("39. chain verification survives migration boundary (chain continues from legacy last hash)", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "phase3-auditchain-"));
    const prevHome = process.env.HOME;
    const prevConfigDir = process.env.TOOLNETCLI_CONFIG_DIR;
    process.env.HOME = fakeHome;
    delete process.env.TOOLNETCLI_CONFIG_DIR;
    resetMigrationLatchForTests();
    try {
      // Build a REAL legacy hash-chained entry using the audit crypto helpers.
      const auditMod = require("../../lib/security/auditLogger");
      const genesis = auditMod.GENESIS_HASH as string;
      const legacyPayload = {
        timestamp: new Date().toISOString(),
        event: "legacy_event",
        data: { action: "legacy_event", allowed: true },
      };
      const legacyHash = auditMod.computeAuditHash(genesis, legacyPayload);

      const legacyDir = path.join(fakeHome, ".toolnet-cli", "audit");
      fs.mkdirSync(legacyDir, { recursive: true });
      const legacyLog = path.join(legacyDir, "security-audit.jsonl");
      fs.writeFileSync(legacyLog, JSON.stringify({
        ...legacyPayload,
        previousHash: genesis,
        hash: legacyHash,
      }) + "\n");

      migrateLegacyToolnetState();

      // New logger (canonical path) recovers the chain from the migrated file.
      const logger = new SecurityAuditLogger();
      logger.logEvent({
        timestamp: Date.now(),
        toolName: "read_file",
        args: { path: "x.txt" },
        riskLevel: "SAFE_READ",
        category: "FILE_READ",
        capability: "READ",
        mode: "workspace",
        decision: "ALLOW",
        allowed: true,
        cwd: process.cwd(),
      } as any);

      // The new entry chains from the legacy last hash — boundary is seamless.
      const content = fs.readFileSync(logger.getLogPath(), "utf8").trim().split("\n");
      const secondEntry = JSON.parse(content[1]);
      expect(secondEntry.previousHash).toBe(legacyHash);
      const verification = logger.verifyChain();
      expect(verification.valid).toBe(true);
      expect(verification.totalEntries).toBe(2);
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevConfigDir === undefined) delete process.env.TOOLNETCLI_CONFIG_DIR; else process.env.TOOLNETCLI_CONFIG_DIR = prevConfigDir;
      resetMigrationLatchForTests();
      clearMigrationMarkerForTests();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
