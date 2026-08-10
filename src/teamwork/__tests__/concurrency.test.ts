import { DynamicScheduler } from "../dynamicScheduler";
import { BackgroundTaskScheduler } from "../../lib/backgroundTasks";
import { TaskGraph } from "../types";
import { describe, it, expect, mock } from "bun:test";

describe("Concurrency & UX Tests", () => {
  it("should support dynamic scheduler tracking", () => {
    const graph: TaskGraph = {
      sessionId: "test-sess",
      mode: "STANDARD",
      createdAt: Date.now(),
      nodes: [
        { id: "node1", title: "Task 1", prompt: "Do something", status: "PENDING", role: "EXPLORER", dependencies: [] },
        { id: "node2", title: "Task 2", prompt: "Do something else", status: "PENDING", role: "reviewer", dependencies: ["node1"] }
      ]
    };
    
    const scheduler = new DynamicScheduler(graph, {
      maxConcurrencyOverride: 2
    });

    const state = scheduler.getState();
    expect(state.sessionId).toBe("test-sess");
    expect(state.status).toBe("INITIALIZING");
    expect(state.maxWorkers).toBeGreaterThan(0);
  });

  it("should manage background tasks correctly", async () => {
    const scheduler = new BackgroundTaskScheduler();
    
    const cb = mock(() => {});
    scheduler.onUpdate(cb);

    // Run a very fast task
    const id = scheduler.run("Test Task", "echo 'hello'");
    
    const active = scheduler.getActiveTasks();
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(id);
    expect(active[0].status).toBe("running");
    
    // Wait for the task to finish
    await new Promise(resolve => setTimeout(resolve, 100));

    const all = scheduler.getAllTasks();
    expect(all[0].status).toBe("completed");
    expect(all[0].output).toContain("hello");
    expect(cb).toHaveBeenCalled();
  });
});
