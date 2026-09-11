/**
 * Phase 74.11 — LIVE LSP acceptance.
 *
 * This suite runs against a REAL `typescript-language-server` process spawned by
 * the production `LspManager` / `LspClient` / stdio transport. It never uses
 * `createFakeLspServer` or the in-memory transport.
 *
 * It is opt-in by availability: the workspace fixture lives at
 * `/tmp/toolnet-lsp-live` (override with `TOOLNET_LSP_LIVE_WORKSPACE`). When the
 * fixture or the server binary is absent the whole suite is skipped, so CI never
 * depends on an installed language server.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { LspManager, resetLspManagers, setLspManagerForTesting } from "../../core/lsp/manager";
import { resolveServerBinary, selectServerForFile } from "../../core/lsp/servers";
import { spawnStdioServer } from "../../core/lsp/transport";
import { runLspOperation } from "../../core/lsp/tool";
import type { DiagnosticItem, LspServerSpec, SpawnedServer } from "../../core/lsp/types";

const workspace = process.env.TOOLNET_LSP_LIVE_WORKSPACE || "/tmp/toolnet-lsp-live";
const probeFile = path.join(workspace, "src", "service.ts");

/** Canonical fixture sources — rewritten before the suite so an aborted run
 * from a previous session can never poison the acceptance. */
const SERVICE_TS = `export interface User {
  id: string;
  name: string;
}

export function getUser(id: string): User {
  return { id, name: "ToolNet" };
}
`;

const CONTROLLER_TS = `import { getUser, type User } from "./service";

export function describeUser(id: string): string {
  const user: User = getUser(id);
  return \`\${user.id}:\${user.name}\`;
}
`;

const INDEX_TS = `import { getUser } from "./service";
import { describeUser } from "./controller";

const user = getUser("1");
console.log(user.name, describeUser("2"));
`;

function resetFixture(): void {
  fs.writeFileSync(path.join(workspace, "src", "service.ts"), SERVICE_TS);
  fs.writeFileSync(path.join(workspace, "src", "controller.ts"), CONTROLLER_TS);
  fs.writeFileSync(path.join(workspace, "src", "index.ts"), INDEX_TS);
}

const liveReady = (() => {
  if (!fs.existsSync(probeFile)) return false;
  const spec = selectServerForFile(probeFile);
  if (!spec) return false;
  return Boolean(resolveServerBinary(spec, { root: workspace, workspaceRoot: workspace }));
})();

const TIMEOUTS = { initializeMs: 60000, requestMs: 20000, diagnosticsMs: 20000, shutdownMs: 5000 };

let manager: LspManager;
let spawnCount = 0;
let spawnedPids: number[] = [];

function abs(rel: string): string {
  return path.join(workspace, rel);
}

function read(rel: string): string {
  return fs.readFileSync(abs(rel), "utf8");
}

function write(rel: string, content: string): void {
  fs.writeFileSync(abs(rel), content);
}

/** 1-based position of the Nth occurrence of `needle` in a file. */
function positionOf(rel: string, needle: string, occurrence = 0): { line: number; character: number } {
  const lines = read(rel).split("\n");
  let seen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    let at = lines[index].indexOf(needle);
    while (at !== -1) {
      if (seen === occurrence) return { line: index + 1, character: at + 1 };
      seen += 1;
      at = lines[index].indexOf(needle, at + 1);
    }
  }
  throw new Error(`Needle not found: ${needle} in ${rel}`);
}

function errorCount(items: DiagnosticItem[]): number {
  return items.filter((item) => item.severity === "error").length;
}

async function waitForDiagnostics(
  rel: string,
  predicate: (items: DiagnosticItem[]) => boolean,
  timeoutMs = 25000
): Promise<DiagnosticItem[]> {
  const started = Date.now();
  let last: DiagnosticItem[] = [];
  while (Date.now() - started < timeoutMs) {
    last = await manager.diagnostics(abs(rel), { timeoutMs: 4000 });
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return last;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Instrumented spawn: still launches the real binary, but records lifecycle. */
function instrumentedSpawn(spec: LspServerSpec, root: string): SpawnedServer | undefined {
  const binary = resolveServerBinary(spec, { root, workspaceRoot: workspace });
  if (!binary) return undefined;
  spawnCount += 1;
  const spawned = spawnStdioServer(binary, spec.args, { cwd: root });
  if (spawned.processId) spawnedPids.push(spawned.processId);
  return spawned;
}

(liveReady ? describe : describe.skip)("74.11 LIVE — real typescript-language-server", () => {
  beforeAll(() => {
    spawnCount = 0;
    spawnedPids = [];
    manager = new LspManager({
      workspaceRoot: workspace,
      cwd: workspace,
      spawnServer: instrumentedSpawn,
      timeouts: TIMEOUTS,
    });
  });

  /**
   * Prime the project the way a real agent does: it reads the files it is about
   * to navigate. typescript-language-server only offers complete cross-file
   * resolution for documents that have been loaded into the project, so reading
   * them first is the realistic workflow — not a shortcut.
   */
  beforeAll(async () => {
    resetFixture();
    for (const rel of ["src/service.ts", "src/controller.ts", "src/index.ts"]) {
      await manager.documentSymbols(abs(rel));
    }
    // Wire the tool to this exact live session so the end-to-end assertion runs
    // against the same real server rather than a second one.
    setLspManagerForTesting(workspace, manager);
  });

  afterAll(async () => {
    if (manager) await manager.shutdown();
    resetLspManagers();
    resetFixture();
  });

  test("lifecycle: spawns the real server and completes the handshake", () => {
    const availability = manager.availability(probeFile);
    expect(availability.available).toBe(true);
    expect(availability.serverId).toBe("typescript");
  });

  test("definition resolves the symbol declaration", async () => {
    // Position on the call site, not the import specifier.
    const usage = positionOf("src/controller.ts", "getUser", 1);
    const locations = await manager.definition(abs("src/controller.ts"), { line: usage.line - 1, character: usage.character - 1 });

    expect(locations.length).toBeGreaterThan(0);
    const declaration = locations[0];
    expect(declaration.path).toBe("src/service.ts");
    expect(declaration.line).toBe(positionOf("src/service.ts", "getUser").line);
    // Normalized: 1-based, workspace-relative — never an absolute path or URI.
    expect(declaration.line).toBeGreaterThan(0);
    expect(declaration.character).toBeGreaterThan(0);
    expect(declaration.path.startsWith("/")).toBe(false);
  });

  test("references include every usage across files", async () => {
    const declaration = positionOf("src/service.ts", "getUser");
    const locations = await manager.references(abs("src/service.ts"), {
      line: declaration.line - 1,
      character: declaration.character - 1,
    });

    const files = [...new Set(locations.map((location) => location.path))].sort();
    expect(files).toContain("src/service.ts");
    expect(files).toContain("src/controller.ts");
    expect(files).toContain("src/index.ts");
  });

  test("hover returns real type information", async () => {
    const declaration = positionOf("src/service.ts", "getUser");
    const hover = await manager.hover(abs("src/service.ts"), {
      line: declaration.line - 1,
      character: declaration.character - 1,
    });

    expect(hover).toBeDefined();
    expect(hover!.contents).toContain("getUser");
    expect(hover!.contents).toContain("User");
  });

  test("document_symbols lists the file's declarations", async () => {
    const symbols = await manager.documentSymbols(abs("src/service.ts"));
    const names = symbols.map((symbol) => symbol.name);
    expect(names).toContain("getUser");
    expect(names).toContain("User");
    expect(symbols.every((symbol) => symbol.path === "src/service.ts")).toBe(true);
  });

  test("workspace_symbols finds the symbol project-wide", async () => {
    const symbols = await manager.workspaceSymbols("getUser");
    const match = symbols.find((symbol) => symbol.name.includes("getUser"));
    expect(match).toBeDefined();
    expect(match!.path).toBe("src/service.ts");
    expect(match!.line).toBe(positionOf("src/service.ts", "getUser").line);
  });

  test("diagnostics are clean on the untouched fixture", async () => {
    const items = await manager.diagnostics(abs("src/service.ts"), { timeoutMs: TIMEOUTS.diagnosticsMs });
    expect(Array.isArray(items)).toBe(true);
    expect(errorCount(items)).toBe(0);
  });

  test("process reuse: every operation shares one server process", () => {
    expect(manager.activeClients()).toHaveLength(1);
    expect(manager.activeClients()[0]?.serverId).toBe("typescript");
    // definition + references + hover + symbols + diagnostics all ran on this
    // one process — no per-call spawn.
    expect(spawnCount).toBe(1);
  });

  test("live mutation: a real type error is reported, then clears after the fix", async () => {
    try {
      // Introduce a deliberate type error: name is a string, 123 is not.
      write("src/service.ts", SERVICE_TS.replace('name: "ToolNet"', "name: 123"));

      const withError = await waitForDiagnostics("src/service.ts", (items) => errorCount(items) > 0);
      expect(errorCount(withError)).toBeGreaterThan(0);
      const first = withError.find((item) => item.severity === "error")!;
      expect(first.path).toBe("src/service.ts");
      expect(first.message.length).toBeGreaterThan(0);
      expect(first.line).toBeGreaterThan(0);
    } finally {
      write("src/service.ts", SERVICE_TS);
    }

    const cleared = await waitForDiagnostics("src/service.ts", (items) => errorCount(items) === 0);
    expect(errorCount(cleared)).toBe(0);
  }, 30000);

  test("cache invalidation: a new symbol is visible only after invalidate()", async () => {
    const before = await manager.documentSymbols(abs("src/service.ts"));
    expect(before.map((symbol) => symbol.name)).not.toContain("findUser");

    try {
      write("src/service.ts", `${SERVICE_TS}\nexport function findUser(id: string): string {\n  return id;\n}\n`);

      // Still cached — a mutation must invalidate explicitly.
      const cached = await manager.documentSymbols(abs("src/service.ts"));
      expect(cached.map((symbol) => symbol.name)).not.toContain("findUser");

      manager.invalidate(abs("src/service.ts"));
      // documentSymbols re-reads the file (didChange) before requesting, so the
      // server answers with the current content — no diagnostics wait needed.
      const fresh = await manager.documentSymbols(abs("src/service.ts"));
      expect(fresh.map((symbol) => symbol.name)).toContain("findUser");
    } finally {
      write("src/service.ts", SERVICE_TS);
      manager.invalidate(abs("src/service.ts"));
    }
  }, 30000);

  test("the lsp tool returns the same live data end-to-end", async () => {
    const usage = positionOf("src/controller.ts", "getUser", 1);
    const envelope = JSON.parse(
      await runLspOperation(
        { operation: "definition", path: "src/controller.ts", line: usage.line, character: usage.character },
        { cwd: workspace, workspaceRoot: workspace }
      )
    );

    expect(envelope.available).toBe(true);
    expect(envelope.exitCode).toBe(0);
    expect(envelope.results[0].path).toBe("src/service.ts");
  });

  test("cancellation and timeouts stay clean and leave the client usable", async () => {
    const controller = new AbortController();
    const pending = manager.workspaceSymbols("getUser", { signal: controller.signal });
    controller.abort();
    const cancelled = await pending.catch(() => []);
    expect(Array.isArray(cancelled)).toBe(true);

    // A bounded request must not hang the manager.
    const declaration = positionOf("src/service.ts", "getUser");
    const timedOut = await manager.hover(
      abs("src/service.ts"),
      { line: declaration.line - 1, character: declaration.character - 1 },
      { timeoutMs: 1 }
    ).catch(() => undefined);
    expect(timedOut === undefined || typeof timedOut.contents === "string").toBe(true);

    // The server is still alive and answering real requests afterwards.
    const stillWorks = await manager.documentSymbols(abs("src/service.ts"));
    expect(stillWorks.map((symbol) => symbol.name)).toContain("getUser");
  });

  test("shutdown terminates the real process with no orphans", async () => {
    expect(spawnedPids.length).toBe(1);
    expect(isProcessAlive(spawnedPids[0])).toBe(true);

    await manager.shutdown();

    expect(manager.activeClients()).toHaveLength(0);
    // Give the OS a moment to reap the child.
    const deadline = Date.now() + 5000;
    while (isProcessAlive(spawnedPids[0]) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(isProcessAlive(spawnedPids[0])).toBe(false);
  });

  test("after shutdown, operations degrade instead of throwing", async () => {
    const symbols = await manager.documentSymbols(abs("src/service.ts"));
    expect(symbols).toEqual([]);
  });
});

// Runs regardless of whether a language server is installed.
describe("74.11 fallback regression — no language server available", () => {
  test("reports unavailability with a clear reason and never throws", async () => {
    const bare = fs.mkdtempSync(path.join("/tmp", "toolnet-lsp-nolsp-"));
    fs.writeFileSync(path.join(bare, "a.ts"), "export const a = 1;\n");

    try {
      const bareManager = new LspManager({ workspaceRoot: bare, cwd: bare, resolveBinary: () => undefined });
      const availability = bareManager.availability(path.join(bare, "a.ts"));
      expect(availability.available).toBe(false);
      expect(availability.reason).toMatch(/not found/i);

      const envelope = JSON.parse(
        await runLspOperation({ operation: "document_symbols", path: "a.ts" }, { cwd: bare, workspaceRoot: bare })
      );
      expect(envelope.available).toBe(false);
      expect(envelope.exitCode).toBe(0);
      expect(envelope.results).toEqual([]);
      expect(envelope.stdout).toMatch(/grep/i);

      await bareManager.shutdown();
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
