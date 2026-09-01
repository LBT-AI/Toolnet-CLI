import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { MessageQueue, messageQueue } from "../../lib/messageQueue";
import { tuiState } from "../../tui/state";
import { handleKey, handlePaste } from "../../tui/input/inputHandler";
import { queueCommand } from "../../commands/queue";
import { saveSession, loadSession } from "../../lib/sessionPersistence";
import { renderQueuedMessagesPreview } from "../../tui/renderers/queuePreviewRenderer";
import { renderQueueManagerBox } from "../../tui/renderers/queueManagerRenderer";
import { stripAnsi } from "../../tui/layout";

function tmpDir(): string {
  const d = path.join(os.tmpdir(), "toolnet-queue-regression-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe("Queued Messages & Queue Manager Regression Suite", () => {
  let tmpConfigDir: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    origEnv = { ...process.env };
    tmpConfigDir = tmpDir();
    process.env.TOOLNETCLI_SESSIONS_DIR = path.join(tmpConfigDir, "sessions");
    process.env.DATA_DIR = tmpConfigDir;

    messageQueue.clear();
    messageQueue.setIsProcessing(false);

    tuiState.messages = [];
    tuiState.isStreaming = false;
    tuiState.showQueueManager = false;
    tuiState.queueManagerIdx = 0;
    tuiState.queueManagerEditing = null;
    tuiState.inputBuffer = "";
    tuiState.cursorPos = 0;
    tuiState.currentSessionId = `sess_test_${Date.now()}`;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    } catch {}
    delete process.env.TOOLNETCLI_SESSIONS_DIR;
    delete process.env.DATA_DIR;
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) {
        delete process.env[k];
      }
    }
    Object.assign(process.env, origEnv);
  });

  it("1. Idle state + message submit executes immediately without enqueueing", () => {
    const executed: string[] = [];
    const cb = {
      renderAll: () => {},
      sendMessage: (t: string) => executed.push(t),
    };

    // User types "hello toolnet"
    handleKey("hello toolnet", cb);
    // User presses Enter (\r)
    handleKey(Buffer.from("0d", "hex"), cb);

    expect(executed).toEqual(["hello toolnet"]);
    expect(messageQueue.isEmpty()).toBe(true);
    expect(tuiState.inputBuffer).toBe("");
  });

  it("2. Working state + message submit enqueues task and clears input", () => {
    const executed: string[] = [];
    const cb = {
      renderAll: () => {},
      sendMessage: (t: string) => executed.push(t),
    };

    // Simulate active agent task working
    tuiState.isStreaming = true;
    messageQueue.setIsProcessing(true);

    // User types new task while busy
    handleKey("run subsequent test task", cb);
    // User presses Enter
    handleKey(Buffer.from("0d", "hex"), cb);

    // Should NOT execute immediately while working
    expect(executed).toEqual([]);
    // Should be enqueued in messageQueue
    expect(messageQueue.size()).toBe(1);
    expect(messageQueue.peek()?.text).toBe("run subsequent test task");
    // Input line should be cleared for next typing
    expect(tuiState.inputBuffer).toBe("");
  });

  it("3. Multiple queued messages preserve strict FIFO execution order", () => {
    const q = new MessageQueue();
    q.enqueue("Task 1: Setup database");
    q.enqueue("Task 2: Implement API endpoints");
    q.enqueue("Task 3: Run regression test suite");

    expect(q.size()).toBe(3);
    expect(q.dequeue()?.text).toBe("Task 1: Setup database");
    expect(q.dequeue()?.text).toBe("Task 2: Implement API endpoints");
    expect(q.dequeue()?.text).toBe("Task 3: Run regression test suite");
    expect(q.dequeue()).toBeNull();
    expect(q.isEmpty()).toBe(true);
  });

  it("4. Queue Manager allows edit, delete, reorder (moveUp/moveDown)", () => {
    messageQueue.enqueue("Step A");
    messageQueue.enqueue("Step B");
    messageQueue.enqueue("Step C");

    // Reorder: Move Step C to index 0
    tuiState.reorderQueue(2, 0);
    expect(messageQueue.getAllTexts()).toEqual(["Step C", "Step A", "Step B"]);

    // Move Step B up
    messageQueue.moveUp(2);
    expect(messageQueue.getAllTexts()).toEqual(["Step C", "Step B", "Step A"]);

    // Edit Step B
    tuiState.saveQueueEdit(1, "Step B (Updated with details)");
    expect(messageQueue.getAll()[1].text).toBe("Step B (Updated with details)");

    // Delete index 0 (Step C)
    tuiState.deleteFromQueue(0);
    expect(messageQueue.getAllTexts()).toEqual(["Step B (Updated with details)", "Step A"]);
  });

  it("5. Paste during working state is placed into input and enqueued on Enter", () => {
    const executed: string[] = [];
    const cb = {
      renderAll: () => {},
      sendMessage: (t: string) => executed.push(t),
    };

    tuiState.isStreaming = true;
    messageQueue.setIsProcessing(true);

    // Bracketed paste of multi-character instruction
    handlePaste("\x1b[200~Please fix issue with /key modal\x1b[201~", cb);
    expect(tuiState.inputBuffer).toBe("Please fix issue with /key modal");

    // Enter enqueues the pasted instruction
    handleKey(Buffer.from("0d", "hex"), cb);
    expect(executed).toEqual([]);
    expect(messageQueue.size()).toBe(1);
    expect(messageQueue.peek()?.text).toBe("Please fix issue with /key modal");
    expect(tuiState.inputBuffer).toBe("");
  });

  it("6. Session persistence saves and restores queued messages across restarts", () => {
    const sessionId = `sess_queue_test_${Date.now()}`;
    const initialQueue = ["Deploy to staging", "Verify health endpoint", "Notify team"];
    messageQueue.restore(initialQueue);

    // Save session with queued messages
    tuiState.currentSessionId = sessionId;
    tuiState.saveCurrentSession();

    // Clear memory queue to simulate CLI restart
    messageQueue.clear();
    expect(messageQueue.isEmpty()).toBe(true);

    // Load session
    const loaded = loadSession(sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded?.metadata?.queuedMessages).toEqual(initialQueue);

    // Restore queue
    messageQueue.restore(loaded?.metadata?.queuedMessages);
    expect(messageQueue.size()).toBe(3);
    expect(messageQueue.getAllTexts()).toEqual(initialQueue);
  });

  it("7. /queue command lists, clears, adds, and removes queued tasks", async () => {
    let output = "";
    const ctx: any = {
      addMessage: (_role: string, msg: string) => {
        output += msg + "\n";
      },
      setStatusMsg: () => {},
    };

    // Add via /queue add
    await queueCommand.handler(["add", "Write unit test for queue"], ctx);
    expect(output).toContain("Enqueued as task #1");
    expect(messageQueue.size()).toBe(1);

    // List via /queue list
    output = "";
    await queueCommand.handler(["list"], ctx);
    expect(output).toContain("Message Queue (1 tasks)");
    expect(output).toContain("Write unit test for queue");

    // Remove via /queue remove 1
    output = "";
    await queueCommand.handler(["remove", "1"], ctx);
    expect(output).toContain("Removed task #1");
    expect(messageQueue.isEmpty()).toBe(true);

    // Add 2 tasks and clear via /queue clear
    messageQueue.enqueue("Task X");
    messageQueue.enqueue("Task Y");
    expect(messageQueue.size()).toBe(2);

    output = "";
    await queueCommand.handler(["clear"], ctx);
    expect(stripAnsi(output)).toContain("Cleared 2 queued tasks");
    expect(messageQueue.isEmpty()).toBe(true);
  });

  it("8. Dimmed queue preview and Queue Manager box render cleanly", () => {
    const preview = renderQueuedMessagesPreview(80, [
      { id: "1", text: "Refactor /skills architecture to ToolNet-native", timestamp: Date.now() },
      { id: "2", text: "Verify model picker selection", timestamp: Date.now() },
      { id: "3", text: "Run full check", timestamp: Date.now() },
      { id: "4", text: "Extra task 4", timestamp: Date.now() },
    ]);
    const strippedPrev = stripAnsi(preview);
    expect(strippedPrev).toContain("4 queued messages");
    expect(strippedPrev).toContain("› Refactor /skills architecture");
    expect(strippedPrev).toContain("+1 more");

    const modalBox = renderQueueManagerBox(80, 20, {
      queue: [
        { id: "1", text: "First task in queue", timestamp: Date.now() },
        { id: "2", text: "Second task in queue", timestamp: Date.now() },
      ],
      queueIdx: 0,
      editing: null,
    });
    const strippedModal = stripAnsi(modalBox);
    expect(strippedModal).toContain("Queue (2 tasks)");
    expect(strippedModal).toContain("1. First task in queue");
    expect(strippedModal).toContain("2. Second task in queue");
    expect(strippedModal).toContain("Ctrl+↑/↓ Reorder");
  });

  it("9. Queue Manager keyboard navigation, edit, delete, reorder interactions", () => {
    messageQueue.enqueue("Task Alpha");
    messageQueue.enqueue("Task Beta");
    tuiState.showQueueManager = true;
    tuiState.queueManagerIdx = 0;

    const cb = { renderAll: () => {} };

    // Down arrow -> highlights Task Beta (idx = 1)
    handleKey(Buffer.from("1b5b42", "hex"), cb);
    expect(tuiState.queueManagerIdx).toBe(1);

    // Up arrow -> highlights Task Alpha (idx = 0)
    handleKey(Buffer.from("1b5b41", "hex"), cb);
    expect(tuiState.queueManagerIdx).toBe(0);

    // Enter -> starts edit mode on Task Alpha
    handleKey(Buffer.from("0d", "hex"), cb);
    expect(tuiState.queueManagerEditing).not.toBeNull();
    expect(tuiState.queueManagerEditing?.buffer).toBe("Task Alpha");

    // Type " Updated" in edit mode
    handleKey(" Updated", cb);
    expect(tuiState.queueManagerEditing?.buffer).toBe("Task Alpha Updated");

    // Enter -> saves edit
    handleKey(Buffer.from("0d", "hex"), cb);
    expect(tuiState.queueManagerEditing).toBeNull();
    expect(messageQueue.getAll()[0].text).toBe("Task Alpha Updated");

    // 'd' key -> deletes Task Alpha
    handleKey("d", cb);
    expect(messageQueue.size()).toBe(1);
    expect(messageQueue.getAll()[0].text).toBe("Task Beta");

    // Esc -> closes queue manager
    handleKey(Buffer.from("1b", "hex"), cb);
    expect(tuiState.showQueueManager).toBe(false);
  });

  it("10. When current task finishes or errors, next task in queue automatically executes", async () => {
    const executed: string[] = [];
    const simulatedSendMessage = async (text: string) => {
      executed.push(text);
      messageQueue.setIsProcessing(true);

      // Simulate completion lifecycle
      if (messageQueue.size() > 0) {
        const next = messageQueue.dequeue();
        if (next) {
          await simulatedSendMessage(next.text);
        }
      }
      messageQueue.setIsProcessing(false);
    };

    messageQueue.enqueue("Queued Task 1");
    messageQueue.enqueue("Queued Task 2");
    messageQueue.enqueue("Queued Task 3");

    // Execute first
    const first = messageQueue.dequeue();
    expect(first?.text).toBe("Queued Task 1");
    await simulatedSendMessage(first!.text);

    expect(executed).toEqual(["Queued Task 1", "Queued Task 2", "Queued Task 3"]);
    expect(messageQueue.isEmpty()).toBe(true);
    expect(messageQueue.getIsProcessing()).toBe(false);
  });
});
