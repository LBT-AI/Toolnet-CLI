import { describe, it, expect } from "bun:test";
import { getAsyncMutationFactory } from "../harness/contractLoaders";

describe("Tier 1 Feature Coverage: Async Mutation Lifecycle & Safety", () => {
  it("F8.1: Async mutation initializes in 'idle' state with error null", async () => {
    const createMutation = await getAsyncMutationFactory();
    const mutation = createMutation(async (input: string) => `echo:${input}`);
    expect(mutation.state).toBe("idle");
    expect(mutation.error).toBeNull();
  });

  it("F8.2: Async mutation transitions from 'idle' -> 'pending' -> 'success'", async () => {
    const createMutation = await getAsyncMutationFactory();
    let settled = false;
    let successResult = "";

    const mutation = createMutation(
      async (ms: number) => {
        await new Promise((r) => setTimeout(r, ms));
        return "completed";
      },
      {
        onSuccess: (res) => {
          successResult = res;
        },
        onSettled: () => {
          settled = true;
        },
      }
    );

    const promise = mutation.execute(30);
    expect(mutation.state).toBe("pending");

    const res = await promise;
    expect(res).toBe("completed");
    expect(mutation.state).toBe("success");
    expect(successResult).toBe("completed");
    expect(settled).toBe(true);
    expect(mutation.error).toBeNull();
  });

  it("F8.3: Async mutation transitions to 'error' state upon failure", async () => {
    const createMutation = await getAsyncMutationFactory();
    let capturedError: Error | null = null;
    let settled = false;

    const mutation = createMutation(
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        throw new Error("Network timeout");
      },
      {
        onError: (err) => {
          capturedError = err;
        },
        onSettled: () => {
          settled = true;
        },
      }
    );

    expect(mutation.execute(undefined)).rejects.toThrow("Network timeout");
    await new Promise((r) => setTimeout(r, 20));

    expect(mutation.state).toBe("error");
    expect(mutation.error?.message).toBe("Network timeout");
    expect(capturedError?.message).toBe("Network timeout");
    expect(settled).toBe(true);
  });

  it("F8.4: Double-submit prevention blocks concurrent execute calls while pending", async () => {
    const createMutation = await getAsyncMutationFactory();
    let callCount = 0;

    const mutation = createMutation(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 40));
      return "done";
    });

    const p1 = mutation.execute(undefined);
    // Rapid duplicate execute
    expect(mutation.execute(undefined)).rejects.toThrow(/already pending/i);
    await p1;

    expect(callCount).toBe(1);
    expect(mutation.state).toBe("success");
  });

  it("F8.5: Reset restores mutation to 'idle' state and clears any error", async () => {
    const createMutation = await getAsyncMutationFactory();
    const mutation = createMutation(async () => {
      throw new Error("Failed");
    });

    try {
      await mutation.execute(undefined);
    } catch {}

    expect(mutation.state).toBe("error");
    mutation.reset();
    expect(mutation.state).toBe("idle");
    expect(mutation.error).toBeNull();
  });

  it("F12.1: Context compact mutation blocks execution during active streaming", async () => {
    const createMutation = await getAsyncMutationFactory();
    let isStreaming = true;

    const compactMutation = createMutation(async () => {
      if (isStreaming) {
        throw new Error("Cannot compact context while agent turn is streaming");
      }
      return { compactedTokens: 1500, newLength: 10 };
    });

    // Attempt while streaming -> must reject
    expect(compactMutation.execute(undefined)).rejects.toThrow("Cannot compact context while agent turn is streaming");

    // Agent finishes stream
    isStreaming = false;
    compactMutation.reset();

    const result = await compactMutation.execute(undefined);
    expect(result.compactedTokens).toBe(1500);
    expect(compactMutation.state).toBe("success");
  });
});
