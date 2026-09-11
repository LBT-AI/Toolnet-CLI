/**
 * Phase 74.7 — LSP integration on a real TypeScript fixture.
 *
 * A fake language server stands in for `typescript-language-server` so the
 * tests are deterministic and CI never depends on an installed binary. The
 * fixture files are real on-disk sources under a temp workspace.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LspManager, resetLspManagers, setLspManagerForTesting } from "../../core/lsp/manager";
import { runLspOperation } from "../../core/lsp/tool";
import type { ToolExecutionContext } from "../../lib/security/types";
import { createFakeLspServer, type FakeLspServer } from "./helpers/fakeLspServer";

const MATH_TS = `export function add(a: number, b: number): number {
  return a + b;
}
`;

const APP_TS = `import { add } from "./math";

export function total(): number {
  return add(1, 2);
}
`;

let workspace: string;
let server: FakeLspServer;
let manager: LspManager;

function seedWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-lsp-int-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "math.ts"), MATH_TS);
  fs.writeFileSync(path.join(root, "src", "app.ts"), APP_TS);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
  return root;
}

/** Absolute path for a fixture file. */
function abs(rel: string): string {
  return path.join(workspace, rel);
}

function ctx(): ToolExecutionContext {
  return { cwd: workspace, workspaceRoot: workspace };
}

async function parseEnvelope(raw: string): Promise<any> {
  return JSON.parse(raw);
}

beforeEach(() => {
  workspace = seedWorkspace();
  server = createFakeLspServer({
    workspaceRoot: workspace,
    diagnosticsByPath: {
      [abs("src/app.ts")]: [
        { path: "src/app.ts", line: 4, character: 10, severity: "error", message: "Type 'string' is not assignable", code: 2322 },
      ],
    },
    handlers: {
      documentSymbols: (file) => {
        if (file.endsWith("math.ts")) {
          return [{ name: "add", kind: "function", path: "src/math.ts", line: 1, character: 17 }];
        }
        if (file.endsWith("app.ts")) {
          return [{ name: "total", kind: "function", path: "src/app.ts", line: 3, character: 17 }];
        }
        return [];
      },
      definition: (file) => {
        if (file.endsWith("app.ts")) return [{ path: "src/math.ts", line: 1, character: 17 }];
        return [];
      },
      references: (file) => {
        if (!file.endsWith("math.ts")) return [];
        return [
          { path: "src/math.ts", line: 1, character: 17 },
          { path: "src/app.ts", line: 1, character: 10 },
          { path: "src/app.ts", line: 4, character: 10 },
        ];
      },
      hover: (file) => (file.endsWith("math.ts") ? "function add(a: number, b: number): number" : undefined),
      workspaceSymbols: (query) => {
        const all = [
          { name: "add", kind: "function", path: "src/math.ts", line: 1, character: 17 },
          { name: "total", kind: "function", path: "src/app.ts", line: 3, character: 17 },
        ];
        return query ? all.filter((s) => s.name.includes(query)) : all;
      },
    },
  });

  manager = new LspManager({
    workspaceRoot: workspace,
    cwd: workspace,
    spawnServer: server.spawn,
    resolveBinary: () => "fake-language-server",
    timeouts: { initializeMs: 1000, requestMs: 1000, diagnosticsMs: 500, shutdownMs: 200 },
  });
  setLspManagerForTesting(workspace, manager);
});

afterEach(async () => {
  resetLspManagers();
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("74.4 lsp tool — operations", () => {
  test("definition returns a normalized, workspace-relative location", async () => {
    const env = await parseEnvelope(
      await runLspOperation({ operation: "definition", path: "src/app.ts", line: 4, character: 11 }, ctx())
    );
    expect(env.available).toBe(true);
    expect(env.exitCode).toBe(0);
    expect(env.results).toEqual([{ path: "src/math.ts", line: 1, character: 17 }]);
    expect(env.summary).toContain("src/math.ts:1:17");
  });

  test("references returns every use site", async () => {
    const env = await parseEnvelope(
      await runLspOperation({ operation: "references", path: "src/math.ts", line: 1, character: 17 }, ctx())
    );
    expect(env.count).toBe(3);
    expect(env.results.map((r: any) => r.path)).toEqual(["src/math.ts", "src/app.ts", "src/app.ts"]);
  });

  test("hover returns the signature", async () => {
    const env = await parseEnvelope(
      await runLspOperation({ operation: "hover", path: "src/math.ts", line: 1, character: 17 }, ctx())
    );
    expect(env.summary).toContain("function add");
  });

  test("document_symbols lists the file's symbols", async () => {
    const env = await parseEnvelope(await runLspOperation({ operation: "document_symbols", path: "src/math.ts" }, ctx()));
    expect(env.results.map((s: any) => s.name)).toEqual(["add"]);
    expect(env.summary).toContain("function add (src/math.ts:1:17)");
  });

  test("workspace_symbols filters by query", async () => {
    const env = await parseEnvelope(await runLspOperation({ operation: "workspace_symbols", query: "tot" }, ctx()));
    expect(env.available).toBe(true);
    expect(env.results.map((s: any) => s.name)).toEqual(["total"]);
  });

  test("diagnostics are returned for a file the server has diagnosed", async () => {
    const env = await parseEnvelope(await runLspOperation({ operation: "diagnostics", path: "src/app.ts" }, ctx()));
    expect(env.count).toBe(1);
    expect(env.summary).toContain("<diagnostics");
    expect(env.results[0]).toMatchObject({ path: "src/app.ts", line: 4, character: 10, severity: "error" });
  });
});

describe("74.4 lsp tool — lifecycle, reuse and input handling", () => {
  test("one server is reused across many operations, then shut down", async () => {
    await runLspOperation({ operation: "document_symbols", path: "src/math.ts" }, ctx());
    await runLspOperation({ operation: "references", path: "src/math.ts", line: 1, character: 17 }, ctx());
    await runLspOperation({ operation: "hover", path: "src/math.ts", line: 1, character: 17 }, ctx());

    expect(manager.activeClients()).toHaveLength(1);
    expect(server.openedDocuments.filter((doc) => doc.endsWith("math.ts")).length).toBeLessThanOrEqual(2);

    await manager.shutdown();
    expect(server.shutdownCalled).toBe(true);
  });

  test("missing path is reported as invalid input, not a crash", async () => {
    const env = await parseEnvelope(await runLspOperation({ operation: "definition" }, ctx()));
    expect(env.exitCode).toBe(1);
    expect(env.available).toBe(false);
    expect(env.stderr).toMatch(/requires a "path"/);
  });

  test("missing position is reported as invalid input", async () => {
    const env = await parseEnvelope(await runLspOperation({ operation: "hover", path: "src/math.ts" }, ctx()));
    expect(env.exitCode).toBe(1);
    expect(env.stderr).toMatch(/line/);
  });

  test("unknown operation is rejected without touching the server", async () => {
    const env = await parseEnvelope(await runLspOperation({ operation: "rename_everything" as any, path: "src/math.ts" }, ctx()));
    expect(env.exitCode).toBe(1);
    expect(server.requests).toHaveLength(0);
  });

  test("an aborted signal returns no results and does not hang", async () => {
    const controller = new AbortController();
    controller.abort();
    const env = await parseEnvelope(
      await runLspOperation({ operation: "references", path: "src/math.ts", line: 1, character: 17 }, { ...ctx(), signal: controller.signal })
    );
    expect(env.exitCode).toBe(0);
    expect(env.results).toEqual([]);
  });
});

describe("74.2 unavailable language server — graceful fallback", () => {
  test("the tool reports unavailability and never fabricates results", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-lsp-bare-"));
    fs.writeFileSync(path.join(bare, "a.ts"), "export const a = 1;\n");
    const bareManager = new LspManager({ workspaceRoot: bare, cwd: bare, resolveBinary: () => undefined });
    setLspManagerForTesting(bare, bareManager);

    try {
      const env = await parseEnvelope(
        await runLspOperation({ operation: "document_symbols", path: "a.ts" }, { cwd: bare, workspaceRoot: bare })
      );
      expect(env.available).toBe(false);
      expect(env.exitCode).toBe(0); // a capability gap must not look like a runtime error
      expect(env.results).toEqual([]);
      expect(env.stdout).toMatch(/Fall back to grep/i);
      expect(env.reason).toMatch(/not found/i);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});
