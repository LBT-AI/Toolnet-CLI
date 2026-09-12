/**
 * Phase 83 §23 — Adapter protocol tests.
 *
 * Fixtures mirror the REAL event schemas from source:
 *  - Codex: `codex-rs/exec/src/exec_events.rs` ThreadEvent JSONL;
 *  - OpenCode: `packages/opencode/src/cli/cmd/run.ts --format json`, plus the
 *    live `error` event observed against opencode 1.18.30.
 *
 * §26 defect hunt: exit-0 + structured failure, partial JSON lines, unknown
 * additive fields, prose where JSON was promised, stderr floods.
 */

import { describe, expect, it } from "bun:test";
import { createCodexAdapter, createOpenCodeAdapter, createClaudeAdapter, createHermesAdapter } from "../adapters";
import { parseAll } from "../runner";
import { namespacedSession, parseNamespacedSession } from "../runner";

// ── Codex (exec_events.rs ThreadEvent JSONL) ────────────────────────────────

describe("Phase 83 §10 — Codex parser", () => {
  const adapter = createCodexAdapter();

  it("parses thread.started and captures the thread id", () => {
    const events = adapter.parseEvent('{"type":"thread.started","thread_id":"thr_123"}');
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe("started");
    expect(events[0].sessionId).toBe("thr_123");
  });

  it("parses turn.completed with normalized usage and terminal success", () => {
    const events = adapter.parseEvent(
      '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":20,"output_tokens":50,"reasoning_output_tokens":10}}',
    );
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe("usage");
    expect(events[0].terminalSuccess).toBe(true);
    expect(events[0].usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 50,
      reasoningTokens: 10,
    });
  });

  it("parses turn.failed as a terminal structured failure", () => {
    const events = adapter.parseEvent('{"type":"turn.failed","error":{"message":"model exploded"}}');
    expect(events[0].kind).toBe("failed");
    expect(events[0].terminalFailure).toBe(true);
    expect(events[0].text).toBe("model exploded");
  });

  it("maps item types to the right normalized events", () => {
    const message = adapter.parseEvent(
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"final answer"}}',
    );
    expect(message[0].kind).toBe("output");
    expect(message[0].text).toBe("final answer");

    const command = adapter.parseEvent(
      '{"type":"item.completed","item":{"id":"i2","type":"command_execution","command":"bun test","exit_code":0,"status":"completed"}}',
    );
    expect(command[0].kind).toBe("tool_completed");
    expect(command[0].command).toBe("bun test");
    expect(command[0].exitCode).toBe(0);

    const fileChange = adapter.parseEvent(
      '{"type":"item.completed","item":{"id":"i3","type":"file_change","status":"completed","changes":[{"path":"src/a.ts","kind":"update"}]}}',
    );
    expect(fileChange[0].kind).toBe("file_changed");
    expect(fileChange[0].path).toBe("src/a.ts");
    expect(fileChange[0].change).toBe("update");
  });

  it("an unknown additive event type is evidence, not a crash or invented semantics", () => {
    const events = adapter.parseEvent('{"type":"some.future.event","new_field":{"deep":[1,2]}}');
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe("output");
    expect(events[0].terminalFailure).toBeUndefined();
    expect(events[0].terminalSuccess).toBeUndefined();
  });

  it("prose lines (non-JSON) produce no fabricated events", () => {
    expect(adapter.parseEvent("Done. tokens used: 42")).toEqual([]);
  });

  it("partial JSON lines produce no events and no throw", () => {
    expect(adapter.parseEvent('{"type":"turn.comp')).toEqual([]);
  });

  it("§8 — exit 0 + structured failure stays FAILED (never trust exit code alone)", () => {
    const verdict = adapter.normalizeResult({
      events: [{ kind: "failed", terminalFailure: true, text: "boom" }],
      exitCode: 0,
      killed: false,
      timedOut: false,
    });
    expect(verdict.status).toBe("FAILED");
  });

  it("§8 — exit nonzero without structured failure is FAILED with protocol class", () => {
    const verdict = adapter.normalizeResult({
      events: [],
      exitCode: 1,
      killed: false,
      timedOut: false,
    });
    expect(verdict.status).toBe("FAILED");
    expect(verdict.failureClass).toBe("HARNESS_PROTOCOL");
  });

  it("turn.completed wins over a nonzero exit code when streams disagree", () => {
    const verdict = adapter.normalizeResult({
      events: [{ kind: "usage", terminalSuccess: true, usage: { outputTokens: 5 } }],
      exitCode: 137,
      killed: false,
      timedOut: false,
    });
    expect(verdict.status).toBe("SUCCESS");
  });
});

// ── OpenCode (run --format json) ────────────────────────────────────────────

describe("Phase 83 §9 — OpenCode parser", () => {
  const adapter = createOpenCodeAdapter();

  it("parses the live error event (auth failure) as a terminal failure", () => {
    // Captured from opencode 1.18.30 with an invalid key; redacted shape.
    const line =
      '{"type":"error","timestamp":1789250871069,"sessionID":"ses_abc","error":{"name":"APIError","data":{"message":"Incorrect API key provided","statusCode":401}}}';
    const events = adapter.parseEvent(line);
    expect(events[0].kind).toBe("failed");
    expect(events[0].terminalFailure).toBe(true);
    expect(events[0].sessionId).toBe("ses_abc");
    expect(events[0].text).toBe("Incorrect API key provided");
  });

  it("session.idle is terminal success; message parts map to output/reasoning/tool", () => {
    const idle = adapter.parseEvent('{"type":"session.idle","sessionID":"ses_x"}');
    expect(idle[0].terminalSuccess).toBe(true);

    const text = adapter.parseEvent('{"type":"message.part.updated","part":{"type":"text","text":"hello"}}');
    expect(text[0].kind).toBe("output");
    expect(text[0].text).toBe("hello");

    const reasoning = adapter.parseEvent('{"type":"message.part.updated","part":{"type":"reasoning","text":"thinking"}}');
    expect(reasoning[0].kind).toBe("reasoning");

    const tool = adapter.parseEvent(
      '{"type":"message.part.updated","part":{"type":"tool","tool":"bash","state":{"status":"completed"}}}',
    );
    expect(tool[0].kind).toBe("tool_completed");
    expect(tool[0].tool).toBe("bash");
  });

  it("buildInvocation composes provider/model correctly and keeps the prompt one argv element", () => {
    const invocation = adapter.buildInvocation({
      prompt: "fix; rm -rf $(x) `y` && z",
      cwd: "/tmp",
      model: { logicalModel: "anthropic/claude-sonnet", provider: "anthropic", apiModelId: "claude-sonnet" },
    });
    expect(invocation.argv.slice(0, 3)).toEqual(["run", "--format", "json"]);
    expect(invocation.argv).toContain("--model");
    expect(invocation.argv[invocation.argv.indexOf("--model") + 1]).toBe("anthropic/claude-sonnet");
    // The prompt (with shell metacharacters) is a single positional element.
    expect(invocation.argv[invocation.argv.length - 1]).toBe("fix; rm -rf $(x) `y` && z");
  });

  it("resume adds --session and --fork adds --fork", () => {
    const invocation = adapter.buildInvocation({
      prompt: "continue",
      cwd: "/tmp",
      resume: { harnessId: "opencode", externalSessionId: "ses_9" },
      forkSession: true,
    });
    expect(invocation.argv).toContain("--session");
    expect(invocation.argv[invocation.argv.indexOf("--session") + 1]).toBe("ses_9");
    expect(invocation.argv).toContain("--fork");
  });

  it("adapter claims structured output and external trust", () => {
    expect(adapter.capabilities.structuredOutput).toBe(true);
    expect(adapter.executionTrust).toBe("external_managed");
  });
});

// ── Conservative Claude / Hermes (§11) ──────────────────────────────────────

describe("Phase 83 §11 — conservative Claude/Hermes definitions", () => {
  it("claude keeps unverified capabilities unknown and does not invent a JSON schema", () => {
    const adapter = createClaudeAdapter();
    expect(adapter.capabilities.structuredOutput).toBe("unknown");
    // Invocation is plain argv, no fabricated flags.
    const invocation = adapter.buildInvocation({ prompt: "hello", cwd: "/tmp" });
    expect(invocation.argv).toEqual(["-p", "hello"]);
    // Text protocol: output lines become output events.
    expect(adapter.parseEvent("some prose output")[0].kind).toBe("output");
  });

  it("hermes reports structuredOutput=false — text-only result parsing", () => {
    const adapter = createHermesAdapter();
    expect(adapter.capabilities.structuredOutput).toBe(false);
    expect(adapter.parseEvent("plain text")[0].kind).toBe("output");
  });
});

// ── Runner integration: line buffering + full normalization ─────────────────

describe("Phase 83 §26 — runner-level protocol defect hunt", () => {
  const codex = createCodexAdapter();

  it("parseAll skips malformed lines and still parses the good ones", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"t1"}',
      "this is a garbage prose line",
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}',
      '{"type":"turn.comp",', // partial trailing line
    ].join("\n");
    const events = parseAll(codex, stdout);
    expect(events.map((event) => event.kind)).toEqual(["started", "usage"]);
  });

  it("a run with events but no terminal event is PARTIAL on exit 0", () => {
    const verdict = codex.normalizeResult({
      events: [{ kind: "output", text: "half finished" }],
      exitCode: 0,
      killed: false,
      timedOut: false,
    });
    expect(verdict.status).toBe("PARTIAL");
  });
});

// ── §15 session namespace ───────────────────────────────────────────────────

describe("Phase 83 §15 — external session identity", () => {
  it("namespaces and round-trips", () => {
    const sessionId = namespacedSession("opencode", "ses_1");
    expect(sessionId).toBe("external:opencode:ses_1");
    const parsed = parseNamespacedSession(sessionId);
    expect(parsed).toEqual({ harnessId: "opencode", externalSessionId: "ses_1" });
  });

  it("native session ids do not parse as external", () => {
    expect(parseNamespacedSession("toolnet-session-123")).toBeNull();
    expect(parseNamespacedSession("external:opencode")).toBeNull();
  });

  it("cross-harness resume is denied", async () => {
    const { ExternalHarnessRunner } = await import("../runner");
    const { ExternalHarnessRegistry } = await import("../registry");
    const registry = new ExternalHarnessRegistry();
    registry.register(createOpenCodeAdapter());
    const runner = new ExternalHarnessRunner(registry);
    // codex session into the opencode runner must be a protocol error before spawn.
    await expect(
      runner.run({
        harnessId: "opencode",
        prompt: "hi",
        resume: { harnessId: "codex", externalSessionId: "thr_1" },
      }),
    ).rejects.toThrow(/different harness/);
  });
});
