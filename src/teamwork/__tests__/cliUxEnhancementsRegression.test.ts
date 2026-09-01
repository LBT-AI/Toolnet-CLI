import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateCompletionScript, getCompletionInstallHelp } from "../../lib/completion";
import { getVersionString, getVersionJson } from "../../lib/version";
import { renderUnifiedDiffLines, parseDiffStats, renderCompactDiffSummary } from "../../tui/renderers/diffRenderer";
import { renderInputArea } from "../../tui/renderers/statusRenderer";
import { wrapErrorBoundary, restoreTerminal } from "../../lib/terminalLifecycle";
import { MultilineInputBuffer } from "../../tui/input/multilineInput";
import { handleKey, getInputState, setInputState, resetInputState } from "../../tui/input/inputHandler";
import { tuiState } from "../../tui/state";
import { initWorkspace, setWorkspaceRoots, setCwd, toolEdit, toolReplaceAll, toolWrite } from "../../lib/codingAgent";
import { helpCommand } from "../../commands/help";
import { stripAnsi } from "../../tui/layout";

function tmpDir(): string {
  const d = path.join(os.tmpdir(), "toolnet-cli-ux-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe("CLI UX Enhancements Regression Suite", () => {
  const originalCwd = process.cwd();
  let testCwd: string;

  beforeEach(() => {
    testCwd = tmpDir();
    initWorkspace(testCwd);
    resetInputState();
    tuiState.inputBuffer = "";
    tuiState.cursorPos = 0;
    tuiState.setStatus("");
  });

  afterEach(() => {
    try {
      process.chdir(originalCwd);
    } catch {}
    setWorkspaceRoots([originalCwd]);
    setCwd(originalCwd);
    try {
      fs.rmSync(testCwd, { recursive: true, force: true });
    } catch {}
  });

  it("1. Shell completion generates valid bash, zsh, and fish scripts", () => {
    const bash = generateCompletionScript("bash");
    expect(bash).toContain("complete -F _toolnet_completions toolnet");
    expect(bash).toContain("config provider session resume skills tools queue");
    expect(bash).toContain("completion");

    const zsh = generateCompletionScript("zsh");
    expect(zsh).toContain("#compdef toolnet");
    expect(zsh).toContain("'config:Show or modify configuration'");
    expect(zsh).toContain("'provider:Manage and switch AI providers'");
    expect(zsh).toContain("'session:Manage and resume sessions'");

    const fish = generateCompletionScript("fish");
    expect(fish).toContain("complete -c toolnet");
    expect(fish).toContain("complete -c toolnet -n '__fish_use_subcommand' -a config");

    const installHelp = getCompletionInstallHelp();
    expect(installHelp).toContain("toolnet completion bash");
    expect(installHelp).toContain("toolnet completion zsh");
    expect(installHelp).toContain("toolnet completion fish");
  });

  it("2. Version and Help helpers output structured metadata at all levels", async () => {
    expect(getVersionString()).toMatch(/^ToolNet CLI v\d+\.\d+\.\d+/);
    const vJson = getVersionJson();
    expect(vJson).toHaveProperty("version");
    expect(vJson).toHaveProperty("platform");

    // Interactive /help command and /help <subcommand>
    let helpMsg = "";
    const ctx: any = {
      addMessage: (_role: string, msg: string) => {
        helpMsg += msg + "\n";
      },
    };

    // Generic help
    await helpCommand.handler([], ctx);
    expect(helpMsg).toContain("TOOLNET — Slash Commands");
    expect(helpMsg).toContain("/provider");
    expect(helpMsg).toContain("/model");

    // Specific command help
    helpMsg = "";
    await helpCommand.handler(["key"], ctx);
    expect(helpMsg).toContain("Command: /key");
    expect(helpMsg).toContain("Description:");

    helpMsg = "";
    await helpCommand.handler(["unknown_cmd"], ctx);
    expect(helpMsg).toContain("Unknown command '/unknown_cmd'");
  });

  it("3. Multi-line input buffer and Shift+Enter handle multiline prompts and navigation", () => {
    const buf = new MultilineInputBuffer();
    buf.insertText("const x = 1;");
    expect(buf.getText()).toBe("const x = 1;");
    expect(buf.isMultiline()).toBe(false);

    buf.insertNewline();
    buf.insertText("const y = 2;");
    expect(buf.isMultiline()).toBe(true);
    expect(buf.getText()).toBe("const x = 1;\nconst y = 2;");

    // Up/Down navigation within multiline buffer
    expect(buf.isAtLastLine()).toBe(true);
    expect(buf.moveUp()).toBe(true);
    expect(buf.isAtFirstLine()).toBe(true);
    expect(buf.moveDown()).toBe(true);
    expect(buf.isAtLastLine()).toBe(true);

    // Test Shift+Enter key sequence through inputHandler
    const cb = { renderAll: () => {} };
    setInputState("Line 1", 6);
    // Send Shift+Enter (CSI 13;2u)
    handleKey(Buffer.from("1b5b31333b3275", "hex"), cb);
    expect(getInputState().buffer).toBe("Line 1\n");

    // Send Alt+Enter (\x1b\r)
    handleKey(Buffer.from("1b0d", "hex"), cb);
    expect(getInputState().buffer).toBe("Line 1\n\n");
  });

  it("4. renderInputArea displays multiple lines when multiline buffer is present", () => {
    const single = renderInputArea(80, "Single line task", "\x1b[36m");
    const strippedSingle = stripAnsi(single);
    expect(strippedSingle).toContain("> Single line task");

    const multi = renderInputArea(80, "Line 1\nLine 2\nLine 3", "\x1b[36m");
    const strippedMulti = stripAnsi(multi);
    expect(strippedMulti).toContain("> Line 1");
    expect(strippedMulti).toContain("… Line 2");
    expect(strippedMulti).toContain("… Line 3");
  });

  it("5. UI Error boundary recovers gracefully from unexpected render exceptions", () => {
    let recoveredMsg = "";
    const result = wrapErrorBoundary(
      () => {
        throw new Error("Simulated widget render exception");
      },
      (err: unknown) => {
        recoveredMsg = err instanceof Error ? err.message : String(err);
      }
    );

    expect(result).toBeUndefined();
    expect(recoveredMsg).toBe("Simulated widget render exception");
  });

  it("6. renderUnifiedDiffLines renders formatted diff box with syntax colors and stats", () => {
    const diff = `--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 20;
+const c = 30;
 export default a;`;

    const stats = parseDiffStats(diff);
    expect(stats.length).toBe(1);
    expect(stats[0].fileName).toBe("src/app.ts");
    expect(stats[0].additions).toBe(2);
    expect(stats[0].deletions).toBe(1);

    const summary = renderCompactDiffSummary(stats[0]);
    expect(stripAnsi(summary)).toContain("src/app.ts  +2 -1");

    const diffLines = renderUnifiedDiffLines(diff, 20, 80);
    expect(diffLines.length).toBe(8);
    const joined = stripAnsi(diffLines.join("\n"));
    expect(joined).toContain("--- a/src/app.ts");
    expect(joined).toContain("+++ b/src/app.ts");
    expect(joined).toContain("@@ -1,4 +1,5 @@");
    expect(joined).toContain("+const b = 20;");
    expect(joined).toContain("-const b = 2;");
  });

  it("7. toolEdit, toolReplaceAll, and toolWrite produce unified diffs for agent file modifications", () => {
    const targetFile = path.join(testCwd, "sample.ts");
    fs.writeFileSync(targetFile, "function oldCode() {\n  return 1;\n}\n", "utf8");

    // toolEdit produces diff
    const editRes = toolEdit(targetFile, "return 1;", "return 2;");
    expect(editRes.success).toBe(true);
    expect(editRes.data).toContain("Edited ");
    expect(editRes.data).toContain("--- a/");
    expect(editRes.data).toContain("+++ b/");
    expect(editRes.data).toContain("-  return 1;");
    expect(editRes.data).toContain("+  return 2;");

    // toolReplaceAll produces diff
    const repRes = toolReplaceAll(targetFile, "oldCode", "newCode");
    expect(repRes.success).toBe(true);
    expect(repRes.data).toContain("Replaced 1 occurrence(s)");
    expect(repRes.data).toContain("-function oldCode() {");
    expect(repRes.data).toContain("+function newCode() {");

    // toolWrite overwriting file produces diff
    const writeRes = toolWrite(targetFile, "function finalCode() {\n  return 100;\n}\n");
    expect(writeRes.success).toBe(true);
    expect(writeRes.data).toContain("Written ");
    expect(writeRes.data).toContain("-function newCode() {");
    expect(writeRes.data).toContain("+function finalCode() {");
  });

  it("8. renderToast renders centered pill box with warning and success styling", () => {
    const { renderToast } = require("../../tui/renderers/modalRenderer");
    const warnToast = renderToast(80, "⚠️ UI recovered from render glitch");
    expect(warnToast.length).toBeGreaterThan(0);
    const warnJoined = stripAnsi(warnToast.join("\n"));
    expect(warnJoined).toContain("╭");
    expect(warnJoined).toContain("│ ⚠️ UI recovered from render glitch │");
    expect(warnJoined).toContain("╰");

    const succToast = renderToast(80, "✓ Model switched to gpt-4o");
    const succJoined = stripAnsi(succToast.join("\n"));
    expect(succJoined).toContain("│ ✓ Model switched to gpt-4o │");
  });

  it("9. Input error boundary catches faulty keypress handlers and sets toast notification", () => {
    let renderCount = 0;
    const faultyCallbacks: any = {
      renderAll: () => { renderCount++; },
      sendMessage: () => {
        throw new Error("Faulty message dispatcher");
      },
    };

    // Submitting with Enter triggers sendMessage which throws
    setInputState("/test", 5);
    // Enter key
    expect(() => handleKey(Buffer.from("0d", "hex"), faultyCallbacks)).not.toThrow();
    expect(tuiState.toastMsg).toContain("Faulty message dispatcher");
    expect(tuiState.statusText).toContain("glitch recovered");
  });
});
