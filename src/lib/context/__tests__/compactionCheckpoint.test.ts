/**
 * Compaction checkpoint semantics.
 *
 * What must hold no matter how the summary is produced:
 *  - the recent tail survives VERBATIM while older turns are replaced;
 *  - the checkpoint is written by a model when one is injected, and by the
 *    deterministic builder when the model fails (compaction is never lost);
 *  - a previous checkpoint is folded in as input and then dropped, which is what
 *    makes repeated compaction lossy rather than re-derived from raw history.
 */

import { describe, expect, test } from "bun:test";
import { compactMessagesAtomically } from "../atomicCompactor";
import { COMPACTION_KEEP_RECENT_TOKENS } from "../../../core/context/limits";
import { CHECKPOINT_SUMMARY_MARKER } from "../checkpointSummary";
import type { ContextMessage } from "../types";

function filler(tokens: number, label: string): string {
  return `${label} ${"x".repeat(tokens * 4)}`;
}

function summaryMessages(messages: ContextMessage[]): ContextMessage[] {
  return messages.filter(
    (message) => typeof message.content === "string" && message.content.includes(CHECKPOINT_SUMMARY_MARKER),
  );
}

/**
 * Messages that survived verbatim. A summary MENTIONS the turns it replaced, so
 * "did this turn survive" must be asked of the non-summary messages only.
 */
function keptMessages(messages: ContextMessage[]): ContextMessage[] {
  return messages.filter(
    (message) => !(typeof message.content === "string" && message.content.includes(CHECKPOINT_SUMMARY_MARKER)),
  );
}

describe("model-written checkpoint", () => {
  test("the summarizer's answer becomes the checkpoint summary", async () => {
    const messages: ContextMessage[] = [
      { role: "user", content: filler(4_000, "old task") },
      { role: "assistant", content: "doing it" },
      { role: "user", content: "recent instruction" },
      { role: "assistant", content: "recent answer" },
    ];

    const result = await compactMessagesAtomically(messages, {
      force: true,
      keepRecentTokens: 500,
      summarizeWithModel: async () => "## Objective\nFix the API\n## Next Move\nRun the tests",
    });

    expect(result.compacted).toBe(true);
    expect(result.summarySource).toBe("model");
    const summaries = summaryMessages(result.messages);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].content).toContain("Fix the API");
    expect(summaries[0].content).toContain("## Next Move");
    // The recent tail is still there verbatim.
    expect(result.messages.some((message) => message.content === "recent instruction")).toBe(true);
  });

  test("a summarizer failure falls back instead of losing the compaction", async () => {
    const messages: ContextMessage[] = [
      { role: "user", content: filler(4_000, "old task") },
      { role: "assistant", content: "doing it" },
      { role: "user", content: "recent instruction" },
      { role: "assistant", content: "recent answer" },
    ];

    const result = await compactMessagesAtomically(messages, {
      force: true,
      keepRecentTokens: 500,
      summarizeWithModel: async () => {
        throw new Error("provider unavailable");
      },
    });

    expect(result.compacted).toBe(true);
    expect(result.summarySource).toBe("deterministic");
    expect(summaryMessages(result.messages)).toHaveLength(1);
  });

  test("the prompt carries the head and the previous checkpoint, once each", async () => {
    const prior = `${CHECKPOINT_SUMMARY_MARKER}\n## Objective\nShip the parser`;
    const prompts: string[] = [];
    const messages: ContextMessage[] = [
      { role: "user", content: prior },
      { role: "user", content: filler(4_000, "older work") },
      { role: "assistant", content: "older answer" },
      { role: "user", content: "recent instruction" },
      { role: "assistant", content: "recent answer" },
    ];

    await compactMessagesAtomically(messages, {
      force: true,
      keepRecentTokens: 500,
      priorSummary: prior,
      summarizeWithModel: async ({ prompt }) => {
        prompts.push(prompt);
        return "## Objective\nShip the parser, still";
      },
    });

    expect(prompts).toHaveLength(1);
    const prompt = prompts[0];
    expect(prompt).toContain("<prior-summary>");
    expect(prompt).toContain("<conversation>");
    expect(prompt).toContain("older work");
    // Prior summary is chained, never repeated as conversation.
    expect(prompt.split("Ship the parser").length - 1).toBe(1);
  });

  test("a second compaction replaces the previous checkpoint (lossy, not additive)", async () => {
    const first = await compactMessagesAtomically(
      [
        { role: "user", content: filler(4_000, "phase one") },
        { role: "assistant", content: "phase one answer" },
        { role: "user", content: "recent one" },
        { role: "assistant", content: "recent one answer" },
      ],
      {
        force: true,
        keepRecentTokens: 500,
        summarizeWithModel: async () => "## Objective\nSTAGE-ONE-MARKER",
      },
    );
    expect(first.compacted).toBe(true);

    const second = await compactMessagesAtomically(
      [...first.messages, { role: "user", content: filler(4_000, "phase two") }, { role: "assistant", content: "phase two answer" }],
      {
        force: true,
        keepRecentTokens: 500,
        priorSummary: "## Objective\nSTAGE-ONE-MARKER",
        summarizeWithModel: async () => "## Objective\nSTAGE-TWO-MARKER",
      },
    );

    expect(second.compacted).toBe(true);
    expect(second.chainedFromPriorSummary).toBe(true);
    const summaries = summaryMessages(second.messages);
    expect(summaries).toHaveLength(1);
    expect(summaries[0].content).toContain("STAGE-TWO-MARKER");
    // Stage one survives only if the new summary carried it: that is the lossy
    // contract, and nothing re-derives it from raw history.
    expect(summaries[0].content).not.toContain("STAGE-ONE-MARKER");
  });
});

describe("recent retention is a token budget, not a turn count", () => {
  test("small turns are kept until the budget is reached", async () => {
    const messages: ContextMessage[] = [];
    // 40 small turns (~40 tokens each) — far more turns than the old default of
    // two, and well inside the default 8K budget.
    for (let i = 0; i < 40; i++) {
      messages.push({ role: "user", content: filler(10, `turn ${i}`) });
      messages.push({ role: "assistant", content: `answer ${i}` });
    }

    const result = await compactMessagesAtomically(messages, { force: true });
    expect(result.compacted).toBe(true);
    const kept = keptMessages(result.messages);
    // Oldest turns are summarized away…
    expect(kept.some((message) => message.content.includes("turn 0 "))).toBe(false);
    // …and the tail survives far beyond the previous two-turn default.
    expect(kept.filter((message) => message.content.includes("turn ")).length).toBeGreaterThan(2);
  });

  test("an explicit smaller budget keeps correspondingly less", async () => {
    const messages: ContextMessage[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "user", content: filler(200, `turn ${i}`) });
      messages.push({ role: "assistant", content: `answer ${i}` });
    }

    const result = await compactMessagesAtomically(messages, { force: true, keepRecentTokens: 400 });
    const kept = keptMessages(result.messages).filter((message) => message.content.includes("turn "));
    // One or two turns fit in 400 tokens; the default 8K budget is not applied.
    expect(kept.length).toBeLessThanOrEqual(3);
    expect(kept.length).toBeGreaterThanOrEqual(1);
  });

  test("the default budget is the documented 8K, and the newest turn always survives", async () => {
    expect(COMPACTION_KEEP_RECENT_TOKENS).toBe(8_000);

    const messages: ContextMessage[] = [
      { role: "user", content: filler(20_000, "huge old turn") },
      { role: "assistant", content: "old answer" },
      { role: "user", content: filler(20_000, "huge recent turn") },
      { role: "assistant", content: "recent answer" },
    ];

    const result = await compactMessagesAtomically(messages, { force: true });
    expect(result.compacted).toBe(true);
    const kept = keptMessages(result.messages);
    // A single recent turn larger than the budget is still kept whole: dropping
    // it would leave the model with no verbatim context at all.
    expect(kept.some((message) => message.content.includes("huge recent turn"))).toBe(true);
    expect(kept.some((message) => message.content.includes("huge old turn"))).toBe(false);
  });
});
