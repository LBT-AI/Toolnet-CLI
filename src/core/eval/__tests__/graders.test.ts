import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  commandExitGrader,
  containsGrader,
  exactMatchGrader,
  extractJson,
  fileMutationGrader,
  graderFor,
  jsonSchemaGrader,
  regexGrader,
  runStateGrader,
  toolCallGrader,
  validateJsonSchema,
} from "../graders";
import type { EvalObservation, ObservedToolCall } from "../types";

const tmpDirs: string[] = [];

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase80-grader-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function observation(overrides: Partial<EvalObservation> = {}): EvalObservation {
  return {
    output: "",
    toolCalls: [],
    workspaceRoot: workspace(),
    filesRead: [],
    filesWritten: [],
    exitCodes: [],
    postCommandOutput: [],
    cancelled: false,
    durationMs: 0,
    ...overrides,
  };
}

function call(name: string, args: unknown = {}, ok = true): ObservedToolCall {
  return { id: `${name}-${Math.random()}`, name, arguments: args, ok };
}

describe("Phase 80 — deterministic graders", () => {
  it("exact match ignores case and whitespace by default", () => {
    expect(exactMatchGrader(observation({ output: "  PoNg \n" }), { kind: "exact", value: "pong" }).pass).toBe(true);
    expect(exactMatchGrader(observation({ output: "pong!" }), { kind: "exact", value: "pong" }).pass).toBe(false);
  });

  it("exact match can be made case-sensitive", () => {
    expect(
      exactMatchGrader(observation({ output: "PONG" }), { kind: "exact", value: "pong", ignoreCase: false }).pass,
    ).toBe(false);
  });

  it("contains grader enforces required, forbidden and alternative text", () => {
    const obs = observation({ output: "The release codeword is banana-42." });
    expect(containsGrader(obs, { kind: "contains", containsAll: ["banana-42"] }).pass).toBe(true);
    expect(containsGrader(obs, { kind: "contains", containsAll: ["missing"] }).pass).toBe(false);
    expect(containsGrader(obs, { kind: "contains", notContains: ["banana-42"] }).pass).toBe(false);
    expect(containsGrader(obs, { kind: "contains", containsAny: ["apple", "banana"] }).pass).toBe(true);
    expect(containsGrader(obs, { kind: "contains", containsAny: ["apple", "pear"] }).pass).toBe(false);
  });

  it("regex grader reports a malformed pattern instead of passing", () => {
    expect(regexGrader(observation({ output: "45" }), { kind: "regex", pattern: "\\b45\\b" }).pass).toBe(true);
    const broken = regexGrader(observation({ output: "45" }), { kind: "regex", pattern: "([unclosed" });
    expect(broken.pass).toBe(false);
    expect(broken.detail).toContain("invalid grader pattern");
  });

  it("extracts JSON from prose and fenced blocks", () => {
    expect(extractJson('Here you go: {"a":1,"b":{"c":2}} thanks')).toEqual({ a: 1, b: { c: 2 } });
    expect(extractJson('```json\n{"name":"toolnet","version":"80"}\n```')).toEqual({ name: "toolnet", version: "80" });
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson('{"unterminated": ')).toBeNull();
  });

  it("validates the JSON-schema subset including required and additionalProperties", () => {
    const schema = {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: { name: { type: "string" }, count: { type: "integer" } },
    };
    expect(validateJsonSchema({ name: "x" }, schema)).toEqual([]);
    expect(validateJsonSchema({ name: "x", count: 2 }, schema)).toEqual([]);
    expect(validateJsonSchema({ name: 5 }, schema).length).toBeGreaterThan(0);
    expect(validateJsonSchema({ name: "x", extra: 1 }, schema).some((e) => e.includes("additional property"))).toBe(true);
    expect(validateJsonSchema({}, schema).some((e) => e.includes("required"))).toBe(true);
  });

  it("json-schema grader fails when the output is not JSON", () => {
    const result = jsonSchemaGrader(observation({ output: "I cannot do that." }), {
      kind: "json-schema",
      schema: { type: "object" },
    });
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("no parseable JSON");
  });

  it("tool-call grader treats expectTool as acceptable alternatives", () => {
    const obs = observation({ toolCalls: [call("read_file", { path: "a" })] });
    expect(toolCallGrader(obs, { kind: "tool-call", expectTool: ["read_file", "view_file"] }).pass).toBe(true);
    expect(toolCallGrader(obs, { kind: "tool-call", expectTool: ["write_file"] }).pass).toBe(false);
  });

  it("tool-call grader fails a model that narrated instead of acting", () => {
    const result = toolCallGrader(observation({ output: "I fixed it." }), {
      kind: "tool-call",
      allowNoToolCall: false,
    });
    expect(result.pass).toBe(false);
    expect(result.detail).toContain("narrated");
  });

  it("tool-call grader enforces count bounds, duplicates and success", () => {
    const obs = observation({
      toolCalls: [call("bash", { command: "ls" }), call("bash", { command: "ls" }), call("write_file", {}, false)],
    });
    expect(toolCallGrader(obs, { kind: "tool-call", maxToolCalls: 2 }).pass).toBe(false);
    expect(toolCallGrader(obs, { kind: "tool-call", allowDuplicateToolCalls: false }).pass).toBe(false);
    expect(toolCallGrader(obs, { kind: "tool-call", requireSuccessfulTools: true }).pass).toBe(false);
    expect(toolCallGrader(obs, { kind: "tool-call" }).pass).toBe(true);
  });

  it("file-mutation grader inspects the real filesystem", () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "fixed.ts"), "return a + b;\n", "utf8");

    expect(fileMutationGrader(observation({ workspaceRoot: root }), { kind: "file-mutation", path: "fixed.ts" }).pass).toBe(true);
    expect(
      fileMutationGrader(observation({ workspaceRoot: root }), {
        kind: "file-mutation",
        path: "fixed.ts",
        expectContent: "a + b",
      }).pass,
    ).toBe(true);
    expect(
      fileMutationGrader(observation({ workspaceRoot: root }), {
        kind: "file-mutation",
        path: "fixed.ts",
        expectContent: "a - b",
      }).pass,
    ).toBe(false);
    expect(
      fileMutationGrader(observation({ workspaceRoot: root }), { kind: "file-mutation", path: "ghost.ts" }).pass,
    ).toBe(false);
    expect(
      fileMutationGrader(observation({ workspaceRoot: root }), {
        kind: "file-mutation",
        path: "ghost.ts",
        expectAbsent: true,
      }).pass,
    ).toBe(true);
  });

  it("file-mutation grader can assert an out-of-scope file was not edited", () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "other.ts"), 'export const untouched = "ORIGINAL_MARKER";\n', "utf8");
    expect(
      fileMutationGrader(observation({ workspaceRoot: root }), {
        kind: "file-mutation",
        path: "other.ts",
        expectContent: "ORIGINAL_MARKER",
      }).pass,
    ).toBe(true);

    fs.writeFileSync(path.join(root, "other.ts"), "changed\n", "utf8");
    expect(
      fileMutationGrader(observation({ workspaceRoot: root }), {
        kind: "file-mutation",
        path: "other.ts",
        expectContent: "ORIGINAL_MARKER",
      }).pass,
    ).toBe(false);
  });

  it("command-exit grader uses the real recorded exit code", () => {
    expect(commandExitGrader(observation({ exitCodes: [0] }), { kind: "command-exit" }).pass).toBe(true);
    expect(commandExitGrader(observation({ exitCodes: [1] }), { kind: "command-exit" }).pass).toBe(false);
    expect(commandExitGrader(observation({ exitCodes: [1] }), { kind: "command-exit", exitCodes: [0, 1] }).pass).toBe(true);
    expect(commandExitGrader(observation({ exitCodes: [] }), { kind: "command-exit" }).pass).toBe(false);
  });

  it("run-state grader honours cancellation, no-crash and runtime-error expectations", () => {
    expect(runStateGrader(observation({ cancelled: true }), { kind: "run-state", expectCancelled: true }).pass).toBe(true);
    expect(runStateGrader(observation({ cancelled: false }), { kind: "run-state", expectCancelled: true }).pass).toBe(false);
    expect(runStateGrader(observation(), { kind: "run-state", expectNoCrash: true }).pass).toBe(true);
    expect(
      runStateGrader(observation({ runtimeError: "boom" }), { kind: "run-state", expectNoCrash: true }).pass,
    ).toBe(false);
    expect(
      runStateGrader(observation({ runtimeError: "boom" }), { kind: "run-state", expectRuntimeError: true }).pass,
    ).toBe(true);
  });

  it("run-state cancellation expectation overrides an abort-shaped runtime error", () => {
    const result = runStateGrader(
      observation({ cancelled: true, runtimeError: "The operation was aborted." }),
      { kind: "run-state", expectCancelled: true },
    );
    expect(result.pass).toBe(true);
  });

  it("resolves every documented grader kind and fails loudly on an unknown one", () => {
    for (const kind of ["exact", "contains", "regex", "json-schema", "tool-call", "file-mutation", "command-exit", "run-state"] as const) {
      expect(typeof graderFor({ kind })).toBe("function");
    }
    const unknown = graderFor({ kind: "nope" as never });
    expect(unknown(observation(), { kind: "nope" as never }).pass).toBe(false);
  });
});
