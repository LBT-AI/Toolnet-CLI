/**
 * Phase 80 §11 — Deterministic graders.
 *
 * No LLM judge. Each grader inspects evidence the runtime actually produced:
 * the final text, the observed tool-call stream, the real filesystem and real
 * command exit codes. That is what makes "the model said it fixed the file" a
 * FAIL when no tool ran.
 *
 * Every grader returns partial credit via `score` (0..1) and always explains
 * itself in `detail`, so a failed case is diagnosable without re-running.
 */

import fs from "node:fs";
import path from "node:path";
import type { EvalGraderSpec, EvalObservation, Grader, GraderResult } from "./types";

// ── Shared helpers ──────────────────────────────────────────────────────────

function ok(detail: string): GraderResult {
  return { pass: true, score: 1, detail };
}

function fail(detail: string): GraderResult {
  return { pass: false, score: 0, detail };
}

/** Partial credit, rounded to 3 decimals. */
function partial(numerator: number, denominator: number, detail: string): GraderResult {
  const score = denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : 0;
  return { pass: score >= 1, score, detail };
}

function normalize(text: string, ignoreCase: boolean, ignoreWhitespace: boolean): string {
  let out = text;
  if (ignoreWhitespace) out = out.replace(/\s+/g, "");
  else out = out.trim();
  if (ignoreCase) out = out.toLowerCase();
  return out;
}

/**
 * Extract the first balanced JSON object/array from arbitrary model text.
 * Handles fenced code blocks and surrounding prose. Returns null when there is
 * no complete JSON value.
 */
export function extractJson(text: string): unknown {
  if (typeof text !== "string" || text.length === 0) return null;

  // Prefer a fenced ```json block when present.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const haystack = fence ? fence[1] : text;

  const start = haystack.search(/[[{]/);
  if (start === -1) return null;

  const opener = haystack[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < haystack.length; i++) {
    const char = haystack[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === opener) depth += 1;
    else if (char === closer) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(haystack.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Minimal JSON-schema validation covering the subset eval cases need:
 * type, enum, required, properties, items, additionalProperties.
 * Returns a list of violations (empty ⇒ valid).
 */
export function validateJsonSchema(value: unknown, schema: unknown, pathHint = "$"): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const spec = schema as Record<string, unknown>;
  const errors: string[] = [];

  if (Array.isArray(spec.enum)) {
    if (!spec.enum.some((candidate) => deepEqual(candidate, value))) {
      errors.push(`${pathHint}: value not in enum`);
    }
  }

  if (typeof spec.type === "string") {
    const actual = jsonType(value);
    const expected = spec.type;
    const matches =
      actual === expected ||
      (expected === "integer" && actual === "number" && Number.isInteger(value)) ||
      (expected === "number" && actual === "integer");
    if (!matches) {
      errors.push(`${pathHint}: expected ${expected}, got ${actual}`);
      return errors;
    }
  }

  if (spec.type === "object" || (spec.properties && jsonType(value) === "object")) {
    const record = (value ?? {}) as Record<string, unknown>;
    for (const key of Array.isArray(spec.required) ? spec.required : []) {
      if (typeof key === "string" && !(key in record)) errors.push(`${pathHint}.${key}: required property missing`);
    }
    if (spec.properties && typeof spec.properties === "object") {
      for (const [key, childSchema] of Object.entries(spec.properties as Record<string, unknown>)) {
        if (key in record) errors.push(...validateJsonSchema(record[key], childSchema, `${pathHint}.${key}`));
      }
    }
    if (spec.additionalProperties === false && spec.properties && typeof spec.properties === "object") {
      const allowed = new Set(Object.keys(spec.properties as Record<string, unknown>));
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) errors.push(`${pathHint}.${key}: additional property not allowed`);
      }
    }
  }

  if (Array.isArray(value) && spec.items) {
    value.forEach((entry, index) => {
      errors.push(...validateJsonSchema(entry, spec.items, `${pathHint}[${index}]`));
    });
  }

  return errors;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── Graders ─────────────────────────────────────────────────────────────────

export const exactMatchGrader: Grader = (observation, spec) => {
  const expected = spec.value ?? "";
  const ignoreCase = spec.ignoreCase ?? true;
  const ignoreWhitespace = spec.ignoreWhitespace ?? true;
  const actual = normalize(observation.output, ignoreCase, ignoreWhitespace);
  const want = normalize(expected, ignoreCase, ignoreWhitespace);
  return actual === want ? ok("exact match") : fail(`expected '${expected}', got '${observation.output.trim().slice(0, 200)}'`);
};

export const containsGrader: Grader = (observation, spec) => {
  const text = observation.output ?? "";
  const haystack = (spec.ignoreCase ?? true) ? text.toLowerCase() : text;
  const matcher = (needle: string) => ((spec.ignoreCase ?? true) ? needle.toLowerCase() : needle);

  const missing = (spec.containsAll ?? []).filter((needle) => !haystack.includes(matcher(needle)));
  const forbidden = (spec.notContains ?? []).filter((needle) => haystack.includes(matcher(needle)));
  const any = spec.containsAny ?? [];

  if (missing.length > 0) return fail(`missing required text: ${missing.join(", ")}`);
  if (forbidden.length > 0) return fail(`contains forbidden text: ${forbidden.join(", ")}`);
  if (any.length > 0 && !any.some((needle) => haystack.includes(matcher(needle)))) {
    return fail(`none of the expected alternatives present: ${any.join(", ")}`);
  }
  return ok("all required text present");
};

export const regexGrader: Grader = (observation, spec) => {
  if (!spec.pattern) return fail("regex grader needs a pattern");
  let regex: RegExp;
  try {
    regex = new RegExp(spec.pattern, spec.flags ?? "");
  } catch (error) {
    // A malformed grader pattern is a SPEC bug: report it, never silently pass.
    return fail(`invalid grader pattern: ${error instanceof Error ? error.message : String(error)}`);
  }
  return regex.test(observation.output ?? "")
    ? ok(`matched /${spec.pattern}/`)
    : fail(`output did not match /${spec.pattern}/`);
};

export const jsonSchemaGrader: Grader = (observation, spec) => {
  const parsed = extractJson(observation.output ?? "");
  if (parsed === null) return fail("no parseable JSON found in output");
  const errors = validateJsonSchema(parsed, spec.schema);
  return errors.length === 0 ? ok("JSON conforms to schema") : fail(`schema violations: ${errors.join("; ")}`);
};

/**
 * Tool-call grader — the metric that matters most for ToolNet.
 *
 * Checks selection, count bounds, duplicate invocations, and (optionally) that
 * every call succeeded. A case that requires a tool call FAILS when the model
 * only narrated (§13).
 */
export const toolCallGrader: Grader = (observation, spec) => {
  const calls = observation.toolCalls ?? [];
  const expected = spec.expectTool
    ? Array.isArray(spec.expectTool)
      ? spec.expectTool
      : [spec.expectTool]
    : [];

  if (spec.allowNoToolCall === false && calls.length === 0) {
    return fail("expected at least one tool call, observed none (model narrated without acting)");
  }

  const observedNames = new Set(calls.map((call) => call.name));
  // `expectTool` lists ACCEPTABLE alternatives (the same capability often has
  // several tool names across profiles), so the requirement is "at least one".
  const satisfied = expected.length === 0 || expected.some((name) => observedNames.has(name));
  if (!satisfied) {
    return fail(
      `expected one of tool call(s) [${expected.join(", ")}]; observed ${[...observedNames].join(", ") || "none"}`,
    );
  }

  const min = spec.minToolCalls ?? (expected.length > 0 ? 1 : 0);
  if (calls.length < min) return fail(`expected >= ${min} tool calls, observed ${calls.length}`);
  if (spec.maxToolCalls !== undefined && calls.length > spec.maxToolCalls) {
    return fail(`expected <= ${spec.maxToolCalls} tool calls, observed ${calls.length}`);
  }

  if (spec.allowDuplicateToolCalls === false) {
    const seen = new Set<string>();
    for (const call of calls) {
      const signature = `${call.name}:${stableStringify(call.arguments)}`;
      if (seen.has(signature)) return fail(`duplicate tool call detected: ${call.name}`);
      seen.add(signature);
    }
  }

  if (spec.requireSuccessfulTools) {
    const failed = calls.filter((call) => !call.ok);
    if (failed.length > 0) return fail(`tool call(s) failed: ${failed.map((call) => call.name).join(", ")}`);
  }

  if (expected.length > 0) return ok(`invoked an accepted tool (${[...observedNames].join(", ")})`);
  return ok(`${calls.length} tool call(s), all within bounds`);
};

/** Filesystem grader — inspects the REAL workspace, never the model's claim. */
export const fileMutationGrader: Grader = (observation, spec) => {
  if (!spec.path) return fail("file-mutation grader needs a path");
  const target = path.isAbsolute(spec.path) ? spec.path : path.join(observation.workspaceRoot, spec.path);
  const exists = fs.existsSync(target);
  const relative = path.relative(observation.workspaceRoot, target);

  if (spec.expectAbsent === true) {
    return exists ? fail(`expected '${relative}' to be absent, but it exists`) : ok(`'${relative}' absent as expected`);
  }

  if (spec.expectExists !== false && !exists) {
    return fail(`expected '${relative}' to exist, but it does not`);
  }

  if (!exists) return ok(`'${relative}' does not exist`);

  let content: string;
  try {
    content = fs.readFileSync(target, "utf8");
  } catch (error) {
    return fail(`could not read '${relative}': ${error instanceof Error ? error.message : String(error)}`);
  }

  if (spec.expectContent !== undefined && !content.includes(spec.expectContent)) {
    return fail(`'${relative}' does not contain expected text`);
  }
  if (spec.expectNotContent !== undefined && content.includes(spec.expectNotContent)) {
    return fail(`'${relative}' still contains text that should be gone`);
  }
  if (spec.expectMatches !== undefined) {
    let regex: RegExp;
    try {
      regex = new RegExp(spec.expectMatches);
    } catch {
      return fail(`invalid expectMatches pattern`);
    }
    if (!regex.test(content)) return fail(`'${relative}' does not match /${spec.expectMatches}/`);
  }
  return ok(`'${relative}' verified on disk`);
};

/** Exit-code grader — real command outcome, not a claim. */
export const commandExitGrader: Grader = (observation, spec) => {
  const allowed = spec.exitCodes ?? [0];
  if (observation.exitCodes.length === 0) return fail("no post-command exit code recorded");
  const actual = observation.exitCodes[observation.exitCodes.length - 1];
  return allowed.includes(actual)
    ? ok(`exit code ${actual} allowed`)
    : fail(`exit code ${actual} not in [${allowed.join(", ")}] :: ${observation.postCommandOutput.join("\n").slice(0, 300)}`);
};

/**
 * Run-state grader — for cases whose assertion is about the RUN itself:
 * cancellation stopped execution, a malformed task did not crash, or a runtime
 * error is expected. Deliberately separate from content grading so a runtime
 * failure can never be laundered into a passing text match.
 */
export const runStateGrader: Grader = (observation, spec) => {
  // An explicit cancellation expectation OWNS the assertion: a cancelled run
  // legitimately surfaces as an aborted provider call, which would otherwise be
  // misread as a runtime error.
  if (spec.expectCancelled !== undefined) {
    if (observation.cancelled === spec.expectCancelled) {
      return ok(`cancelled=${observation.cancelled} as expected`);
    }
    return fail(
      spec.expectCancelled
        ? "expected the run to be cancelled, but it completed"
        : "run was cancelled but was expected to complete",
    );
  }

  if (spec.expectRuntimeError === true) {
    return observation.runtimeError
      ? ok(`runtime error observed: ${observation.runtimeError}`)
      : fail("expected a runtime error, none occurred");
  }
  if (observation.runtimeError) return fail(`runtime error: ${observation.runtimeError}`);
  if (spec.expectNoCrash === true) return ok("run completed without a runtime error");
  return ok("run state as expected");
};

const GRADERS: Record<EvalGraderSpec["kind"], Grader> = {
  exact: exactMatchGrader,
  contains: containsGrader,
  regex: regexGrader,
  "json-schema": jsonSchemaGrader,
  "tool-call": toolCallGrader,
  "file-mutation": fileMutationGrader,
  "command-exit": commandExitGrader,
  "run-state": runStateGrader,
};

/** Resolve a grader by spec kind. Unknown kinds fail loudly. */
export function graderFor(spec: EvalGraderSpec): Grader {
  const grader = GRADERS[spec.kind];
  if (!grader) {
    return () => ({ pass: false, score: 0, detail: `unknown grader kind '${String(spec.kind)}'` });
  }
  return grader;
}

/** Stable key for de-duplicating tool calls regardless of key order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
