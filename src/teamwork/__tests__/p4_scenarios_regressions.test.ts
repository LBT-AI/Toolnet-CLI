import { test, it, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { evaluatePermission, setSandboxMode } from "../../lib/permissions";
import { getPlatform, getVersion } from "../../lib/version";
import { executeToolBatch } from "../../lib/harness/toolExecutor";
import { deduplicateToolCalls } from "../../lib/harness/toolPlanner";
import { getGlobalTracker } from "../../lib/usage";
import { JsonlWriter, classifyError } from "../../lib/structuredOutput";
import { redactOutputSecrets } from "../../lib/security/outputRedactor";
import { buildMultiWorkspaceIndex, searchSymbols } from "../../lib/workspaceIndex";
import { PluginManager } from "../../lib/plugins/pluginManager";
import { validateAndLoadImage } from "../../lib/vision";

import { setWorkspaceRoots } from "../../lib/codingAgent";

function tmpDir(): string {
  const d = path.join(os.tmpdir(), "toolnet-scenario-test-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cleanDir(d: string) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

describe("P4.26 & P4.27 — Integration Scenarios & Subsystem Regressions", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    setSandboxMode("workspace");
    setWorkspaceRoots([dir]);
  });

  afterEach(() => {
    setWorkspaceRoots([process.cwd()]);
    cleanDir(dir);
  });

  it("36. P0 permission regression: permission engine and platform version remain intact", () => {
    expect(getVersion()).toMatch(/^\d+\.\d+\.\d+/);
    const plat = getPlatform();
    expect(["linux", "darwin", "windows"]).toContain(plat.platform);

    const safePerm = evaluatePermission("read_file", { path: "src/index.ts" }, "workspace", process.cwd());
    expect(safePerm.allowed).toBe(true);

    const dangerousPerm = evaluatePermission("shell", { command: "rm -rf /" }, "workspace", process.cwd());
    expect(dangerousPerm.allowed).toBe(false);
  });

  it("37. P1 ToolPlanner regression: deduplication and batch pipeline remain intact", async () => {
    const duplicateCalls = [
      { id: "1", name: "read_file", args: { path: "a.txt" } },
      { id: "2", name: "read_file", args: { path: "a.txt" } },
    ];
    const dedupResult = deduplicateToolCalls(duplicateCalls);
    expect(dedupResult.kept.length).toBe(1);
    expect(dedupResult.skipped).toBe(1);

    const outcome = await executeToolBatch(duplicateCalls, {
      cwd: dir,
      runTool: async () => ({ result: JSON.stringify({ stdout: "content" }), allowed: true }),
    });
    expect(outcome.executedCount).toBe(1);
    expect(outcome.deduplicatedCount).toBe(1);
  });

  it("38. P3 JSONL/usage regression: UsageTracker and JSONL events flow seamlessly", () => {
    const tracker = getGlobalTracker();
    tracker.reset();
    tracker.recordUsage({ inputTokens: 500, outputTokens: 250, model: "openai/gpt-4o" });
    const usage = tracker.getSessionUsage();
    expect(usage.totalTokens).toBe(750);

    const writer = new JsonlWriter();
    writer.write({ type: "session_start", sessionId: "sess_1", model: "openai/gpt-4o", timestamp: Date.now() });
    const lines = (writer as any).buffer as string[];
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("session_start");
  });

  it("Scenario B: Image inspection and validation in non-interactive pipeline", () => {
    const imgPath = path.join(dir, "mock_ui.png");
    fs.writeFileSync(imgPath, Buffer.from("mock-png-binary-data"));

    const val = validateAndLoadImage(imgPath, dir);
    expect(val.ok).toBe(true);
    expect(val.image?.fileName).toBe("mock_ui.png");
    expect(val.image?.mimeType).toBe("image/png");
    expect(val.image?.dataUrl).toContain("data:image/png;base64,");
  });

  it("Scenario C: Mock model outputs fake secret -> output redactor redacts across boundaries", () => {
    const fakeModelOutput = "To authenticate, use sk-1234567890abcdef1234567890xyz and ghp_1234567890abcdefghijklmnopqrstuvwxyz12";
    const cleanOutput = redactOutputSecrets(fakeModelOutput);

    expect(cleanOutput).not.toContain("sk-1234567890abcdef1234567890xyz");
    expect(cleanOutput).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz12");
    expect(cleanOutput).toContain("sk-****xyz");
    expect(cleanOutput).toContain("ghp_****z12");
  });

  it("Scenario D: Two workspace roots -> search symbols across both roots", () => {
    const rootA = path.join(dir, "rootA");
    const rootB = path.join(dir, "rootB");
    fs.mkdirSync(path.join(rootA, "src"), { recursive: true });
    fs.mkdirSync(path.join(rootB, "src"), { recursive: true });

    fs.writeFileSync(path.join(rootA, "src/serviceA.ts"), "export function doActionA() { return 'A'; }");
    fs.writeFileSync(path.join(rootB, "src/serviceB.ts"), "export function doActionB() { return 'B'; }");

    buildMultiWorkspaceIndex([rootA, rootB]);

    const symA = searchSymbols("doActionA", [rootA, rootB]);
    expect(symA.length).toBe(1);
    expect(symA[0].name).toBe("doActionA");

    const symB = searchSymbols("doActionB", [rootA, rootB]);
    expect(symB.length).toBe(1);
    expect(symB[0].name).toBe("doActionB");
  });

  it("Scenario E: Plugin defines read-only tool -> permission pipeline validates and runs cleanly", async () => {
    const manager = new PluginManager();
    const pluginDir = path.join(dir, "reader-plugin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "reader-plugin",
        version: "1.0.0",
        toolnet: { apiVersion: 1, entry: "index.js", capabilities: ["filesystem.read"] },
      })
    );
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      `
      module.exports = {
        activate: (api) => {
          api.defineTool({
            name: "safe_reader",
            description: "Reads safely",
            requiredCapabilities: ["filesystem.read"],
            execute: async (args, ctx) => "file content safe",
          });
        }
      };
      `
    );

    const installed = await manager.installPlugin(pluginDir, { grantCapabilities: ["filesystem.read"] });
    expect(installed.ok).toBe(true);

    const res = await manager.executePluginTool("safe_reader", {}, dir);
    expect(res.result).toBe("file content safe");
    expect(res.error).toBeUndefined();
  });
});
