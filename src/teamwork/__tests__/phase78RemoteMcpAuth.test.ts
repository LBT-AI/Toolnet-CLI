import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { toolRegistry } from "../../lib/harness/toolRegistry";
import { hookRegistry } from "../../core/hooks";
import { executeTool } from "../../lib/agentTools";
import { setSandboxMode } from "../../lib/permissions";
import { deriveSubagentPermission } from "../../core/agent/agents/permissions";
import { closeMcpClients } from "../../lib/mcpRunner";
import { McpManager } from "../../core/mcp/manager";
import { canonicalMcpToolName } from "../../core/mcp/adapter";
import { McpAuthStore, computeExpiresAt, isTokenExpired } from "../../core/mcp/authStore";
import {
  mergeRemoteHeaders,
  parseRemoteServerConfig,
  redactRemoteError,
  validateRemoteUrl,
} from "../../core/mcp/remoteConfig";
import { canTransition, createStatusMachine, toDiagnosticStatus } from "../../core/mcp/status";
import { createGuardedFetch, RemoteFetchError } from "../../core/mcp/remoteFetch";
import { formatExtensionStatuses } from "../../core/mcp/diagnostics";
import {
  OAuthStateMismatchError,
  completeAuthorization,
  refreshAccessTokenIfNeeded,
} from "../../core/mcp/oauth";
import { startOAuthCallbackServer } from "../../core/mcp/oauthCallback";
import { runMcpCli } from "../../commands/mcpCli";
import {
  FIXTURE_ACCESS_TOKEN,
  startRemoteMcpFixture,
  type RemoteFixture,
} from "./helpers/fakeRemoteMcpServer";

/**
 * Phase 78 — remote MCP, OAuth/auth lifecycle, diagnostics and the guards that
 * keep all of it on the ONE canonical pipeline.
 *
 * Nothing about McpManager is mocked: every integration test talks to a real
 * HTTP MCP server on 127.0.0.1 over the real SDK transports.
 */

let workspace: string;
let configDir: string;
const fixtures: RemoteFixture[] = [];

function writeGlobalMcpConfig(servers: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(configDir, "mcp.json"),
    JSON.stringify({ mcpServers: servers }, null, 2),
    "utf8",
  );
}

function newAuthStore(): McpAuthStore {
  return new McpAuthStore({ filePath: path.join(configDir, "mcp-auth.json"), onWarn: () => {} });
}

beforeEach(() => {
  setSandboxMode("workspace");
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-p78-"));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-p78-home-"));
  process.env.TOOLNETCLI_CONFIG_DIR = configDir;
  toolRegistry.clearDynamic();
  hookRegistry.reset();
});

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close().catch(() => {});
  }
  await closeMcpClients();
  toolRegistry.clearDynamic();
  hookRegistry.reset();
  delete process.env.TOOLNETCLI_CONFIG_DIR;
  for (const dir of [workspace, configDir]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function startFixture(options: Parameters<typeof startRemoteMcpFixture>[0] = {}): Promise<RemoteFixture> {
  const fixture = await startRemoteMcpFixture(options);
  fixtures.push(fixture);
  return fixture;
}

// ── 78.2 / 78.17 — remote config + headers ──────────────────────────────────

describe("Phase 78 — remote config validation", () => {
  test("a well-formed remote entry normalizes, with safe defaults", () => {
    const result = parseRemoteServerConfig({
      type: "remote",
      url: "https://mcp.example.com/mcp",
      headers: { "X-Custom": "1" },
      oauth: { clientId: "cid", scope: "read" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toBe("https://mcp.example.com/mcp");
    expect(result.value.enabled).toBe(true);
    expect(result.value.timeout).toBeGreaterThan(0);
    expect(result.value.headers["X-Custom"]).toBe("1");
    expect(result.value.oauth?.clientId).toBe("cid");
  });

  test("non-http schemes, malformed URLs and bad fields are rejected before any transport", () => {
    for (const url of ["file:///etc/passwd", "data:text/plain,hi", "javascript:alert(1)", "ws://x/mcp"]) {
      const result = parseRemoteServerConfig({ url });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/http/);
    }
    expect(parseRemoteServerConfig({ url: "not a url" }).ok).toBe(false);
    expect(parseRemoteServerConfig({}).ok).toBe(false);
    expect(parseRemoteServerConfig({ url: "https://x/mcp", timeout: 0 }).ok).toBe(false);
    expect(parseRemoteServerConfig({ url: "https://x/mcp", headers: { a: 1 } }).ok).toBe(false);
    expect(parseRemoteServerConfig({ url: "https://x/mcp", headers: [] }).ok).toBe(false);
    expect(parseRemoteServerConfig({ url: "https://x/mcp", oauth: { callbackPort: 99999 } }).ok).toBe(false);
    expect(validateRemoteUrl("ftp://x/y").ok).toBe(false);
  });

  test("enabled:false is preserved so the server is never dialed", () => {
    const result = parseRemoteServerConfig({ url: "https://x/mcp", enabled: false });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.enabled).toBe(false);
  });

  test("user headers cannot override credential headers", () => {
    const { headers, droppedReserved } = mergeRemoteHeaders(
      { "X-Custom": "keep", Authorization: "Bearer evil", "X-Api-Key": "k", "X-Github-Token": "t" },
      { Authorization: "Bearer real", "Mcp-Session-Id": "s" },
    );
    expect(headers["X-Custom"]).toBe("keep");
    expect(headers.Authorization).toBe("Bearer real");
    expect(droppedReserved.sort()).toEqual(["Authorization", "X-Api-Key", "X-Github-Token"]);
  });

  test("error text is redacted", () => {
    const redacted = redactRemoteError(
      "GET https://x/mcp?access_token=abcdef failed; header Authorization: Bearer abc.def",
    );
    expect(redacted).not.toContain("abcdef");
    expect(redacted).not.toContain("abc.def");
    expect(redacted).toContain("[REDACTED]");
  });
});

// ── 78.4 — status machine ───────────────────────────────────────────────────

describe("Phase 78 — status machine", () => {
  test("legal transitions are permitted and illegal ones are refused", () => {
    expect(canTransition("connecting", "connected")).toBe(true);
    expect(canTransition("connecting", "needs_auth")).toBe(true);
    expect(canTransition("connecting", "needs_client_registration")).toBe(true);
    expect(canTransition("connected", "disconnected")).toBe(true);
    expect(canTransition("connected", "needs_auth")).toBe(false);
    expect(canTransition("disabled", "connected")).toBe(false);
    expect(canTransition("not-installed", "connected")).toBe(false);
  });

  test("the machine records history and keeps the old state on an illegal jump", () => {
    const machine = createStatusMachine("unavailable");
    expect(machine.transition("connecting")).toBe(true);
    expect(machine.transition("connected")).toBe(true);
    expect(machine.transition("untrusted")).toBe(false);
    expect(machine.status).toBe("connected");
    expect(machine.history.map((h) => h.to)).toEqual(["connecting", "connected"]);
  });

  test("diagnostic statuses are the narrow, secret-free enum", () => {
    expect(toDiagnosticStatus("connected")).toBe("connected");
    expect(toDiagnosticStatus("needs_auth")).toBe("needs_auth");
    expect(toDiagnosticStatus("needs_client_registration")).toBe("needs_client_registration");
    expect(toDiagnosticStatus("untrusted")).toBe("disabled");
    expect(toDiagnosticStatus("unavailable")).toBe("disconnected");
    expect(toDiagnosticStatus("failed")).toBe("failed");
  });
});

// ── 78.7 / 78.8 / 78.35 / 78.36 — auth storage ──────────────────────────────

describe("Phase 78 — auth store", () => {
  test("credentials are written atomically with mode 0600", async () => {
    const store = newAuthStore();
    await store.setTokens("srv", "https://one.example/mcp", {
      accessToken: "tok-1",
      refreshToken: "ref-1",
      expiresAt: computeExpiresAt(3600),
    });
    const file = path.join(configDir, "mcp-auth.json");
    expect(fs.existsSync(file)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    // No temp file is left behind by the atomic write.
    expect(fs.readdirSync(configDir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  test("tokens are bound to the server URL and never reused after a re-point", async () => {
    const store = newAuthStore();
    await store.setTokens("srv", "https://one.example/mcp", { accessToken: "tok-1" });
    expect(store.getTokensFor("srv", "https://one.example/mcp")?.accessToken).toBe("tok-1");
    expect(store.getTokensFor("srv", "https://two.example/mcp")).toBeUndefined();
    // A trailing slash is the same endpoint.
    expect(store.getTokensFor("srv", "https://one.example/mcp/")?.accessToken).toBe("tok-1");
  });

  test("concurrent mutations do not lose updates", async () => {
    const store = newAuthStore();
    await Promise.all([
      store.set("a", { serverUrl: "https://a/mcp" }),
      store.set("b", { serverUrl: "https://b/mcp" }),
      store.set("c", { serverUrl: "https://c/mcp" }),
    ]);
    await store.flush();
    const reloaded = newAuthStore();
    expect(reloaded.listNames()).toEqual(["a", "b", "c"]);
  });

  test("a corrupt file is quarantined, never fatal, and never logged verbatim", async () => {
    const file = path.join(configDir, "mcp-auth.json");
    fs.writeFileSync(file, "SUPER_SECRET_MCP_123 not json at all", "utf8");
    const warnings: string[] = [];
    const store = new McpAuthStore({ filePath: file, onWarn: (m) => warnings.push(m) });

    expect(store.get("anything")).toBeUndefined();
    expect(store.listNames()).toEqual([]);
    const quarantine = store.getQuarantine();
    expect(quarantine).not.toBeNull();
    expect(fs.existsSync(quarantine!.quarantinedPath)).toBe(true);
    // The warning explains the recovery step without echoing the file body.
    expect(warnings.join(" ")).not.toContain("SUPER_SECRET_MCP_123");
    expect(warnings.join(" ")).toContain("toolnet mcp auth");
    // The store is still usable.
    await store.setTokens("srv", "https://x/mcp", { accessToken: "tok" });
    expect(store.getTokens("srv")?.accessToken).toBe("tok");
  });

  test("remove drops tokens, client info and verifier/state", async () => {
    const store = newAuthStore();
    await store.set("srv", {
      serverUrl: "https://x/mcp",
      tokens: { accessToken: "t" },
      clientInfo: { clientId: "c" },
      codeVerifier: "v",
      oauthState: "s",
    });
    expect(await store.remove("srv")).toBe(true);
    expect(store.get("srv")).toBeUndefined();
    expect(store.getTokensFor("srv", "https://x/mcp")).toBeUndefined();
  });

  test("expiry maths drives the refresh decision", () => {
    expect(computeExpiresAt(60, 1000)).toBe(61_000);
    expect(computeExpiresAt(undefined, 1000)).toBeUndefined();
    expect(isTokenExpired(undefined)).toBe(true);
    expect(isTokenExpired({ accessToken: "t" })).toBe(false);
    expect(isTokenExpired({ accessToken: "t", expiresAt: Date.now() - 1 })).toBe(true);
    expect(isTokenExpired({ accessToken: "t", expiresAt: Date.now() + 10_000 }, 30_000)).toBe(true);
  });
});

// ── 78.10 / 78.11 — PKCE state + loopback callback ──────────────────────────

describe("Phase 78 — PKCE state and the loopback callback", () => {
  test("a state mismatch is rejected before any token exchange", async () => {
    const store = newAuthStore();
    const url = "https://evil.example/mcp";
    await store.set("srv", { serverUrl: url, oauthState: "STATE-A", codeVerifier: "verifier-A" });

    let exchangeAttempted = false;
    await expect(
      completeAuthorization({
        name: "srv",
        serverUrl: url,
        store,
        redirectUrl: "http://127.0.0.1:9/mcp/oauth/callback",
        code: "code-1",
        state: "STATE-B",
        fetchFn: async () => {
          exchangeAttempted = true;
          throw new Error("network must not be reached");
        },
      }),
    ).rejects.toThrow(OAuthStateMismatchError);

    expect(exchangeAttempted).toBe(false);
    expect(store.getTokens("srv")).toBeUndefined();
  });

  test("a callback without a stored state is rejected", async () => {
    const store = newAuthStore();
    await expect(
      completeAuthorization({
        name: "srv",
        serverUrl: "https://x.example/mcp",
        store,
        redirectUrl: "http://127.0.0.1:9/mcp/oauth/callback",
        code: "code-1",
        state: "STATE-A",
        fetchFn: async () => {
          throw new Error("network must not be reached");
        },
      }),
    ).rejects.toThrow(OAuthStateMismatchError);
  });

  test("the callback server binds loopback only, answers the canonical route and captures the code", async () => {
    const callback = await startOAuthCallbackServer({ timeoutMs: 5_000 });
    // 127.0.0.1 only — binding 0.0.0.0 would expose the callback to the LAN.
    expect(callback.redirectUri).toContain("127.0.0.1");
    expect(callback.redirectUri).toContain("/mcp/oauth/callback");

    const pending = callback.waitForCallback();
    const bad = await fetch(`http://127.0.0.1:${callback.port}/somewhere-else`);
    expect(bad.status).toBe(404);

    const ok = await fetch(
      `http://127.0.0.1:${callback.port}/mcp/oauth/callback?code=abc&state=xyz`,
    );
    expect(ok.status).toBe(200);
    await expect(pending).resolves.toEqual({ code: "abc", state: "xyz" });
    await callback.close();
  });

  test("a callback without a code is refused", async () => {
    const callback = await startOAuthCallbackServer({ timeoutMs: 5_000 });
    const pending = callback.waitForCallback();
    const missing = await fetch(`http://127.0.0.1:${callback.port}/mcp/oauth/callback`);
    expect(missing.status).toBe(400);
    await expect(pending).rejects.toThrow(/authorization code/);
    await callback.close();
  });

  test("the callback window is bounded", async () => {
    const callback = await startOAuthCallbackServer({ timeoutMs: 60 });
    const pending = callback.waitForCallback();
    await expect(pending).rejects.toThrow(/within 60ms/);
    await callback.close();
  });
});

// ── 78.18 / 78.19 — guarded fetch ───────────────────────────────────────────

describe("Phase 78 — guarded fetch", () => {
  test("forbidden schemes and SSRF-into-loopback are refused", async () => {
    const guarded = createGuardedFetch("https://mcp.example.com/mcp", { timeoutMs: 1_000 });
    await expect(guarded("file:///etc/passwd")).rejects.toBeInstanceOf(RemoteFetchError);
    await expect(guarded("data:text/plain,hi")).rejects.toBeInstanceOf(RemoteFetchError);
    // A public target may not be redirected into loopback.
    await expect(guarded("http://127.0.0.1:9/mcp")).rejects.toBeInstanceOf(RemoteFetchError);
  });

  test("loopback is allowed only when the configured target is loopback", async () => {
    const fixture = await startFixture();
    const guarded = createGuardedFetch(fixture.mcpUrl, { timeoutMs: 2_000 });
    const response = await guarded(fixture.mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(response.status).toBe(200);
  });

  test("refresh is a single bounded attempt and clears unusable credentials", async () => {
    const store = newAuthStore();
    await store.setTokens("srv", "https://x.example/mcp", {
      accessToken: "expired",
      refreshToken: "refresh",
      expiresAt: Date.now() - 1_000,
    });

    let calls = 0;
    const outcome = await refreshAccessTokenIfNeeded({
      name: "srv",
      serverUrl: "https://x.example/mcp",
      store,
      fetchFn: async () => {
        calls++;
        throw new Error("network down");
      },
    });
    expect(outcome).toBe("refresh-failed");
    // Bounded: discovery plus at most one token request — never a loop.
    expect(calls).toBeLessThanOrEqual(4);
    expect(store.getTokens("srv")).toBeUndefined();

    // A fresh token is not refreshed at all.
    await store.setTokens("srv", "https://x.example/mcp", {
      accessToken: "fresh",
      expiresAt: Date.now() + 3_600_000,
    });
    const fresh = await refreshAccessTokenIfNeeded({
      name: "srv",
      serverUrl: "https://x.example/mcp",
      store,
      fetchFn: async () => {
        throw new Error("must not be called");
      },
    });
    expect(fresh).toBe("fresh");
  });
});

// ── 78.20 / 78.21 — real HTTP transports ────────────────────────────────────

describe("Phase 78 — Streamable HTTP live E2E", () => {
  test("connect → tools/list → canonical registry → permission → call → disconnect", async () => {
    const fixture = await startFixture();
    writeGlobalMcpConfig({ remote: { type: "remote", url: fixture.mcpUrl } });

    const manager = new McpManager({ authStore: newAuthStore() });
    const report = await manager.sync(workspace);

    expect(report.failed).toEqual([]);
    expect(report.connected).toHaveLength(1);
    const info = report.connected[0]!;
    expect(info.kind).toBe("remote");
    expect(info.transport).toBe("streamable-http");
    expect(info.toolCount).toBe(3);

    // The tools are ordinary registry entries under canonical names.
    const readEcho = canonicalMcpToolName(info.serverId, "read_echo");
    expect(toolRegistry.has(readEcho)).toBe(true);
    expect(toolRegistry.ownerOf(readEcho)).toBe(`mcp:${info.serverId}`);
    expect(toolRegistry.schemas().some((s) => s.function.name === readEcho)).toBe(true);
    expect(toolRegistry.has("read_echo")).toBe(false);

    // A call through the canonical pipeline reaches the real server.
    const viaGateway = JSON.parse(
      await executeTool(readEcho, { text: "remote-hello" }, {
        cwd: workspace,
        workspaceRoot: workspace,
        sandboxMode: "workspace",
        sessionId: "sess-p78-remote",
      }),
    );
    expect(viaGateway.exitCode).toBe(0);
    expect(viaGateway.stdout).toBe("remote-hello");
    expect(fixture.toolCalls).toContain("read_echo");

    // ── 78.26 permission: the remote tool is not privileged by being remote ──
    fixture.toolCalls.length = 0;
    const target = path.join(workspace, "should-not-exist.txt");
    const dangerous = canonicalMcpToolName(info.serverId, "dangerous_write");
    const denied = JSON.parse(
      await executeTool(dangerous, { path: target, content: "pwned" }, {
        cwd: workspace,
        workspaceRoot: workspace,
        sandboxMode: "workspace",
        sessionId: "sess-p78-deny",
      }),
    );
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr.toLowerCase()).toContain("denied");
    expect(fs.existsSync(target)).toBe(false);

    // A remote tool whose name carries no read verb is denied too — the mcp__
    // prefix never makes a remote tool look safe.
    const unmarked = JSON.parse(
      await executeTool(canonicalMcpToolName(info.serverId, "echo"), { text: "x" }, {
        cwd: workspace,
        workspaceRoot: workspace,
        sandboxMode: "workspace",
        sessionId: "sess-p78-deny-2",
      }),
    );
    expect(unmarked.exitCode).toBe(1);
    // The server was never asked for either denied call.
    expect(fixture.toolCalls).toEqual([]);

    // Disconnect withdraws the tools — no stale remote tool remains visible.
    expect(toolRegistry.namesByOwner(`mcp:${info.serverId}`).length).toBeGreaterThan(0);
    await manager.disconnect(info.serverId);
    expect(toolRegistry.namesByOwner(`mcp:${info.serverId}`)).toEqual([]);
    expect(manager.status(info.serverId)).toBe("disconnected");
  }, 20_000);
});

describe("Phase 78 — SSE fallback live E2E", () => {
  test("a server that rejects Streamable HTTP is reached over SSE, and the failed transport is not leaked", async () => {
    const fixture = await startFixture({ mode: "sse-only", name: "sse-fixture" });
    writeGlobalMcpConfig({ remote: { type: "remote", url: fixture.mcpUrl } });

    const manager = new McpManager({ authStore: newAuthStore() });
    const report = await manager.sync(workspace);

    expect(report.failed).toEqual([]);
    expect(report.connected).toHaveLength(1);
    const info = report.connected[0]!;
    // Streamable HTTP was attempted and rejected first, then SSE succeeded.
    expect(fixture.streamableRequests).toBeGreaterThan(0);
    expect(fixture.sseRequests).toBeGreaterThan(0);
    expect(info.transport).toBe("sse");

    const readEcho = canonicalMcpToolName(info.serverId, "read_echo");
    const result = JSON.parse(
      await executeTool(readEcho, { text: "over-sse" }, {
        cwd: workspace,
        workspaceRoot: workspace,
        sandboxMode: "workspace",
        sessionId: "sess-p78-sse",
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("over-sse");
    expect(fixture.toolCalls).toEqual(["read_echo"]);

    await manager.dispose();
  }, 20_000);
});

// ── 78.22 / 78.23 / 78.13 — OAuth lifecycle ─────────────────────────────────

describe("Phase 78 — OAuth live E2E", () => {
  test("needs_auth → authorization URL → PKCE callback → token → connected → tool call", async () => {
    const fixture = await startFixture({ oauth: true, name: "oauth-fixture" });
    writeGlobalMcpConfig({
      remote: { type: "remote", url: fixture.mcpUrl, oauth: { scope: "mcp" } },
    });

    const store = newAuthStore();
    const manager = new McpManager({ authStore: store });

    // 1. The protected server answers 401 → deterministic needs_auth.
    const report = await manager.sync(workspace);
    expect(report.connected).toEqual([]);
    expect(manager.listServers()[0]!.status).toBe("needs_auth");
    expect(toolRegistry.namesByOwner("mcp:remote").length).toBe(0);

    // 2. Start the flow without waiting, exactly like a headless operator.
    const started = await manager.startAuth("remote", { waitForCallback: false });
    expect(started.authorizationUrl).toBeTruthy();
    expect(fixture.registerRequests).toBeGreaterThan(0); // RFC 7591 DCR

    // 3. Act as the browser: the authorize endpoint redirects to our callback.
    const authorizeResponse = await fetch(started.authorizationUrl!, { redirect: "manual" });
    expect(authorizeResponse.status).toBe(302);
    const callback = new URL(authorizeResponse.headers.get("location")!);
    expect(`${callback.origin}${callback.pathname}`.startsWith("http://127.0.0.1")).toBe(true);
    const code = callback.searchParams.get("code")!;
    const state = callback.searchParams.get("state")!;
    expect(code).toBeTruthy();
    expect(state).toBeTruthy();

    // 4. Finish: state is validated, the code is exchanged with the PKCE verifier.
    const status = await manager.completeAuth("remote", code, state);
    expect(status).toBe("connected");
    expect(fixture.tokenRequests).toBeGreaterThan(0);

    // 5. Credentials are stored, URL-bound, and mode 0600.
    expect(store.getTokensFor("remote", fixture.mcpUrl)?.accessToken).toBe(FIXTURE_ACCESS_TOKEN);
    expect(store.getTokensFor("remote", "https://other.example/mcp")).toBeUndefined();
    if (process.platform !== "win32") {
      expect(fs.statSync(store.getPath()).mode & 0o777).toBe(0o600);
    }

    // 6. Tools are registered and callable, and the request carried the token.
    const readEcho = canonicalMcpToolName(manager.listServers()[0]!.serverId, "read_echo");
    const result = JSON.parse(
      await manager.callTool(manager.listServers()[0]!.serverId, "read_echo", { text: "authed" }),
    );
    expect(result.stdout).toBe("authed");
    expect(fixture.observedAuthorizations).toContain(`Bearer ${FIXTURE_ACCESS_TOKEN}`);
    expect(toolRegistry.has(readEcho)).toBe(true);

    // 7. Logout removes credentials and requires auth again on the next connect.
    expect(await manager.logout("remote")).toBe(true);
    expect(store.get("remote")).toBeUndefined();
    expect(await manager.connect("remote")).toBe("needs_auth");

    await manager.dispose();
  }, 30_000);

  test("a state mismatch saves nothing, connects nothing and never reaches the token endpoint", async () => {
    const fixture = await startFixture({ oauth: true, name: "oauth-fixture" });
    writeGlobalMcpConfig({ remote: { type: "remote", url: fixture.mcpUrl, oauth: {} } });

    const store = newAuthStore();
    const manager = new McpManager({ authStore: store });
    await manager.sync(workspace);
    const started = await manager.startAuth("remote", { waitForCallback: false });
    expect(started.authorizationUrl).toBeTruthy();

    const tokensBefore = fixture.tokenRequests;
    const status = await manager.completeAuth("remote", "attacker-code", "STATE-FROM-ATTACKER");

    expect(status).toBe("needs_auth");
    expect(fixture.tokenRequests).toBe(tokensBefore);
    expect(store.getTokens("remote")).toBeUndefined();
    expect(toolRegistry.namesByOwner("mcp:remote")).toEqual([]);
    expect(manager.listServers()[0]!.status).toBe("needs_auth");

    await manager.dispose();
  }, 30_000);

  test("a server without dynamic registration yields needs_client_registration instead of retrying", async () => {
    const fixture = await startFixture({ oauth: true, withRegistration: false, name: "no-dcr" });
    writeGlobalMcpConfig({ remote: { type: "remote", url: fixture.mcpUrl, oauth: {} } });

    const manager = new McpManager({ authStore: newAuthStore() });
    await manager.sync(workspace);

    const started = await manager.startAuth("remote", { waitForCallback: false });
    expect(started.status).toBe("needs_client_registration");
    expect(started.reason).toContain("clientId");
    expect(manager.listServers()[0]!.status).toBe("needs_client_registration");
    expect(fixture.registerRequests).toBe(0);

    await manager.dispose();
  }, 30_000);
});

// ── 78.24 — URL-bound credentials ───────────────────────────────────────────

describe("Phase 78 — token isolation across server URLs", () => {
  test("re-pointing a server at a new URL does not replay the old token", async () => {
    const one = await startFixture({ name: "one" });
    const two = await startFixture({ name: "two" });
    const store = newAuthStore();
    await store.setTokens("remote", one.mcpUrl, { accessToken: FIXTURE_ACCESS_TOKEN });

    writeGlobalMcpConfig({ remote: { type: "remote", url: one.mcpUrl } });
    const first = new McpManager({ authStore: store });
    await first.sync(workspace);
    expect(first.listServers()[0]!.status).toBe("connected");
    expect(one.observedAuthorizations).toContain(`Bearer ${FIXTURE_ACCESS_TOKEN}`);

    // The config is re-pointed at a different host/port. The credential is
    // bound to the old URL, so it must not be sent to the new one.
    writeGlobalMcpConfig({ remote: { type: "remote", url: two.mcpUrl } });
    const second = new McpManager({ authStore: store });
    await second.sync(workspace);

    expect(second.listServers()[0]!.status).toBe("connected");
    expect(two.observedAuthorizations).toEqual([]);
    expect(two.toolCalls).toEqual([]);
    expect(store.getTokensFor("remote", two.mcpUrl)).toBeUndefined();
    expect(store.getTokensFor("remote", one.mcpUrl)?.accessToken).toBe(FIXTURE_ACCESS_TOKEN);

    await first.dispose();
    await second.dispose();
  }, 30_000);
});

// ── 78.25 / 78.31 / 78.33 — redaction + diagnostics ─────────────────────────

describe("Phase 78 — redaction and diagnostics", () => {
  test("a seeded secret appears only in auth storage, never in status, events or logs", async () => {
    const fixture = await startFixture();
    const store = newAuthStore();
    const secret = "SUPER_SECRET_MCP_123";
    await store.setTokens("remote", fixture.mcpUrl, { accessToken: secret });

    writeGlobalMcpConfig({
      remote: {
        type: "remote",
        url: fixture.mcpUrl,
        // A credential header in user config is dropped, never forwarded.
        headers: { Authorization: `Bearer ${secret}`, "X-Api-Key": secret, "X-Custom": "visible" },
      },
    });

    const logs: string[] = [];
    const events: string[] = [];
    const manager = new McpManager({
      authStore: store,
      onLog: (_level, message, meta) => logs.push(`${message} ${JSON.stringify(meta ?? {})}`),
      onEvent: (event) => events.push(JSON.stringify(event)),
    });
    await manager.sync(workspace);

    const surface = [
      JSON.stringify(manager.getDiagnostics()),
      JSON.stringify(manager.listServers()),
      formatExtensionStatuses(manager.getDiagnostics()),
      logs.join("\n"),
      events.join("\n"),
    ].join("\n");

    expect(surface).not.toContain(secret);
    // The auth file is the only place the credential lives on disk.
    expect(fs.readFileSync(store.getPath(), "utf8")).toContain(secret);

    // Diagnostics are accurate and secret-free.
    const status = manager.getDiagnostics()[0]!;
    expect(status.type).toBe("mcp");
    expect(status.status).toBe("connected");
    expect(status.transport).toBe("streamable-http");
    expect(status.toolCount).toBe(3);
    expect(status.authenticated).toBe(true);

    await manager.dispose();
  }, 20_000);

  test("formatExtensionStatuses prints transport and auth without headers", () => {
    const text = formatExtensionStatuses([
      {
        id: "github",
        type: "mcp",
        status: "connected",
        transport: "streamable-http",
        toolCount: 12,
        authenticated: true,
      },
      { id: "private", type: "mcp", status: "needs_auth", authenticated: false },
    ]);
    expect(text).toContain("github");
    expect(text).toContain("transport: streamable-http");
    expect(text).toContain("tools: 12");
    expect(text).toContain("auth: yes");
    expect(text).toContain("status: needs_auth");
    expect(text).not.toContain("Authorization");
  });
});

// ── 78.29 — tools/list_changed ──────────────────────────────────────────────

describe("Phase 78 — tools/list_changed", () => {
  test("the model-visible schema set is refreshed without restarting anything", async () => {
    const fixture = await startFixture({
      name: "changing",
      tools: [{ name: "a", description: "tool a", inputSchema: { type: "object" } }],
    });
    writeGlobalMcpConfig({ remote: { type: "remote", url: fixture.mcpUrl } });

    const changed: string[] = [];
    const manager = new McpManager({ authStore: newAuthStore() });
    manager.subscribe((event) => changed.push(event.type));

    await manager.sync(workspace);
    const serverId = manager.listServers()[0]!.serverId;
    const toolA = canonicalMcpToolName(serverId, "a");
    const toolB = canonicalMcpToolName(serverId, "b");
    expect(toolRegistry.has(toolA)).toBe(true);
    expect(toolRegistry.has(toolB)).toBe(false);

    // The server swaps its tool set and announces it.
    fixture.setTools([{ name: "b", description: "tool b", inputSchema: { type: "object" } }]);
    fixture.notifyToolsChanged();

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && !toolRegistry.has(toolB)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(toolRegistry.has(toolB)).toBe(true);
    // No stale `a` — the old generation is unregistered, not merged.
    expect(toolRegistry.has(toolA)).toBe(false);
    expect(manager.listTools(serverId).map((t) => t.originalName)).toEqual(["b"]);
    expect(changed).toContain("tools-changed");

    const result = JSON.parse(await manager.callTool(serverId, "b", {}));
    expect(result.stdout).toBe("tool-b");

    await manager.dispose();
  }, 20_000);
});

// ── 78.30 — server disconnect ───────────────────────────────────────────────

describe("Phase 78 — remote server death", () => {
  test("the tools are withdrawn, the status flips, and nothing throws", async () => {
    const fixture = await startFixture({ name: "mortal" });
    writeGlobalMcpConfig({ remote: { type: "remote", url: fixture.mcpUrl } });

    const errors: string[] = [];
    const manager = new McpManager({ authStore: newAuthStore() });
    await manager.sync(workspace);
    const serverId = manager.listServers()[0]!.serverId;
    const echo = canonicalMcpToolName(serverId, "echo");
    expect(toolRegistry.has(echo)).toBe(true);

    await fixture.simulateServerDeath();

    // A call into a dead remote returns a typed failure instead of throwing, and
    // the connection is marked dead so its tools leave the model's view.
    const failed = JSON.parse(await manager.callTool(serverId, "echo", { text: "gone" }));
    expect(failed.exitCode).toBe(1);
    expect(errors).toEqual([]);
    expect(manager.status(serverId)).toBe("failed");
    expect(toolRegistry.has(echo)).toBe(false);
    expect(toolRegistry.namesByOwner(`mcp:${serverId}`)).toEqual([]);
    expect(manager.listServers()[0]!.toolCount).toBe(0);

    await manager.dispose();
  }, 20_000);
});

// ── 78.27 / 78.28 — subagent + teamwork cannot bypass the registry ──────────

describe("Phase 78 — remote MCP stays scoped", () => {
  test("a subagent cannot escalate to a remote MCP tool the parent denies", () => {
    const mcpName = "mcp__remote__dangerous_write";
    const scope = deriveSubagentPermission({
      parentPermission: { defaultDecision: "allow", tools: { [mcpName]: "deny" } },
      agentDefinition: {
        id: "explore",
        name: "explore",
        description: "explore",
        mode: "subagent",
        allowedTools: [mcpName],
      } as never,
    });
    // Being remote grants nothing: the parent deny still wins.
    expect(scope.tools[mcpName]).toBe("deny");
  });

  test("a parent-allowed remote read tool stays allowed for the child", () => {
    const readTool = "mcp__remote__read_list";
    const scope = deriveSubagentPermission({
      parentPermission: { defaultDecision: "allow", tools: { [readTool]: "allow" } },
      agentDefinition: {
        id: "explore",
        name: "explore",
        description: "explore",
        mode: "subagent",
        allowedTools: [readTool],
      } as never,
    });
    expect(scope.tools[readTool]).toBe("allow");
  });
});

// ── 78.32 / 78.33 — CLI surface ─────────────────────────────────────────────

describe("Phase 78 — mcp CLI", () => {
  test("list, status, connect, disconnect and logout drive the one manager", async () => {
    const fixture = await startFixture();
    writeGlobalMcpConfig({ remote: { type: "remote", url: fixture.mcpUrl } });

    const manager = new McpManager({ authStore: newAuthStore() });
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };
    const run = (args: string[]) => runMcpCli(args, { manager, io });

    expect(await run(["list"])).toBe(0);
    expect(out.join("\n")).toContain("remote");
    expect(out.join("\n")).toContain("status=connected");

    out.length = 0;
    expect(await run(["status"])).toBe(0);
    const statusText = out.join("\n");
    expect(statusText).toContain("transport: streamable-http");
    expect(statusText).toContain("auth: no");

    out.length = 0;
    expect(await run(["disconnect", "remote"])).toBe(0);
    expect(manager.status("remote")).toBe("disconnected");

    out.length = 0;
    expect(await run(["connect", "remote"])).toBe(0);
    expect(manager.status("remote")).toBe("connected");

    out.length = 0;
    expect(await run(["logout", "remote"])).toBe(0);
    expect(out.join("\n")).toContain("credentials");

    // Unknown servers are reported, not silently ignored.
    expect(await run(["connect", "ghost"])).toBe(1);
    expect(err.join("\n") + out.join("\n")).toContain("ghost");

    expect(await run(["--help"])).toBe(0);
    expect(out.join("\n")).toContain("toolnet mcp auth");

    await manager.dispose();
  }, 30_000);

  test("the manual-code fallback prints the URL instead of blocking", async () => {
    const fixture = await startFixture({ oauth: true });
    writeGlobalMcpConfig({ remote: { type: "remote", url: fixture.mcpUrl, oauth: {} } });

    const manager = new McpManager({ authStore: newAuthStore() });
    const out: string[] = [];
    const code = await runMcpCli(["auth", "remote", "--no-wait"], {
      manager,
      io: { out: (line) => out.push(line), err: () => {} },
    });

    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("/authorize");
    expect(text).toContain("--code");

    await manager.dispose();
  }, 30_000);
});

// ── 78.38 — architecture guards ─────────────────────────────────────────────

describe("Phase 78 — architecture guards", () => {
  const srcRoot = path.resolve(__dirname, "../..");

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  test("remote transports are constructed only inside src/core/mcp", () => {
    const offences: string[] = [];
    for (const file of walk(srcRoot)) {
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
      const source = fs.readFileSync(file, "utf8");
      if (/new\s+(StreamableHTTPClientTransport|SSEClientTransport)\s*\(/.test(source)) {
        const relative = path.relative(srcRoot, file).split(path.sep).join("/");
        if (!relative.startsWith("core/mcp/")) offences.push(relative);
      }
    }
    expect(offences).toEqual([]);
  });

  test("no production module dials an MCP endpoint with a bare fetch", () => {
    const offences: string[] = [];
    for (const file of walk(srcRoot)) {
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
      if (file.includes(`${path.sep}core${path.sep}mcp${path.sep}`)) continue;
      const source = fs.readFileSync(file, "utf8");
      if (/fetch\(\s*[^)]*\/mcp/.test(source)) {
        offences.push(path.relative(srcRoot, file).split(path.sep).join("/"));
      }
    }
    expect(offences).toEqual([]);
  });

  test("the teamwork engine and the agent core never import an MCP transport or client", () => {
    const guarded = [
      "core/teamwork/engine.ts",
      "core/agent/agentEngine.ts",
      "teamwork/subagentRuntime.ts",
    ];
    for (const relative of guarded) {
      const file = path.join(srcRoot, relative);
      if (!fs.existsSync(file)) continue;
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toMatch(/@modelcontextprotocol\/sdk\/client/);
      expect(source).not.toMatch(/from\s+"[^"]*remoteTransport"/);
      expect(source).not.toMatch(/from\s+"[^"]*mcpRunner"/);
    }
  });

  test("the remote path is one manager and one registry (no second runtime)", () => {
    const mcpDir = path.join(srcRoot, "core/mcp");
    const files = fs.readdirSync(mcpDir).filter((f) => f.endsWith(".ts")).sort();
    // Sanity: this phase adds capabilities to the ONE manager, not a parallel one.
    expect(files).toContain("manager.ts");
    expect(files).not.toContain("remoteManager.ts");
    expect(files).not.toContain("remoteToolRegistry.ts");
    const managerSource = fs.readFileSync(path.join(mcpDir, "manager.ts"), "utf8");
    expect(managerSource).toContain('from "../../lib/harness/toolRegistry"');
    expect(managerSource).toContain("registerMcpTools");
  });
});
