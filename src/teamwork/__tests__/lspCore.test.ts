/**
 * Phase 74.7 — LSP core unit tests.
 *
 * Everything here is deterministic: no language-server binary, no network. The
 * in-memory transport drives the production client/manager code paths.
 */

import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LspClient } from "../../core/lsp/client";
import {
  countBySeverity,
  formatDiagnosticsReport,
  normalizeDiagnostics,
  severityName,
} from "../../core/lsp/diagnostics";
import { detectLanguageId, extensionOf } from "../../core/lsp/languages";
import { LspManager } from "../../core/lsp/manager";
import { normalizeLocations, toWorkspacePath, uriToAbsolutePath, toUri } from "../../core/lsp/normalize";
import { findServerRoot, resolveServerBinary, selectServerForFile } from "../../core/lsp/servers";
import { LspMessageReader, createMemoryTransportPair, encodeLspMessage } from "../../core/lsp/transport";
import type { LspServerSpec } from "../../core/lsp/types";
import { createFakeLspServer } from "./helpers/fakeLspServer";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-lsp-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe("74.1 language detection", () => {
  test("maps extensions to LSP language ids", () => {
    expect(detectLanguageId("src/index.ts")).toBe("typescript");
    expect(detectLanguageId("App.TSX")).toBe("typescriptreact");
    expect(detectLanguageId("main.py")).toBe("python");
    expect(detectLanguageId("main.go")).toBe("go");
    expect(detectLanguageId("lib.rs")).toBe("rust");
    expect(detectLanguageId("server.cpp")).toBe("cpp");
  });

  test("unknown or extension-less files resolve to undefined", () => {
    expect(detectLanguageId("Makefile")).toBeUndefined();
    expect(detectLanguageId("data.unknownext")).toBeUndefined();
    expect(extensionOf("archive.tar.gz")).toBe(".gz");
  });
});

describe("74.2 server selection and discovery", () => {
  test("selects the server that covers the file extension", () => {
    expect(selectServerForFile("a.ts")?.id).toBe("typescript");
    expect(selectServerForFile("a.py")?.id).toBe("pyright");
    expect(selectServerForFile("a.go")?.id).toBe("gopls");
    expect(selectServerForFile("a.unknown")).toBeUndefined();
  });

  test("prefers a project-local node_modules/.bin binary", () => {
    const root = makeTempDir();
    const bin = path.join(root, "node_modules", ".bin", "typescript-language-server");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });

    const spec: LspServerSpec = {
      id: "typescript",
      languageIds: ["typescript"],
      extensions: [".ts"],
      binaries: ["typescript-language-server"],
      args: ["--stdio"],
      rootMarkers: ["package.json"],
    };

    expect(resolveServerBinary(spec, { root, workspaceRoot: root })).toBe(bin);
  });

  test("returns undefined when no binary can be found", () => {
    const root = makeTempDir();
    const spec: LspServerSpec = {
      id: "nope",
      languageIds: ["x"],
      extensions: [".x"],
      binaries: ["definitely-not-installed-anywhere-12345"],
      args: [],
      rootMarkers: [],
    };
    expect(resolveServerBinary(spec, { root, workspaceRoot: root })).toBeUndefined();
  });

  test("clamps the server root to the nearest project marker", () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, "package.json"), "{}");
    const nested = path.join(root, "packages", "app", "src");
    fs.mkdirSync(nested, { recursive: true });
    const file = path.join(nested, "index.ts");
    fs.writeFileSync(file, "export const x = 1;\n");

    const spec = selectServerForFile(file)!;
    expect(findServerRoot(spec, file, root)).toBe(root);
  });
});

describe("74.1 JSON-RPC framing", () => {
  test("round-trips a framed message", () => {
    const received: unknown[] = [];
    const reader = new LspMessageReader((message) => received.push(message));
    reader.push(encodeLspMessage({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(received).toEqual([{ jsonrpc: "2.0", id: 1, method: "ping" }]);
  });

  test("handles frames split across chunks", () => {
    const received: unknown[] = [];
    const reader = new LspMessageReader((message) => received.push(message));
    const encoded = encodeLspMessage({ hello: "world", nested: { a: [1, 2, 3] } });

    reader.push(encoded.subarray(0, 12));
    reader.push(encoded.subarray(12, 30));
    expect(received).toHaveLength(0);
    reader.push(encoded.subarray(30));
    expect(received).toEqual([{ hello: "world", nested: { a: [1, 2, 3] } }]);
  });

  test("skips malformed frames without throwing", () => {
    const received: unknown[] = [];
    const reader = new LspMessageReader((message) => received.push(message));
    const badBody = Buffer.from("{oops", "utf8");
    const bad = Buffer.concat([
      Buffer.from(`Content-Length: ${badBody.length}\r\n\r\n`, "ascii"),
      badBody,
    ]);
    reader.push(bad);
    reader.push(encodeLspMessage({ ok: true }));
    expect(received).toEqual([{ ok: true }]);
  });

  test("a header-less garbage chunk is dropped without throwing", () => {
    const received: unknown[] = [];
    const reader = new LspMessageReader((message) => received.push(message));
    expect(() => reader.push(Buffer.from("not an lsp frame at all\n", "utf8"))).not.toThrow();
    reader.push(encodeLspMessage({ ok: true }));
    expect(received).toEqual([{ ok: true }]);
  });
});

describe("74.3 request correlation, timeout and cancellation", () => {
  test("concurrent requests resolve to their own responses", async () => {
    const pair = createMemoryTransportPair();
    pair.server.onMessage((raw) => {
      const msg = raw as { id?: number; method?: string; params?: { echo?: string } };
      pair.server.send({ jsonrpc: "2.0", id: msg.id, result: { echoed: msg.params?.echo } });
    });

    const client = new LspClient({ serverId: "fake", root: "/tmp", workspaceRoot: "/tmp", transport: pair.client });
    const [a, b] = await Promise.all([
      client["request"]<{ echoed: string }>("custom/a", { echo: "first" }, { timeoutMs: 1000 }),
      client["request"]<{ echoed: string }>("custom/b", { echo: "second" }, { timeoutMs: 1000 }),
    ]);
    expect(a.echoed).toBe("first");
    expect(b.echoed).toBe("second");
    await client.shutdown();
  });

  test("times out when the server never answers", async () => {
    const server = createFakeLspServer({ silent: true });
    const client = new LspClient({
      serverId: "dead",
      root: "/tmp",
      workspaceRoot: "/tmp",
      transport: server.spawn({ id: "dead" }, "/tmp").transport,
      timeouts: { initializeMs: 200, shutdownMs: 100 },
    });
    await expect(client.start()).rejects.toThrow(/timed out|closed/i);
  });

  test("aborting a request cancels it", async () => {
    const pair = createMemoryTransportPair();
    pair.server.onMessage(() => {
      // Intentionally never replies.
    });
    const client = new LspClient({ serverId: "slow", root: "/tmp", workspaceRoot: "/tmp", transport: pair.client });
    const controller = new AbortController();
    const pending = client["request"]("never/answers", {}, { signal: controller.signal, timeoutMs: 5000 });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/i);
    await client.shutdown();
  });

  test("diagnostics resolves on timeout instead of hanging", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "a.ts");
    fs.writeFileSync(file, "export const a = 1;\n");

    const server = createFakeLspServer({}); // accepts requests but publishes nothing
    const client = new LspClient({
      serverId: "quiet",
      root: dir,
      workspaceRoot: dir,
      transport: server.spawn({ id: "quiet" }, dir).transport,
    });
    await client.start();
    const started = Date.now();
    const items = await client.diagnostics(file, { timeoutMs: 300 });
    expect(items).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3000);
    await client.shutdown();
  });
});

describe("74.6 diagnostics normalization", () => {
  test("normalizes severity, position and workspace-relative path", () => {
    const root = "/workspace";
    const uri = toUri("/workspace/src/a.ts");
    const items = normalizeDiagnostics(
      uri,
      [
        { range: { start: { line: 9, character: 4 }, end: { line: 9, character: 8 } }, severity: 1, message: "boom", code: 2304 },
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 2, message: "meh" },
      ],
      root
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ path: "src/a.ts", line: 10, character: 5, severity: "error", code: 2304 });
    expect(items[1]).toMatchObject({ severity: "warning", line: 1, character: 1 });
    expect(countBySeverity(items)).toMatchObject({ error: 1, warning: 1 });
  });

  test("deduplicates identical diagnostics", () => {
    const uri = toUri("/w/a.ts");
    const one = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, severity: 1, message: "dup", code: 1 };
    const items = normalizeDiagnostics(uri, [one, { ...one }], "/w");
    expect(items).toHaveLength(1);
  });

  test("report block only includes errors and warnings", () => {
    const items = normalizeDiagnostics(
      toUri("/w/a.ts"),
      [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, severity: 1, message: "real error" },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, severity: 4, message: "hint noise" },
      ],
      "/w"
    );
    const report = formatDiagnosticsReport("a.ts", items);
    expect(report).toContain("<diagnostics");
    expect(report).toContain("real error");
    expect(report).not.toContain("hint noise");
  });

  test("empty report for a clean file", () => {
    expect(formatDiagnosticsReport("a.ts", [])).toBe("");
    expect(severityName(1)).toBe("error");
  });
});

describe("74.2 unavailable-server fallback", () => {
  test("availability reports a missing binary and operations return empty", async () => {
    const root = makeTempDir();
    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, "export const a = 1;\n");

    const manager = new LspManager({
      workspaceRoot: root,
      cwd: root,
      resolveBinary: () => undefined,
    });

    const availability = manager.availability(file);
    expect(availability.available).toBe(false);
    expect(availability.reason).toMatch(/not found/i);
    expect(await manager.documentSymbols(file)).toEqual([]);
    expect(await manager.definition(file, { line: 0, character: 0 })).toEqual([]);
    expect(manager.probeAvailability().available).toBe(false);
  });

  test("deterministic mock spawn: symbol operation works end-to-end", async () => {
    const root = makeTempDir();
    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, "export const a = 1;\n");

    const server = createFakeLspServer({
      handlers: { documentSymbols: () => [{ name: "a", kind: "variable", path: "a.ts", line: 1, character: 14 }] },
    });
    const manager = new LspManager({ workspaceRoot: root, cwd: root, spawnServer: server.spawn, resolveBinary: () => "fake" });

    const symbols = await manager.documentSymbols(file);
    expect(symbols.map((s) => s.name)).toEqual(["a"]);
    await manager.shutdown();
  });

  test("a failing server is marked broken and not retried", async () => {
    const root = makeTempDir();
    const file = path.join(root, "a.ts");
    fs.writeFileSync(file, "export const a = 1;\n");

    let spawns = 0;
    const manager = new LspManager({
      workspaceRoot: root,
      cwd: root,
      resolveBinary: () => "fake",
      spawnServer: () => {
        spawns += 1;
        return undefined; // binary vanished between resolution and spawn
      },
    });

    expect(await manager.documentSymbols(file)).toEqual([]);
    expect(await manager.documentSymbols(file)).toEqual([]);
    expect(spawns).toBe(1);
  });
});

describe("74.4 ToolRegistry integration", () => {
  test("the lsp tool is registered once, canonically and read-only", async () => {
    const { toolRegistry } = await import("../../lib/harness/toolRegistry");
    const entry = toolRegistry.get("lsp");
    expect(entry).toBeDefined();
    expect(entry!.risk).toBe("read");
    expect(entry!.aliasOf).toBeUndefined();
    expect(toolRegistry.canonicalNames()).toContain("lsp");
    expect(toolRegistry.schemas().filter((s) => s.function.name === "lsp")).toHaveLength(1);
    expect((entry!.parameters as any).properties.operation.enum).toContain("definition");
  });

  test("the schema handed to the model matches the tool's parameter contract", async () => {
    const { LSP_TOOL_PARAMETERS } = await import("../../core/lsp/tool");
    expect(Object.keys(LSP_TOOL_PARAMETERS.properties).sort()).toEqual(
      ["character", "line", "operation", "path", "query"].sort()
    );
  });
});

describe("74.3 normalization helpers", () => {
  test("uri and path conversion never hides files outside the workspace", () => {
    expect(uriToAbsolutePath("untitled:Untitled-1")).toBeUndefined();
    expect(toWorkspacePath("/workspace/src/a.ts", "/workspace")).toBe("src/a.ts");
    expect(toWorkspacePath("/elsewhere/b.ts", "/workspace")).toBe("/elsewhere/b.ts");
  });

  test("normalizeLocations accepts LocationLink shapes", () => {
    const raw = [
      {
        targetUri: toUri("/w/src/a.ts"),
        targetRange: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } },
        targetSelectionRange: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } },
      },
    ];
    expect(normalizeLocations(raw, "/w")).toEqual([{ path: "src/a.ts", line: 5, character: 3 }]);
  });
});
