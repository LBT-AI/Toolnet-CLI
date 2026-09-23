/**
 * Checkpoint summary text work: bounded head serialization and the prompt that
 * constrains a summarizer.
 *
 * The two properties worth protecting here are the ones that keep compaction
 * lossy in the intended direction only — a huge or binary payload is DESCRIBED
 * rather than copied forward, and a previous checkpoint is handed over for
 * replacement instead of being resummarized from raw history.
 */

import { describe, expect, test } from "bun:test";
import type { ContextMessage } from "../types";
import {
  buildSummaryPrompt,
  capToolResult,
  CHECKPOINT_SUMMARY_SECTIONS,
  describeAttachment,
  looksLikeAttachment,
  serializeHeadTranscript,
  SUMMARY_TOOL_ARGS_CHAR_CAP,
  SUMMARY_TOOL_RESULT_CHAR_CAP,
} from "../checkpointSummary";

describe("tool output is bounded before it enters a summary", () => {
  test("a small result passes through untouched", () => {
    const content = JSON.stringify({ stdout: "ok", exitCode: 0 });
    expect(capToolResult(content)).toBe(content);
  });

  test("a large result is capped and says exactly how much was dropped", () => {
    // Prose with spaces: a long run of the base64 alphabet would (correctly) be
    // treated as a payload instead.
    const content = "error: something failed in the build\n".repeat(200);
    const omitted = content.length - SUMMARY_TOOL_RESULT_CHAR_CAP;
    const capped = capToolResult(content);
    expect(capped.startsWith("error: something failed in the build")).toBe(true);
    expect(capped).toContain(`${omitted} more characters omitted`);
    expect(capped.length).toBeLessThan(content.length);
  });

  test("a data URI becomes a description instead of being copied forward", () => {
    const base64 = "A".repeat(4_000);
    const payload = `data:image/png;base64,${base64}`;
    expect(looksLikeAttachment(payload)).toBe(true);
    const described = describeAttachment(payload);
    expect(described).toContain("image/png");
    expect(described).toContain("base64 chars");
    expect(described).not.toContain(base64.slice(0, 50));
    // The same rule holds on the code path the serializer uses.
    expect(capToolResult(payload)).toBe(described);
  });

  test("a bare base64 blob is described, but long prose is not", () => {
    const blob = "QWxwaGFiZXRCbG9i".repeat(60); // long, no spaces, base64 alphabet
    expect(looksLikeAttachment(blob)).toBe(true);
    expect(describeAttachment(blob)).toContain("binary/encoded data");

    const prose = `${"word ".repeat(300)}done`;
    expect(looksLikeAttachment(prose)).toBe(false);
  });
});

describe("head serialization", () => {
  test("roles, tool calls and tool results are rendered in order", () => {
    const head: ContextMessage[] = [
      { role: "system", content: "ignored: the primary system message is kept separately" },
      { role: "user", content: "fix the API" },
      {
        role: "assistant",
        content: "checking",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"api.ts"}' } }],
      },
      { role: "tool", name: "read_file", tool_call_id: "c1", content: JSON.stringify({ stdout: "code", exitCode: 0 }) },
      { role: "assistant", content: "found it" },
    ];

    const text = serializeHeadTranscript(head);
    expect(text).not.toContain("ignored: the primary system message");
    expect(text.indexOf("[User]: fix the API")).toBe(0);
    expect(text).toContain("[Assistant]: checking");
    expect(text).toContain('[Assistant tool call]: read_file({"path":"api.ts"})');
    expect(text).toContain("[Tool result: read_file]");
    expect(text).toContain("[Assistant]: found it");
  });

  test("tool call arguments are flattened and bounded", () => {
    const head: ContextMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "bash", arguments: `{"cmd":"x"${"y".repeat(2_000)}}` } },
        ],
      },
    ];
    const text = serializeHeadTranscript(head);
    expect(text).toContain("[Assistant tool call]: bash(");
    expect(text.length).toBeLessThan(SUMMARY_TOOL_ARGS_CHAR_CAP + 100);
  });

  test("the checkpoint being replaced is not serialized as conversation", () => {
    const prior = "[Context Compaction Summary]\n## Objective\nShip the fix";
    const head: ContextMessage[] = [
      { role: "user", content: prior },
      { role: "user", content: "and now the new work" },
    ];
    const text = serializeHeadTranscript(head, { priorSummary: prior });
    expect(text).not.toContain("Ship the fix");
    expect(text).toContain("and now the new work");
  });
});

describe("summarization prompt", () => {
  test("demands the full structure and the preserved identifiers", () => {
    const prompt = buildSummaryPrompt({ headTranscript: "[User]: do it" });
    for (const section of CHECKPOINT_SUMMARY_SECTIONS) {
      expect(prompt).toContain(section);
    }
    expect(prompt).toContain("<conversation>");
    expect(prompt).toContain("[User]: do it");
    expect(prompt).toContain("Keep identifiers verbatim");
    expect(prompt).not.toContain("<prior-summary>");
  });

  test("hands a previous checkpoint over as prior-summary and warns it is discarded", () => {
    const prompt = buildSummaryPrompt({
      headTranscript: "[User]: continue",
      priorSummary: "[Context Compaction Summary]\n## Objective\nEarlier goal",
    });
    expect(prompt).toContain("<prior-summary>");
    expect(prompt).toContain("</prior-summary>");
    expect(prompt).toContain("Earlier goal");
    expect(prompt).toContain("will be discarded after this step");
    // The old summary is input, not conversation.
    expect(prompt.indexOf("<prior-summary>")).toBeLessThan(prompt.indexOf("<conversation>"));
  });
});
