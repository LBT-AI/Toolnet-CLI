import { test, it, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initWorkspace, getWorkspaceRoots, setWorkspaceRoots } from "../../lib/codingAgent";
import { isPathInsideWorkspace, setSandboxMode } from "../../lib/permissions";
import { buildMultiWorkspaceIndex, searchSymbols, getCrossWorkspaceCodeMap } from "../../lib/workspaceIndex";

function tmpDir(): string {
  const d = path.join(os.tmpdir(), "toolnet-workspace-test-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cleanDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

describe("P4.16 & P4.17 — Multi-Project Workspace & Cross-Workspace Map", () => {
  let baseDir: string;
  let frontendDir: string;
  let backendDir: string;

  beforeEach(() => {
    baseDir = tmpDir();
    frontendDir = path.join(baseDir, "frontend");
    backendDir = path.join(baseDir, "backend");

    fs.mkdirSync(frontendDir, { recursive: true });
    fs.mkdirSync(backendDir, { recursive: true });

    // Frontend project
    fs.writeFileSync(
      path.join(frontendDir, "package.json"),
      JSON.stringify({ name: "@app/frontend", version: "1.0.0", dependencies: { "@app/backend": "^1.0.0" } })
    );
    fs.mkdirSync(path.join(frontendDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(frontendDir, "src/apiClient.ts"),
      `import { BackendService } from '../backend';\nexport function fetchClient() { return true; }`
    );

    // Backend project
    fs.writeFileSync(
      path.join(backendDir, "package.json"),
      JSON.stringify({ name: "@app/backend", version: "1.0.0" })
    );
    fs.mkdirSync(path.join(backendDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(backendDir, "src/server.ts"),
      `export class BackendService {}\nexport function startServer() {}`
    );

    setSandboxMode("workspace");
    setWorkspaceRoots([frontendDir, backendDir]);
  });

  afterEach(() => {
    setWorkspaceRoots([process.cwd()]);
    cleanDir(baseDir);
  });

  it("30. multi-workspace path resolution validates files inside any configured root", () => {
    const roots = getWorkspaceRoots();
    expect(roots.length).toBe(2);

    // Path in frontend is inside workspace
    const feCheck = isPathInsideWorkspace(path.join(frontendDir, "src/apiClient.ts"));
    expect(feCheck.isInside).toBe(true);

    // Path in backend is inside workspace
    const beCheck = isPathInsideWorkspace(path.join(backendDir, "src/server.ts"));
    expect(beCheck.isInside).toBe(true);

    // Path outside both is blocked
    const outsideCheck = isPathInsideWorkspace("/etc/passwd");
    expect(outsideCheck.isInside).toBe(false);
  });

  it("31. code index indexes multiple roots and searches symbols across all roots", () => {
    const multiIndex = buildMultiWorkspaceIndex([frontendDir, backendDir]);
    expect(multiIndex.totalFiles).toBeGreaterThanOrEqual(2);

    // Search for frontend symbol
    const feSymbols = searchSymbols("fetchClient", [frontendDir, backendDir]);
    expect(feSymbols.length).toBe(1);
    expect(feSymbols[0].name).toBe("fetchClient");

    // Search for backend symbol
    const beSymbols = searchSymbols("BackendService", [frontendDir, backendDir]);
    expect(beSymbols.length).toBe(1);
    expect(beSymbols[0].name).toBe("BackendService");

    // Cross-workspace dependency mapping
    const crossMap = getCrossWorkspaceCodeMap([frontendDir, backendDir]);
    expect(crossMap.packages.length).toBe(2);
    expect(crossMap.packages.some((p) => p.name === "@app/frontend")).toBe(true);
    expect(crossMap.packages.some((p) => p.name === "@app/backend")).toBe(true);

    // Detected package dependency
    expect(crossMap.dependencies.some((d) => d.relationship === "package")).toBe(true);
  });
});
