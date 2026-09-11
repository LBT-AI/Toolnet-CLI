/**
 * Phase 76A — Background job unit tests.
 *
 * Covers the job lifecycle that must hold regardless of what any agent does:
 * bounded concurrency, dedupe, wait/timeout, cancellation with process-tree
 * abort, chained extensions, promotion, persistence with crash recovery, and
 * the notification inbox that replaces polling.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { BackgroundJobService } from "../../core/background/service";
import { SessionInbox, renderBackgroundNotification, sessionInbox } from "../../core/background/inbox";
import {
  loadPersistedJobs,
  recoverInterruptedJobs,
  savePersistedJobs,
} from "../../core/background/persistence";
import type { BackgroundJob } from "../../core/background/types";

const persistPath = path.join("/tmp", `toolnet-bg-jobs-${process.pid}.json`);

function makeService(overrides: Partial<ConstructorParameters<typeof BackgroundJobService>[0]> = {}) {
  return new BackgroundJobService({
    persistPath: null,
    recoverOnInit: false,
    maxConcurrency: 4,
    ...overrides,
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("BackgroundJobService — lifecycle", () => {
  test("tracks a job from start through completion", async () => {
    const jobs = makeService();
    const created = jobs.start({ type: "subagent", title: "Simple", run: async () => "done" });

    expect(created.status).toBe("running");
    expect(created.title).toBe("Simple");

    const waited = await jobs.wait(created.id, 1000);
    expect(waited?.timedOut).toBe(false);
    expect(waited?.job.status).toBe("completed");
    expect(waited?.job.result).toBe("done");
    expect(waited?.job.completedAt).toBeDefined();
  });

  test("classifies provider and timeout failures distinctly", async () => {
    const jobs = makeService();

    const network = jobs.start({
      type: "tool",
      run: async () => {
        throw new Error("Gateway network error: ECONNREFUSED");
      },
    });
    const networkResult = await jobs.wait(network.id, 1000);
    expect(networkResult?.job.status).toBe("error");
    expect(networkResult?.job.error).toContain("ECONNREFUSED");
    // Classified as a provider problem, not a generic runtime failure.
    expect(networkResult?.job.errorKind).toBe("provider");

    const timedOut = jobs.start({
      type: "tool",
      run: async () => {
        throw new Error("Node timed out after 100ms");
      },
    });
    expect((await jobs.wait(timedOut.id, 1000))?.job.errorKind).toBe("timeout");
  });

  test("classifies a permission denial so retry policy can skip it", async () => {
    const jobs = makeService();
    const created = jobs.start({
      type: "subagent",
      run: async () => {
        throw new Error("Permission Denied: tool 'write_file' is not permitted");
      },
    });
    const waited = await jobs.wait(created.id, 1000);
    expect(waited?.job.errorKind).toBe("permission");
  });

  test("emits queued → started → completed in order", async () => {
    const jobs = makeService();
    const seen: string[] = [];
    jobs.subscribe((event) => seen.push(event.type));

    const created = jobs.start({ type: "tool", run: async () => 1 });
    await jobs.wait(created.id, 1000);

    expect(seen).toEqual([
      "background-job-queued",
      "background-job-started",
      "background-job-completed",
    ]);
  });

  test("emits a cancellation event", async () => {
    const jobs = makeService();
    const seen: string[] = [];
    jobs.subscribe((event) => seen.push(event.type));

    const created = jobs.start({
      type: "tool",
      run: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    await tick();

    jobs.cancel(created.id);
    await jobs.wait(created.id, 500);

    expect(seen).toContain("background-job-cancelled");
    expect(jobs.get(created.id)?.status).toBe("cancelled");
  });

  test("wait() times out and reports the live snapshot", async () => {
    const jobs = makeService();
    const created = jobs.start({ type: "tool", run: () => new Promise(() => {}) });
    await tick();

    const waited = await jobs.wait(created.id, 50);
    expect(waited?.timedOut).toBe(true);
    expect(waited?.job.status).toBe("running");

    jobs.cancel(created.id);
  });

  test("wait() on an unknown id returns undefined", async () => {
    const jobs = makeService();
    expect(await jobs.wait("nope", 10)).toBeUndefined();
  });

  test("snapshots are immutable copies", () => {
    const jobs = makeService();
    const created = jobs.start({
      type: "tool",
      metadata: { value: "initial" },
      run: () => new Promise(() => {}),
    });

    created.metadata!.value = "changed";
    expect(jobs.get(created.id)?.metadata?.value).toBe("initial");

    jobs.cancel(created.id);
  });
});

describe("BackgroundJobService — bounded concurrency", () => {
  test("runs at most maxConcurrency jobs and queues the rest", async () => {
    const jobs = makeService({ maxConcurrency: 2 });
    const releases: Array<() => void> = [];
    const blocker = () => new Promise<void>((resolve) => releases.push(resolve));

    const a = jobs.start({ type: "tool", run: blocker });
    const b = jobs.start({ type: "tool", run: blocker });
    const c = jobs.start({ type: "tool", run: blocker });
    await tick();

    expect(jobs.get(a.id)!.status).toBe("running");
    expect(jobs.get(b.id)!.status).toBe("running");
    // Excess work waits, and it is OBSERVABLE as queued — never silently running.
    expect(jobs.get(c.id)!.status).toBe("queued");
    expect(jobs.stats()).toEqual({ jobs: 3, queued: 1, running: 2, maxConcurrency: 2 });

    releases.forEach((release) => release());
    await tick();
    releases.forEach((release) => release());

    await Promise.all([jobs.wait(a.id), jobs.wait(b.id), jobs.wait(c.id)]);
    expect([a, b, c].map((job) => jobs.get(job.id)!.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
  });

  test("a queued job can be cancelled before it ever runs", async () => {
    const jobs = makeService({ maxConcurrency: 1 });
    const releases: Array<() => void> = [];
    const blocker = () => new Promise<void>((resolve) => releases.push(resolve));

    const running = jobs.start({ type: "tool", run: blocker });
    const queued = jobs.start({ type: "tool", run: blocker });
    await tick();
    expect(jobs.get(queued.id)!.status).toBe("queued");

    jobs.cancel(queued.id);
    expect(jobs.get(queued.id)!.status).toBe("cancelled");

    releases.forEach((release) => release());
    await jobs.wait(running.id);
  });
});

describe("BackgroundJobService — dedupe, extend, promote", () => {
  test("starting a job whose id is already live joins it instead of forking", async () => {
    const jobs = makeService();
    const releases: Array<() => void> = [];
    const first = jobs.start({
      id: "shared",
      type: "subagent",
      title: "First",
      run: () => new Promise<void>((resolve) => releases.push(resolve)),
    });
    const second = jobs.start({ id: "shared", type: "subagent", title: "Second", run: async () => "x" });

    expect(second.id).toBe(first.id);
    expect(jobs.list({ type: "subagent" }).length).toBe(1);

    releases.forEach((release) => release());
    await jobs.wait("shared");
  });

  test("extend chains more work onto a live job", async () => {
    const jobs = makeService();
    const order: string[] = [];
    const created = jobs.start({
      type: "tool",
      run: async () => {
        order.push("first");
        return "first";
      },
    });

    expect(jobs.extend(created.id, async () => {
      order.push("second");
      return "second";
    })).toBe(true);

    const waited = await jobs.wait(created.id, 1000);
    expect(order).toEqual(["first", "second"]);
    // The final result is the LAST run's output.
    expect(waited?.job.result).toBe("second");
  });

  test("extend is refused once the job has settled", async () => {
    const jobs = makeService();
    const created = jobs.start({ type: "tool", run: async () => "done" });
    await jobs.wait(created.id, 1000);

    expect(jobs.extend(created.id, async () => "late")).toBe(false);
    expect(jobs.get(created.id)!.result).toBe("done");
  });

  test("promote hands a running job to the background without interrupting it", async () => {
    const jobs = makeService();
    const created = jobs.start({
      type: "subagent",
      metadata: { parentSessionId: "parent" },
      run: () => new Promise((resolve) => setTimeout(() => resolve("late"), 50)),
    });

    const pending = jobs.wait(created.id, 5000);
    await tick();
    const promoted = jobs.promote(created.id);

    expect(promoted?.status).toBe("running");
    expect(promoted?.metadata?.background).toBe(true);

    const waited = await pending;
    // The foreground waiter returns immediately instead of blocking the turn…
    expect(waited?.promoted).toBe(true);
    // …while the job keeps running to completion.
    expect(jobs.get(created.id)!.status).toBe("running");
    expect(await jobs.wait(created.id, 2000).then((w) => w?.job.status)).toBe("completed");
  });

  test("cancelBySession cancels only that session's live jobs", async () => {
    const jobs = makeService();
    const blocker = () => new Promise(() => {});
    const mine = jobs.start({ type: "tool", parentSessionId: "s1", run: blocker });
    const other = jobs.start({ type: "tool", parentSessionId: "s2", run: blocker });
    await tick();

    const cancelled = jobs.cancelBySession("s1");
    expect(cancelled).toEqual([mine.id]);
    expect(jobs.get(mine.id)!.status).toBe("cancelled");
    expect(jobs.get(other.id)!.status).toBe("running");

    jobs.cancel(other.id);
  });
});

describe("BackgroundJobService — persistence & recovery", () => {
  beforeEach(() => {
    try {
      fs.rmSync(persistPath, { force: true });
    } catch {}
  });

  afterEach(() => {
    try {
      fs.rmSync(persistPath, { force: true });
    } catch {}
  });

  test("persists jobs and reloads them", async () => {
    const writer = new BackgroundJobService({ persistPath, recoverOnInit: false });
    const created = writer.start({ type: "subagent", title: "Persisted", run: async () => "ok" });
    await writer.wait(created.id, 1000);

    const { jobs } = loadPersistedJobs(persistPath);
    expect(jobs.length).toBe(1);
    expect(jobs[0].id).toBe(created.id);
    expect(jobs[0].status).toBe("completed");
  });

  test("a restarted process never reports a stale running job", () => {
    const stale: BackgroundJob[] = [
      {
        id: "job_running",
        type: "subagent",
        title: "Interrupted",
        status: "running",
        parentSessionId: "s1",
        createdAt: 1,
      },
      {
        id: "job_done",
        type: "subagent",
        title: "Finished",
        status: "completed",
        parentSessionId: "s1",
        createdAt: 2,
        completedAt: 3,
      },
    ];

    const recovered = recoverInterruptedJobs(stale, 999);
    expect(recovered[0].status).toBe("error");
    expect(recovered[0].errorKind).toBe("runtime");
    expect(recovered[0].error).toMatch(/interrupted/i);
    expect(recovered[0].metadata?.interrupted).toBe(true);
    // Terminal jobs are untouched.
    expect(recovered[1].status).toBe("completed");
  });

  test("recovery runs automatically on init", () => {
    savePersistedJobs(
      [
        {
          id: "job_queued",
          type: "tool",
          title: "Queued then crashed",
          status: "queued",
          parentSessionId: "s1",
          createdAt: 1,
        },
      ],
      persistPath
    );

    const service = new BackgroundJobService({ persistPath });
    const loaded = service.get("job_queued");
    expect(loaded?.status).toBe("error");
    expect(loaded?.metadata?.interrupted).toBe(true);
  });

  test("a corrupt file degrades to empty instead of throwing", () => {
    fs.writeFileSync(persistPath, "{ not json", "utf8");
    expect(loadPersistedJobs(persistPath)).toEqual({ jobs: [], recovered: 0 });
  });

  test("shutdown is bounded even if a run ignores its abort signal", async () => {
    const jobs = makeService();
    jobs.start({ type: "tool", run: () => new Promise(() => {}) });
    await tick();

    const startedAt = Date.now();
    await jobs.shutdown(100);
    expect(Date.now() - startedAt).toBeLessThan(2000);
  });
});

describe("SessionInbox — notification instead of polling", () => {
  test("push/drain returns messages once, per session", () => {
    const inbox = new SessionInbox();
    inbox.push("s1", "first");
    inbox.push("s1", "second");
    inbox.push("s2", "other");

    expect(inbox.count("s1")).toBe(2);
    const drained = inbox.drain("s1");
    expect(drained.map((m) => m.content)).toEqual(["first", "second"]);
    // Draining is idempotent: a parent never sees the same result twice.
    expect(inbox.drain("s1")).toEqual([]);
    expect(inbox.count("s2")).toBe(1);
  });

  test("rejects empty input rather than injecting blank turns", () => {
    const inbox = new SessionInbox();
    expect(inbox.push("s1", "   ")).toBeUndefined();
    expect(inbox.push("", "content")).toBeUndefined();
    expect(inbox.count()).toBe(0);
  });

  test("a notification is marked synthetic and carries the job id", () => {
    const inbox = new SessionInbox();
    const message = inbox.push("s1", "body", { jobId: "job_1" });
    expect(message?.synthetic).toBe(true);
    expect(message?.jobId).toBe("job_1");
  });

  test("renders a completion notification with the child output", () => {
    const text = renderBackgroundNotification({
      jobId: "sub:s1:explore:1",
      title: "Inspect auth",
      status: "completed",
      summary: "Found the webhook secret",
      output: "src/auth.ts:42 leaks the secret",
    });

    expect(text).toContain('<task id="sub:s1:explore:1" state="completed">');
    expect(text).toContain("<summary>Inspect auth</summary>");
    expect(text).toContain("src/auth.ts:42 leaks the secret");
    // The model is explicitly told not to poll or duplicate the work.
    expect(text).toMatch(/do not poll/i);
  });

  test("the process-wide inbox is isolated per session and clearable", () => {
    sessionInbox.clear();
    sessionInbox.push("alpha", "x");
    sessionInbox.push("beta", "y");
    expect(sessionInbox.count()).toBe(2);
    sessionInbox.clear("alpha");
    expect(sessionInbox.count()).toBe(1);
    sessionInbox.clear();
    expect(sessionInbox.count()).toBe(0);
  });
});
