/**
 * Phase 74.8 — Golden E2E: rename a symbol using code intelligence.
 *
 * Prompt (as a user would type it):
 *   "Đổi tên hàm getUser thành findUser và sửa toàn bộ nơi sử dụng. Sau đó chạy test."
 *
 * The orchestrator below is deterministic (no model). It proves the *behaviour*
 * the phase requires: locate the symbol and its call sites through the LSP tool
 * first, edit exactly those files, re-check diagnostics, then run the real test
 * suite — never a blind repo-wide grep.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolWrite } from "../../lib/codingAgent";
import { LspManager, resetLspManagers, setLspManagerForTesting } from "../../core/lsp/manager";
import { runLspOperation } from "../../core/lsp/tool";
import type { ToolExecutionContext } from "../../lib/security/types";
import { createFakeLspServer, type FakeLspServer } from "./helpers/fakeLspServer";

const SERVICE_TS = `export function getUser(id: string): string {
  return \`user:\${id}\`;
}
`;

const CONTROLLER_TS = `import { getUser } from "./service";

export function handle(id: string): string {
  return getUser(id);
}
`;

const SERVICE_TEST_TS = `import { test, expect } from "bun:test";
import { getUser } from "./service";

test("getUser returns a tagged id", () => {
  expect(getUser("1")).toBe("user:1");
});
`;

let workspace: string;
let server: FakeLspServer;
let manager: LspManager;
let seededDiagnostic = true;

function abs(rel: string): string {
  return path.join(workspace, rel);
}

function ctx(): ToolExecutionContext {
  return { cwd: workspace, workspaceRoot: workspace };
}

async function envelope(raw: string): Promise<any> {
  return JSON.parse(raw);
}

function read(rel: string): string {
  return fs.readFileSync(abs(rel), "utf8");
}

beforeEach(() => {
  seededDiagnostic = true;
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-lsp-golden-"));
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(abs("src/service.ts"), SERVICE_TS);
  fs.writeFileSync(abs("src/controller.ts"), CONTROLLER_TS);
  fs.writeFileSync(abs("src/service.test.ts"), SERVICE_TEST_TS);
  fs.writeFileSync(abs("package.json"), JSON.stringify({ name: "golden-fixture", type: "module" }));

  server = createFakeLspServer({
    workspaceRoot: workspace,
    // Before the rename the server flags the deprecated call; after it, clean.
    diagnosticsFor: (file) =>
      seededDiagnostic && file.endsWith("service.ts")
        ? [{ path: "src/service.ts", line: 4, character: 12, severity: "error", message: "getUser is deprecated", code: 6385 }]
        : [],
    handlers: {
      workspaceSymbols: (query) => {
        const symbol = { name: "getUser", kind: "function", path: "src/service.ts", line: 1, character: 17 };
        return query && !symbol.name.includes(query) ? [] : [symbol];
      },
      references: () => [
        { path: "src/service.ts", line: 1, character: 17 },
        { path: "src/controller.ts", line: 4, character: 10 },
        { path: "src/service.test.ts", line: 4, character: 10 },
      ],
    },
  });

  manager = new LspManager({
    workspaceRoot: workspace,
    cwd: workspace,
    spawnServer: server.spawn,
    resolveBinary: () => "fake-language-server",
    timeouts: { initializeMs: 1000, requestMs: 1000, diagnosticsMs: 400, shutdownMs: 200 },
  });
  setLspManagerForTesting(workspace, manager);
});

afterEach(() => {
  resetLspManagers();
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("74.8 golden E2E — rename getUser → findUser via LSP", () => {
  test("resolves the symbol with LSP, edits only its real usages, verifies and tests", async () => {
    // 1. Locate the symbol through code intelligence — not a blind grep.
    const symbols = await envelope(
      await runLspOperation({ operation: "workspace_symbols", query: "getUser" }, ctx())
    );
    expect(symbols.available).toBe(true);
    expect(symbols.results.map((s: any) => s.name)).toEqual(["getUser"]);
    const declaration = symbols.results[0];
    expect(declaration.path).toBe("src/service.ts");

    // 2. Ask for every reference — this is the authoritative usage set.
    const references = await envelope(
      await runLspOperation(
        { operation: "references", path: declaration.path, line: declaration.line, character: declaration.character },
        ctx()
      )
    );
    const usageFiles: string[] = [
      ...new Set<string>(references.results.map((r: any) => String(r.path))),
    ].sort();
    expect(usageFiles).toEqual(["src/controller.ts", "src/service.test.ts", "src/service.ts"]);

    // The LSP server was actually consulted, in the right order.
    expect(server.requests.some((r) => r.method === "textDocument/references")).toBe(true);

    // 3a. Before touching code, diagnostics flag the deprecated call.
    const before = await envelope(
      await runLspOperation({ operation: "diagnostics", path: "src/service.ts" }, ctx())
    );
    expect(before.count).toBe(1);
    expect(before.results[0].message).toContain("deprecated");

    // 3b. Apply the rename to exactly the files LSP named.
    for (const rel of usageFiles) {
      const next = read(rel).replaceAll("getUser", "findUser");
      const result = toolWrite(abs(rel), next, { cwd: workspace, workspaceRoot: workspace });
      expect(result.success).toBe(true);
    }

    // 4. Re-check diagnostics for the changed file (server reports clean now).
    seededDiagnostic = false;
    server.publishDiagnostics(abs("src/service.ts"), []);
    const diagnostics = await envelope(
      await runLspOperation({ operation: "diagnostics", path: "src/service.ts" }, ctx())
    );
    expect(diagnostics.available).toBe(true);
    expect(diagnostics.count).toBe(0);

    // 5. Run the workspace's real test suite as the final verification.
    // bun writes its report to stderr, so combine both streams before asserting.
    const run = spawnSync(process.execPath, ["test", "src"], {
      cwd: workspace,
      timeout: 30000,
      encoding: "utf8",
    });
    const report = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    expect(run.status).toBe(0);
    expect(report).toContain("findUser returns a tagged id");
    expect(report).not.toContain("(fail)");

    // 6. Independent shell-level verification of the on-disk result.
    for (const rel of usageFiles) {
      const contents = read(rel);
      expect(contents).not.toContain("getUser");
      expect(contents).toContain("findUser");
    }
  });

  test("the same flow degrades safely when no language server is available", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-lsp-golden-bare-"));
    fs.writeFileSync(path.join(bare, "a.ts"), "export const a = 1;\n");
    setLspManagerForTesting(bare, new LspManager({ workspaceRoot: bare, cwd: bare, resolveBinary: () => undefined }));

    try {
      const env = await envelope(
        await runLspOperation({ operation: "workspace_symbols", query: "a" }, { cwd: bare, workspaceRoot: bare })
      );
      expect(env.available).toBe(false);
      expect(env.results).toEqual([]);
      // The tool surfaces an explicit fallback instruction instead of failing.
      expect(env.stdout).toMatch(/grep/i);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
