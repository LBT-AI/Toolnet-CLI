/**
 * CORE E2E — deterministic runtime acceptance.
 *
 * This suite proves the runtime lifecycle end-to-end against a SCRIPTED model,
 * so it can never be flaky because of model compliance:
 *
 *   write file
 *     → execute command that intentionally fails
 *     → model receives stdout/stderr + exitCode
 *     → edit the file
 *     → execute again
 *     → exit 0
 *     → file content verified on disk
 *
 * Failure of this suite is ALWAYS a CORE_RUNTIME defect — never a model issue.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { AgentEngine } from "../../core/agent/agentEngine";
import { setSandboxMode } from "../../lib/permissions";
import fs from "node:fs";
import path from "node:path";

describe.serial("CORE E2E — deterministic repair loop", () => {
  const originalFetch = globalThis.fetch;
  let tmpDir: string;

  beforeEach(() => {
    setSandboxMode("full-access");
    tmpDir = fs.mkdtempSync(path.join("/tmp", "toolnet-core-e2e-"));
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function scriptModel(responses: Array<{ content?: string; tool_calls?: any[] }>): void {
    let turn = 0;
    globalThis.fetch = (async (_url: string) => {
      const resp = responses[Math.min(turn, responses.length - 1)] ?? { content: "Done" };
      turn++;
      const body = JSON.stringify({
        id: `chatcmpl-${turn}`,
        object: "chat.completion",
        created: Date.now(),
        model: "scripted-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: resp.content || "",
              ...(resp.tool_calls?.length ? { tool_calls: resp.tool_calls } : {}),
            },
            finish_reason: resp.tool_calls?.length ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        type: "default",
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => JSON.parse(body),
        text: async () => body,
        clone: async () => ({ json: async () => JSON.parse(body), text: async () => body }),
      } as any;
    }) as any;
  }

  function call(id: string, name: string, args: Record<string, unknown>) {
    return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
  }

  test("write → fail → stderr → edit → rerun → exit 0 → verified", async () => {
    const engine = new AgentEngine();
    const target = path.join(tmpDir, "hello.js");
    const runtime = process.execPath; // the running JS runtime (bun/node)

    // Scripted model: the first write is intentionally broken, then repaired
    // after the model reads the real stderr from the failed execution.
    scriptModel([
      // 1. create a file with a syntax error
      { tool_calls: [call("w1", "write_file", { path: target, content: "console.log(\"Hello ToolNet\"\n" })] },
      // 2. run it → must fail with a real non-zero exit code
      { tool_calls: [call("s1", "shell", { command: `${runtime} hello.js` })] },
      // 3. repair the file
      { tool_calls: [call("e1", "edit_file", { path: target, old_string: "Hello ToolNet\"\n", new_string: "Hello ToolNet\");\n" })] },
      // 4. run again → must succeed
      { tool_calls: [call("s2", "shell", { command: `${runtime} hello.js` })] },
      // 5. final answer only after a verified successful run
      { content: "Đã tạo hello.js, chạy thử thành công: Hello ToolNet" },
    ]);

    const result = await engine.run({
      prompt: "Tạo file hello.js in ra Hello ToolNet, sau đó chạy thử.",
      cwd: tmpDir,
      workspaceRoot: tmpDir,
      model: "scripted-model",
      maxTurns: 8,
    });

    // ── Runtime outcome ───────────────────────────────────────────────────
    expect(result.success).toBe(true);

    // File exists and holds the REPAIRED content.
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toContain('console.log("Hello ToolNet");');

    // Verified evidence: at least one mutation and one successful execution.
    expect(result.evidence.successfulMutations).toBeGreaterThanOrEqual(1);
    expect(result.evidence.successfulExecutions).toBeGreaterThanOrEqual(1);

    // The transcript records four tool results (write, fail, edit, pass).
    const toolMessages = (result.messages ?? []).filter((m) => m.role === "tool");
    expect(toolMessages.length).toBe(4);

    // ── The model SAW the real failure ────────────────────────────────────
    // The failed shell result must carry a non-zero exitCode and stderr, which
    // is what allows a real model to repair instead of guessing.
    const failed = toolMessages[1];
    const failedPayload = JSON.parse(failed.content);
    expect(failedPayload.exitCode).not.toBe(0);
    expect(String(failedPayload.stderr ?? "")).not.toBe("");

    // ── The final run succeeded ───────────────────────────────────────────
    const passedPayload = JSON.parse(toolMessages[3].content);
    expect(passedPayload.exitCode).toBe(0);
  });

  test("workspace isolation: file tools resolve against the engine's cwd, not process.cwd()", async () => {
    // Regression: path tools used the module-global cwd, so a harness configured
    // with a different workspace wrote into process.cwd() instead.
    const strayPath = path.join(process.cwd(), "hello.py");
    if (fs.existsSync(strayPath)) fs.rmSync(strayPath, { force: true });

    const engine = new AgentEngine();
    scriptModel([
      { tool_calls: [call("w1", "write_file", { path: "hello.py", content: "print('Hello ToolNet!')\n" })] },
      { content: "done" },
    ]);

    const result = await engine.run({
      prompt: "Tạo file hello.py",
      cwd: tmpDir,
      workspaceRoot: tmpDir,
      model: "scripted-model",
      maxTurns: 4,
    });

    expect(result.success).toBe(true);
    // The file lands in the configured workspace…
    expect(fs.existsSync(path.join(tmpDir, "hello.py"))).toBe(true);
    // …and never in the process working directory.
    expect(fs.existsSync(strayPath)).toBe(false);
  });

  test("a mutation that never succeeds cannot finish as success (Completion Gate)", async () => {
    const engine = new AgentEngine();

    // Script only prose — no tool call ever runs.
    scriptModel([{ content: "Tôi đã tạo được file rồi nhé." }, { content: "Xong." }]);

    const result = await engine.run({
      prompt: "Tạo file missing.js",
      cwd: tmpDir,
      workspaceRoot: tmpDir,
      model: "scripted-model",
      maxTurns: 2,
    });

    expect(fs.existsSync(path.join(tmpDir, "missing.js"))).toBe(false);
    expect(result.success).toBe(false);
    expect(result.evidence.successfulMutations).toBe(0);
  });
});
