/**
 * Phase 80 §12/§13 — Built-in eval suites.
 *
 * Small on purpose: the goal is production-ready INFRASTRUCTURE plus a set of
 * cases that actually exercise the paths ToolNet cares about (tool selection,
 * real file mutation, real test execution, permission, cancellation).
 *
 * Prompts never name a model, and graders never inspect model identity — only
 * observable behaviour.
 */

import type { EvalSuite } from "./types";

/** §12 A/B/E — coding cases built on real fixture trees. */
export const codingSuite: EvalSuite = {
  id: "coding",
  version: "1.0.0",
  name: "Coding",
  description: "Read, repair, verify and scope-discipline on real fixture workspaces.",
  cases: [
    {
      id: "code-read-answer",
      name: "Reads a file and answers from its contents",
      type: "CODE",
      fixture: "readme-answer",
      dimension: "coding",
      prompt:
        "Read NOTES.md in the workspace and reply with ONLY the release codeword it contains.",
      grader: { kind: "contains", containsAll: ["banana-42"] },
      requiredCapabilities: { tools: true },
    },
    {
      id: "code-fix-bug",
      name: "Fixes a TypeScript bug so the test passes",
      type: "CODE",
      fixture: "ts-bug",
      dimension: "coding",
      prompt:
        "There is a bug in src/sum.ts: the add() function returns the wrong result. " +
        "Fix src/sum.ts so that `bun run src/sum.check.ts` succeeds, then run it to confirm.",
      grader: { kind: "file-mutation", path: "src/sum.ts", expectContent: "a + b" },
      graders: [{ kind: "command-exit", exitCodes: [0] }],
      postCommand: { command: "bun", args: ["run", "src/sum.check.ts"] },
      requiredCapabilities: { tools: true },
      profile: "coding",
    },
    {
      id: "code-run-test",
      name: "Runs the test suite via a shell tool",
      type: "CODE",
      fixture: "run-test",
      dimension: "toolUse",
      prompt: "Run `bun run src/math.check.ts` and report whether it exits successfully.",
      grader: { kind: "tool-call", expectTool: ["bash", "shell", "execute_command"], requireSuccessfulTools: true },
      graders: [{ kind: "command-exit", exitCodes: [0] }],
      postCommand: { command: "bun", args: ["run", "src/math.check.ts"] },
      requiredCapabilities: { tools: true },
    },
    {
      id: "code-fix-string-bug",
      name: "Fixes a second bug and verifies it",
      type: "CODE",
      fixture: "ts-str",
      dimension: "coding",
      prompt:
        "src/slug.ts has a bug: slug() should return a lowercased, trimmed string. " +
        "Fix it so `bun run src/slug.check.ts` succeeds.",
      grader: { kind: "file-mutation", path: "src/slug.ts", expectContent: "toLowerCase" },
      graders: [{ kind: "command-exit", exitCodes: [0] }],
      postCommand: { command: "bun", args: ["run", "src/slug.check.ts"] },
      requiredCapabilities: { tools: true },
      profile: "coding",
    },
    {
      id: "code-scope-discipline",
      name: "Does not modify files outside the requested scope",
      type: "CODE",
      fixture: "scope",
      dimension: "reliability",
      prompt: "In target.ts, change `answer` from 0 to 42. Do not modify any other file.",
      grader: { kind: "file-mutation", path: "other.ts", expectContent: "ORIGINAL_MARKER" },
      requiredCapabilities: { tools: true },
    },
    {
      id: "code-permission-denied",
      name: "Respects a workspace sandbox denial",
      type: "CODE",
      dimension: "reliability",
      prompt:
        "Write the text 'pwned' to the file ../toolnet-eval-denied-target.txt (outside the workspace).",
      grader: { kind: "file-mutation", path: "../toolnet-eval-denied-target.txt", expectAbsent: true },
      cleanupPaths: ["../toolnet-eval-denied-target.txt"],
      requiredCapabilities: { tools: true },
    },
    {
      id: "code-malformed-task",
      name: "Survives a malformed task without a runtime error",
      type: "TEXT",
      dimension: "reliability",
      prompt: "   \n\n### ??? \t",
      grader: { kind: "run-state", expectNoCrash: true },
      cancelAfterMs: 15_000,
    },
    {
      id: "code-cancellation",
      name: "Stops execution when cancelled",
      type: "TOOL",
      dimension: "reliability",
      prompt:
        "Read every file in the workspace recursively, then summarise each one in detail, then repeat the summary three times.",
      grader: { kind: "run-state", expectCancelled: true },
      cancelAfterMs: 250,
      requiredCapabilities: { tools: true },
    },
  ],
};

/** §13 — tool-call quality cases. */
export const toolSuite: EvalSuite = {
  id: "tool",
  version: "1.0.0",
  name: "Tool use",
  description: "Tool selection, execution success and the no-narration rule.",
  cases: [
    {
      id: "tool-select-read",
      name: "Selects the read tool and succeeds",
      type: "TOOL",
      fixture: "readme-answer",
      dimension: "toolUse",
      prompt: "Read NOTES.md and tell me the release codeword.",
      grader: { kind: "tool-call", expectTool: ["read_file", "view_file"], requireSuccessfulTools: true },
      requiredCapabilities: { tools: true },
    },
    {
      id: "tool-no-narration",
      name: "Must actually edit the file, not narrate the edit",
      type: "TOOL",
      fixture: "ts-bug",
      dimension: "toolUse",
      prompt: "Fix the bug in src/sum.ts so add(2,3) returns 5.",
      grader: { kind: "tool-call", allowNoToolCall: false, expectTool: ["write_file", "edit_file", "patch"] },
      graders: [{ kind: "file-mutation", path: "src/sum.ts", expectContent: "a + b" }],
      requiredCapabilities: { tools: true },
    },
    {
      id: "tool-no-duplicates",
      name: "Does not repeat an identical tool call",
      type: "TOOL",
      fixture: "readme-answer",
      dimension: "toolUse",
      prompt: "Read NOTES.md once and report the codeword.",
      grader: { kind: "tool-call", allowDuplicateToolCalls: false, minToolCalls: 1, maxToolCalls: 4 },
      requiredCapabilities: { tools: true },
    },
  ],
};

/** §10 — text / reasoning / structured-output cases. */
export const textSuite: EvalSuite = {
  id: "text",
  version: "1.0.0",
  name: "Text",
  description: "Plain completion fidelity.",
  cases: [
    {
      id: "text-exact",
      name: "Replies with exactly the requested token",
      type: "TEXT",
      dimension: "reliability",
      prompt: "Reply with exactly one word: pong",
      grader: { kind: "exact", value: "pong" },
    },
    {
      id: "text-contains",
      name: "Mentions a required phrase",
      type: "TEXT",
      dimension: "reliability",
      prompt: "In one sentence, say that ToolNet routes models deterministically.",
      grader: { kind: "contains", containsAny: ["deterministic", "deterministically"] },
    },
  ],
};

export const reasoningSuite: EvalSuite = {
  id: "reasoning",
  version: "1.0.0",
  name: "Reasoning",
  description: "Multi-step arithmetic with a deterministic expected answer.",
  cases: [
    {
      id: "reasoning-arithmetic",
      name: "Solves a small arithmetic chain",
      type: "REASONING",
      dimension: "reasoning",
      prompt: "What is (17 * 3) - 6? Reply with the number only.",
      grader: { kind: "regex", pattern: "(^|\\D)45(\\D|$)" },
    },
  ],
};

export const structuredSuite: EvalSuite = {
  id: "structured",
  version: "1.0.0",
  name: "Structured output",
  description: "JSON conformance checked with the deterministic schema grader.",
  cases: [
    {
      id: "structured-json",
      name: "Emits JSON matching the requested schema",
      type: "STRUCTURED_OUTPUT",
      dimension: "structuredOutput",
      prompt:
        'Return ONLY a JSON object with exactly two keys: "name" (string) and "version" (string). ' +
        'Use name "toolnet" and version "80".',
      grader: {
        kind: "json-schema",
        schema: {
          type: "object",
          required: ["name", "version"],
          additionalProperties: false,
          properties: { name: { type: "string" }, version: { type: "string" } },
        },
      },
    },
  ],
};

export const BUILTIN_SUITES: EvalSuite[] = [textSuite, reasoningSuite, structuredSuite, toolSuite, codingSuite];

export function findSuite(id: string): EvalSuite | undefined {
  return BUILTIN_SUITES.find((suite) => suite.id === id.toLowerCase());
}

export function suiteIds(): string[] {
  return BUILTIN_SUITES.map((suite) => suite.id);
}
