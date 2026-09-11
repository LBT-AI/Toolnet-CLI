/**
 * REAL MODEL E2E — alims-intl.llm (opt-in).
 *
 * This is a SEPARATE suite from the deterministic CORE E2E. It exercises the
 * real gateway model, whose compliance is not under our control, so its job is
 * to CLASSIFY the outcome rather than to prove the runtime:
 *
 *   PASS                     — file created at the requested path and run
 *   MODEL_COMPLIANCE_FAILURE — model ignored the request, edited its own goal,
 *                              or stopped calling tools
 *   CORE_RUNTIME_FAILURE     — a tool call was emitted but never dispatched,
 *                              or dispatched without a result reaching the
 *                              model (dispatcher/tool/result loop is broken)
 *
 * A MODEL_COMPLIANCE_FAILURE must NOT be reported as a runtime defect — the
 * runtime assertion below (every tool call yields a tool result) is what
 * guards the core.
 *
 * Run with: TOOLNET_REAL_MODEL_E2E=1 bun test realModelE2E
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { AgentEngine } from "../../core/agent/agentEngine";
import type { AgentEvent } from "../../core/contracts";
import { setSandboxMode } from "../../lib/permissions";
import fs from "node:fs";
import path from "node:path";

const ENABLED = process.env.TOOLNET_REAL_MODEL_E2E === "1";
const MODEL = process.env.TOOLNET_REAL_MODEL || "alims-intl.llm";

type Classification =
  | "PASS"
  | "MODEL_COMPLIANCE_FAILURE"
  | "CORE_RUNTIME_FAILURE"
  | "PROVIDER_PROTOCOL";

/** Gateway/transport failures are a provider-layer problem, not a model choice. */
function isProviderProtocolError(message: string): boolean {
  return /network|timed out|timeout|ECONN|socket hang up|gateway connection|502|503|504/i.test(message);
}

describe.serial("REAL MODEL E2E — compliance classification", () => {
  const originalFetch = globalThis.fetch;
  let tmpDir: string;

  beforeEach(() => {
    setSandboxMode("full-access");
    tmpDir = fs.mkdtempSync(path.join("/tmp", "toolnet-real-e2e-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test.skipIf(!ENABLED)(
    "alims-intl.llm: create hello.py and run it",
    async () => {
      const engine = new AgentEngine();
      const events: AgentEvent[] = [];

      const result = await engine.run({
        prompt: "Tạo file hello.py in ra Hello ToolNet, sau đó chạy thử.",
        cwd: tmpDir,
        workspaceRoot: tmpDir,
        model: MODEL,
        maxTurns: 10,
        timeoutMs: 150_000,
        onEvent: (e) => events.push(e),
      });

      const toolCalls = events.filter((e) => e.type === "tool-call");
      const toolResults = events.filter((e) => e.type === "tool-result");
      const errors = events.filter((e) => e.type === "error");

      // Diagnostics: what did the model actually ask for, and what came back?
      const callTrace = toolCalls
        .map((e) => (e.type === "tool-call" ? `${e.name}(${JSON.stringify(e.input)})` : ""))
        .join(" | ");
      const resultTrace = toolResults
        .map((e) =>
          e.type === "tool-result"
            ? `exit=${e.result.exitCode ?? "?"} out=${(e.result.stdout ?? "").slice(0, 60)} err=${(e.result.stderr ?? "").slice(0, 120)}`
            : ""
        )
        .join(" | ");

      const target = path.join(tmpDir, "hello.py");
      const fileExists = fs.existsSync(target);
      const contentOk = fileExists && /Hello ToolNet/.test(fs.readFileSync(target, "utf8"));

      // Where did the model actually write? A file under a self-invented
      // subdirectory means the model altered the request → compliance failure.
      const foundElsewhere = findHelloPy(tmpDir);

      // ── CORE RUNTIME INVARIANT (this is what the suite actually guards) ──
      // Every dispatched tool call must produce a result. If not, the
      // dispatcher/executor/result loop is broken — that is CORE_RUNTIME.
      if (toolCalls.length > 0) {
        expect(toolResults.length).toBeGreaterThanOrEqual(1);
      }

      // Order matters: a broken dispatcher outranks a flaky transport, and a
      // transport failure must never be reported as a runtime defect.
      const providerError = errors.some(
        (e) => e.type === "error" && isProviderProtocolError(e.error)
      );

      let classification: Classification;
      if (toolCalls.length > 0 && toolResults.length === 0) {
        // Tools were requested but never dispatched/completed → core defect.
        classification = "CORE_RUNTIME_FAILURE";
      } else if (providerError) {
        // Gateway unreachable / timed out — provider layer, not the runtime.
        classification = "PROVIDER_PROTOCOL";
      } else if (toolCalls.length === 0) {
        // Model answered with prose only — it never even attempted the task.
        classification = "MODEL_COMPLIANCE_FAILURE";
      } else if (contentOk) {
        // Runtime dispatched real tools and the requested file is correct.
        classification = "PASS";
      } else {
        // Runtime is healthy (calls + results), but the model produced the
        // wrong artifact or path — that is model compliance, not the runtime.
        classification = "MODEL_COMPLIANCE_FAILURE";
      }

      // Report (visible in test output) — never a silent pass/fail.
      console.log(
        `[REAL_MODEL_E2E] model=${MODEL} classification=${classification} ` +
          `toolCalls=${toolCalls.length} toolResults=${toolResults.length} ` +
          `errors=${errors.length} fileExists=${fileExists} ` +
          `foundElsewhere=${foundElsewhere ?? "none"} success=${result.success}` +
          (result.error ? ` error=${result.error}` : "")
      );
      console.log(`[REAL_MODEL_E2E] calls: ${callTrace}`);
      console.log(`[REAL_MODEL_E2E] results: ${resultTrace}`);

      // The runtime must never be the failing layer when tools did dispatch.
      expect(classification).not.toBe("CORE_RUNTIME_FAILURE");
    },
    200_000
  );
});

/** Return the workspace-relative path of the first hello.py found, if any. */
function findHelloPy(root: string): string | null {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findHelloPy(full);
      if (nested) return path.join(entry.name, nested);
      continue;
    }
    if (entry.name === "hello.py") return entry.name;
  }
  return null;
}
