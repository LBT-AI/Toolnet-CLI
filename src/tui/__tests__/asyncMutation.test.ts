import { describe, expect, it } from "bun:test";
import {
  createAsyncMutation,
  MutationAlreadyPendingError,
} from "../asyncMutation";
import type { AsyncMutation } from "../asyncMutation";

/**
 * White-box tests for the canonical TUI mutation state machine. The e2e
 * contract suite (tests/e2e) asserts the same semantics opaquely; these pin
 * the production module's error type and callback ordering directly.
 */
describe("asyncMutation", () => {
  it("transitions idle → pending → success and delivers the result", async () => {
    const transitions: string[] = [];
    const seen: string[] = [];
    const mutation = createAsyncMutation(async (input: string) => {
      transitions.push(mutation.state);
      return `echo:${input}`;
    }, {
      onSuccess: (result) => seen.push(result),
    });

    expect(mutation.state).toBe("idle");
    expect(mutation.error).toBeNull();

    const result = await mutation.execute("hi");
    expect(result).toBe("echo:hi");
    expect(mutation.state).toBe("success");
    expect(mutation.error).toBeNull();
    expect(transitions).toEqual(["pending"]);
    expect(seen).toEqual(["echo:hi"]);
  });

  it("transitions to error, captures the Error, and still notifies onSettled", async () => {
    let settled = 0;
    const failure = new Error("disk on fire");
    const mutation = createAsyncMutation(async () => {
      throw failure;
    }, {
      onError: (err) => expect(err).toBe(failure),
      onSettled: () => settled++,
    });

    await expect(mutation.execute(undefined as unknown as void)).rejects.toBe(failure);
    expect(mutation.state).toBe("error");
    expect(mutation.error).toBe(failure);
    expect(settled).toBe(1);
  });

  it("coerces thrown non-Error values into Error instances", async () => {
    const mutation = createAsyncMutation(async () => {
      throw "boom-string";
    });
    await expect(mutation.execute(null as never)).rejects.toBeInstanceOf(Error);
    expect(mutation.error?.message).toBe("boom-string");
  });

  it("rejects a duplicate execute while pending instead of re-dispatching", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutation = createAsyncMutation(async () => {
      calls++;
      await gate;
      return "done";
    });

    const first = mutation.execute(undefined as unknown as void);
    await Promise.resolve();
    await expect(mutation.execute(undefined as unknown as void)).rejects.toBeInstanceOf(
      MutationAlreadyPendingError,
    );
    expect(calls).toBe(1);

    release();
    await expect(first).resolves.toBe("done");
    expect(mutation.state).toBe("success");
    expect(calls).toBe(1);
  });

  it("allows a sequential retry after a failure without reset", async () => {
    let fail = true;
    const mutation: AsyncMutation<number, string> = createAsyncMutation(
      async (n: number) => {
        if (fail) throw new Error("first attempt fails");
        return `ok:${n}`;
      },
    );

    await expect(mutation.execute(1)).rejects.toThrow("first attempt fails");
    fail = false;
    await expect(mutation.execute(2)).resolves.toBe("ok:2");
    expect(mutation.state).toBe("success");
  });

  it("reset() returns the machine to a clean idle state", async () => {
    const mutation = createAsyncMutation(async () => {
      throw new Error("x");
    });
    await expect(mutation.execute(undefined as unknown as void)).rejects.toThrow();
    mutation.reset();
    expect(mutation.state).toBe("idle");
    expect(mutation.error).toBeNull();
  });
});
