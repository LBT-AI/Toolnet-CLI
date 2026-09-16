import { describe, it, expect, afterEach } from "bun:test";
import { getAsyncMutationFactory } from "../harness/contractLoaders";
import { createAsyncMutation } from "../../../src/tui/asyncMutation";
import { messageQueue } from "../../../src/lib/messageQueue";
import { mapToolToAction } from "../../../src/tui/statusService";
import { formatToolStart, formatToolEnd } from "../../../src/tui/toolActivity";

describe("Tier 3 Cross-Feature: Submit During Tool Run", () => {
  afterEach(() => {
    messageQueue.clear();
    messageQueue.setIsProcessing(false);
  });

  it("T3.1: prompt submitted while a tool mutation is in flight is queued, not dropped", async () => {
    const createMutation = await getAsyncMutationFactory();
    let executionCount = 0;

    const toolRun = createMutation(async () => {
      executionCount++;
      await new Promise((r) => setTimeout(r, 50));
      return "tool-output";
    });

    messageQueue.setIsProcessing(true);
    const inFlight = toolRun.execute(undefined);

    // User types and submits while the tool runs: every submit is preserved.
    expect(messageQueue.enqueue("follow-up 1")).not.toBeNull();
    expect(messageQueue.enqueue("follow-up 2")).not.toBeNull();
    expect(messageQueue.enqueue("follow-up 3")).not.toBeNull();

    const result = await inFlight;
    expect(result).toBe("tool-output");
    expect(executionCount).toBe(1);

    // Queued prompts drain in submission order after the tool settles.
    expect(messageQueue.dequeue()?.text).toBe("follow-up 1");
    expect(messageQueue.dequeue()?.text).toBe("follow-up 2");
    expect(messageQueue.dequeue()?.text).toBe("follow-up 3");
    expect(messageQueue.isEmpty()).toBe(true);
  });

  it("T3.2: double submit during tool run still queues the text but never re-executes the tool", async () => {
    const createMutation = await getAsyncMutationFactory();
    let executionCount = 0;

    const toolRun = createMutation(async () => {
      executionCount++;
      await new Promise((r) => setTimeout(r, 40));
      return "done";
    });

    const first = toolRun.execute(undefined);
    // Duplicate submit while pending is rejected…
    let duplicateRejected = false;
    try {
      await toolRun.execute(undefined);
    } catch {
      duplicateRejected = true;
    }
    expect(duplicateRejected).toBe(true);

    // …but the user's text is retained for the next turn.
    messageQueue.enqueue("retry this prompt");

    await first;
    expect(executionCount).toBe(1);
    expect(messageQueue.getAllTexts()).toEqual(["retry this prompt"]);
  });

  it("T3.3: queued prompts survive an in-flight tool failure and drain after a successful retry", async () => {
    const createMutation = await getAsyncMutationFactory();
    let shouldFail = true;

    const toolRun = createMutation(async () => {
      if (shouldFail) throw new Error("tool crashed");
      return "recovered";
    });

    messageQueue.enqueue("next step");
    messageQueue.setIsProcessing(true);

    const failing = toolRun.execute(undefined);
    await failing.catch(() => undefined);
    expect(toolRun.state).toBe("error");

    // Queue untouched by the failure.
    expect(messageQueue.getAllTexts()).toEqual(["next step"]);

    shouldFail = false;
    toolRun.reset();
    const recovered = await toolRun.execute(undefined);
    expect(recovered).toBe("recovered");
    expect(messageQueue.dequeue()?.text).toBe("next step");
  });

  it("T3.4: tool lifecycle classification stays meaningful for coding tools and unknown tools", () => {
    expect(mapToolToAction("read_file")).toBe("Reading file…");
    expect(mapToolToAction("write_file")).toBe("Writing file…");
    expect(mapToolToAction("")).toBe("Working…");

    // Unknown tools and missing args must never crash the lifecycle renderer.
    expect(() => formatToolStart("mystery_tool", undefined)).not.toThrow();
    expect(() => formatToolEnd("mystery_tool", undefined, true)).not.toThrow();
    expect(() => formatToolEnd("mystery_tool", undefined, false)).not.toThrow();
    expect(formatToolStart("mystery_tool", undefined).length).toBeGreaterThan(0);
    expect(formatToolEnd("mystery_tool", undefined, false).length).toBeGreaterThan(0);
  });
});
