import { describe, it, expect } from "bun:test";
import { getAsyncMutationFactory } from "../harness/contractLoaders";

describe("Tier 2 Boundary & Corner Cases: Mutation Race Locks & Double-Submit", () => {
  it("B3.1: Rapid-fire 10 concurrent execute calls trigger exactly ONE execution and reject 9", async () => {
    const createMutation = await getAsyncMutationFactory();
    let executionCount = 0;

    const mutation = createMutation(async (val: number) => {
      executionCount++;
      await new Promise((r) => setTimeout(r, 40));
      return `result:${val}`;
    });

    const promises: Promise<any>[] = [];
    // Fire 10 simultaneous execute requests
    for (let i = 0; i < 10; i++) {
      promises.push(mutation.execute(i));
    }

    const settled = await Promise.allSettled(promises);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(9);
    expect(executionCount).toBe(1);
    expect(mutation.state).toBe("success");
  });

  it("B3.2: Rejection leaves error captured and permits immediate sequential retry after reset", async () => {
    const createMutation = await getAsyncMutationFactory();
    let shouldFail = true;

    const mutation = createMutation(async () => {
      if (shouldFail) throw new Error("Backend 503 Service Unavailable");
      return "OK";
    });

    // First attempt fails
    expect(mutation.execute(undefined)).rejects.toThrow("503");
    await new Promise((r) => setTimeout(r, 10));
    expect(mutation.state).toBe("error");

    // Retry after fixing condition
    shouldFail = false;
    mutation.reset();
    expect(mutation.state).toBe("idle");

    const res = await mutation.execute(undefined);
    expect(res).toBe("OK");
    expect(mutation.state).toBe("success");
  });

  it("B3.3: Two independent mutations executing in parallel do not collide or share state", async () => {
    const createMutation = await getAsyncMutationFactory();

    const m1 = createMutation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return "m1_done";
    });

    const m2 = createMutation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return "m2_done";
    });

    const p1 = m1.execute(undefined);
    const p2 = m2.execute(undefined);

    expect(m1.state).toBe("pending");
    expect(m2.state).toBe("pending");

    const r2 = await p2;
    expect(r2).toBe("m2_done");
    expect(m2.state).toBe("success");
    // m1 is still pending
    expect(m1.state).toBe("pending");

    const r1 = await p1;
    expect(r1).toBe("m1_done");
    expect(m1.state).toBe("success");
  });

  it("B3.4: Rapid reset during settled state immediately restores idle without throwing", async () => {
    const createMutation = await getAsyncMutationFactory();
    const mutation = createMutation(async (x: number) => x * 2);

    await mutation.execute(5);
    expect(mutation.state).toBe("success");

    mutation.reset();
    expect(mutation.state).toBe("idle");
    expect(mutation.error).toBeNull();
  });

  it("B3.5: Double-submit error carries explicit descriptive message", async () => {
    const createMutation = await getAsyncMutationFactory();
    const mutation = createMutation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return true;
    });

    const p1 = mutation.execute(undefined);
    let capturedErr: Error | null = null;
    try {
      await mutation.execute(undefined);
    } catch (err: any) {
      capturedErr = err;
    }

    expect(capturedErr).not.toBeNull();
    expect(capturedErr?.message.toLowerCase()).toContain("already pending");
    await p1;
  });
});
