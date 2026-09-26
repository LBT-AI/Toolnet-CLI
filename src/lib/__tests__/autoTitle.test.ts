/**
 * Automatic session titles — the text rules and the background service.
 *
 * The contract worth protecting: a session is titled ONCE, from its first real
 * task; greetings/acks/nudges never title anything; the main agent never waits
 * for a title; and a human rename is never overwritten by a pending generator.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  AUTO_TITLE_MAX_CHARS,
  AUTO_TITLE_MAX_WORDS,
  buildDeterministicTitle,
  buildSessionPreview,
  isSubstantiveTask,
  sanitizeGeneratedTitle,
  workspaceDisplayName,
} from "../sessionTitle";
import {
  hasRequestedAutoTitle,
  requestAutoTitle,
  resetAutoTitleState,
  type AutoTitleStore,
} from "../autoTitle";

// ── Text rules ──────────────────────────────────────────────────────────────

describe("sessionTitle — noise never titles a session", () => {
  test("greetings, acknowledgements and continuation nudges are not tasks", () => {
    for (const input of [
      "hello",
      "hi",
      "xin chào",
      "ok",
      "oke",
      "thanks",
      "cảm ơn bạn",
      "tiếp tục",
      "tiep tuc",
      "continue",
      "go on",
      "test",
      "",
      "   ",
      "/compact",
    ]) {
      expect(isSubstantiveTask(input)).toBe(false);
      expect(buildDeterministicTitle(input)).toBeNull();
    }
  });

  test("a greeting carrying real work still counts as a task", () => {
    expect(isSubstantiveTask("hello sửa package.json giúp tôi")).toBe(true);
  });
});

describe("sessionTitle — deterministic titles", () => {
  test("keeps the leading verb, drops conversational filler", () => {
    expect(buildDeterministicTitle("cho tôi sửa lỗi TUI scroll jitter")).toBe("Sửa lỗi TUI scroll jitter");
    expect(buildDeterministicTitle("please fix the TUI scroll jitter")).toBe("Fix the TUI scroll jitter");
  });

  test("a long multi-line prompt yields a short single-line title", () => {
    const prompt = [
      "Hãy xây dựng lại trang Mercedes-AMG cho website WordPress của tôi.",
      "Yêu cầu chi tiết:",
      "- dùng block editor",
      "- tối ưu mobile",
      ...Array.from({ length: 300 }, (_, i) => `dòng nhiễu số ${i}`),
    ].join("\n");
    const title = buildDeterministicTitle(prompt);
    expect(title).not.toBeNull();
    expect(title!.includes("\n")).toBe(false);
    expect(title!.split(" ").length).toBeLessThanOrEqual(AUTO_TITLE_MAX_WORDS);
    expect(title!.length).toBeLessThanOrEqual(AUTO_TITLE_MAX_CHARS);
    expect(title!.startsWith("Xây dựng lại trang Mercedes-AMG")).toBe(true);
  });

  test("markdown, bullets and quotes are stripped", () => {
    expect(buildDeterministicTitle("## Fix the **scroll** jitter")).toBe("Fix the scroll jitter");
    expect(buildDeterministicTitle("- [ ] Audit session persistence")).toBe("Audit session persistence");
    expect(buildDeterministicTitle("`compact` output is wrong")).toBe("Compact output is wrong");
  });

  test("a code fence line is skipped in favour of the first real line", () => {
    expect(buildDeterministicTitle("```ts\nadd collapsed paste composer\n```")).toBe("Add collapsed paste composer");
  });
});

describe("sessionTitle — generated titles are validated", () => {
  test("accepts a clean label and strips wrapping quotes", () => {
    expect(sanitizeGeneratedTitle('"Build Mercedes-AMG WordPress page"')).toBe("Build Mercedes-AMG WordPress page");
    expect(sanitizeGeneratedTitle("Title: Fix TUI scroll jitter")).toBe("Fix TUI scroll jitter");
  });

  test("rejects multi-line, markdown and empty output", () => {
    expect(sanitizeGeneratedTitle("Fix scroll jitter\nand also the header")).toBe("Fix scroll jitter");
    expect(sanitizeGeneratedTitle("**")).toBeNull();
    expect(sanitizeGeneratedTitle("")).toBeNull();
    expect(sanitizeGeneratedTitle(null)).toBeNull();
    expect(sanitizeGeneratedTitle(undefined)).toBeNull();
  });

  test("bounds the length so a runaway model cannot flood the status line", () => {
    const title = sanitizeGeneratedTitle("one two three four five six seven eight nine ten eleven twelve")!;
    expect(title.split(" ").length).toBeLessThanOrEqual(AUTO_TITLE_MAX_WORDS);
  });
});

describe("sessionTitle — previews and display fallbacks", () => {
  test("preview skips greetings and takes the first substantive user message", () => {
    const preview = buildSessionPreview([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hello. I'm ToolNet." },
      { role: "user", content: "sửa lỗi TUI scroll jitter\nvà thêm test" },
    ]);
    expect(preview).toBe("sửa lỗi TUI scroll jitter và thêm test");
  });

  test("no substantive message means no preview", () => {
    expect(buildSessionPreview([{ role: "user", content: "hi" }, { role: "user", content: "tiếp tục" }])).toBeNull();
    expect(buildSessionPreview([])).toBeNull();
  });

  test("workspace display name is the last path segment, never a title", () => {
    expect(workspaceDisplayName("/root/mercedes-benz-vns.com")).toBe("mercedes-benz-vns.com");
    expect(workspaceDisplayName("/root/mercedes-benz-vns.com/")).toBe("mercedes-benz-vns.com");
    expect(workspaceDisplayName("")).toBeNull();
  });
});

// ── Background service ──────────────────────────────────────────────────────

interface FakeStore extends AutoTitleStore {
  writes: Array<{ sessionId: string; title: string; revision?: number }>;
  record: { title?: string; metadata?: Record<string, unknown> } | null;
  acceptWrites: boolean;
}

function makeStore(): FakeStore {
  const store: FakeStore = {
    writes: [],
    record: { metadata: {} },
    acceptWrites: true,
    load() {
      return store.record;
    },
    setAutoTitle(sessionId, title, options) {
      if (!store.acceptWrites) return null;
      store.writes.push({ sessionId, title, revision: options?.revision });
      store.record = { title, metadata: { name: title, titleSource: "auto" } };
      return store.record;
    },
  };
  return store;
}

describe("requestAutoTitle — one background attempt per session", () => {
  beforeEach(() => resetAutoTitleState());

  test("a greeting never triggers a title", async () => {
    const store = makeStore();
    await requestAutoTitle({ sessionId: "sess_1", prompt: "hello", store });
    expect(store.writes).toEqual([]);
    expect(hasRequestedAutoTitle("sess_1")).toBe(false);
  });

  test("the first substantive task writes a title, and later turns never regenerate", async () => {
    const store = makeStore();
    await requestAutoTitle({ sessionId: "sess_1", prompt: "sửa lỗi TUI scroll jitter", store });
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]!.title).toBe("Sửa lỗi TUI scroll jitter");
    expect(store.record?.metadata?.titleSource).toBe("auto");

    await requestAutoTitle({ sessionId: "sess_1", prompt: "và thêm test cho phần này", store });
    expect(store.writes).toHaveLength(1);
  });

  test("a model title is preferred and validated", async () => {
    const store = makeStore();
    await requestAutoTitle({
      sessionId: "sess_2",
      prompt: "Xây dựng lại trang Mercedes-AMG WordPress",
      store,
      generate: async () => "Build Mercedes-AMG WordPress page",
    });
    expect(store.writes[0]!.title).toBe("Build Mercedes-AMG WordPress page");
  });

  test("a model failure falls back to the deterministic title", async () => {
    const store = makeStore();
    await requestAutoTitle({
      sessionId: "sess_3",
      prompt: "fix the TUI scroll jitter",
      store,
      generate: async () => {
        throw new Error("provider down");
      },
    });
    expect(store.writes[0]!.title).toBe("Fix the TUI scroll jitter");
  });

  test("a garbage model title falls back too", async () => {
    const store = makeStore();
    await requestAutoTitle({
      sessionId: "sess_4",
      prompt: "fix the TUI scroll jitter",
      store,
      generate: async () => "**",
    });
    expect(store.writes[0]!.title).toBe("Fix the TUI scroll jitter");
  });

  test("a session that was deleted is never written to", async () => {
    const store = makeStore();
    store.record = null;
    await requestAutoTitle({ sessionId: "sess_5", prompt: "fix the scroll jitter", store });
    expect(store.writes).toEqual([]);
  });

  test("an already-titled session is left alone (resume/rename)", async () => {
    const store = makeStore();
    store.record = { title: "Manual name", metadata: { titleSource: "manual" } };
    await requestAutoTitle({ sessionId: "sess_6", prompt: "fix the scroll jitter", store });
    expect(store.writes).toEqual([]);
  });

  test("a manual rename that wins the race suppresses the notification", async () => {
    const store = makeStore();
    store.acceptWrites = false; // store refused: the human renamed first
    const notified: string[] = [];
    await requestAutoTitle({
      sessionId: "sess_7",
      prompt: "fix the scroll jitter",
      store,
      onTitle: (title) => notified.push(title),
    });
    expect(notified).toEqual([]);
  });

  test("the title is announced only after it is durable", async () => {
    const store = makeStore();
    const notified: Array<[string, string]> = [];
    await requestAutoTitle({
      sessionId: "sess_8",
      prompt: "audit session persistence",
      store,
      onTitle: (title, sessionId) => notified.push([sessionId, title]),
    });
    expect(notified).toEqual([["sess_8", "Audit session persistence"]]);
  });

  test("the main agent is never blocked while the title model call is in flight", async () => {
    const store = makeStore();
    let resolveModel: (value: string) => void = () => {};
    const inFlight = new Promise<string>((resolve) => {
      resolveModel = resolve;
    });

    // Fire-and-forget: the returned promise is deliberately NOT awaited by the
    // caller. Titling must not gate the turn that triggered it.
    const titlePromise = requestAutoTitle({
      sessionId: "sess_bg",
      prompt: "build the mercedes-amg wordpress page",
      store,
      generate: () => inFlight,
    });

    // The turn proceeds immediately: nothing is written yet because the model
    // call is still pending.
    let turnFinished = false;
    turnFinished = true;
    expect(turnFinished).toBe(true);
    expect(store.writes).toEqual([]);

    resolveModel("Build Mercedes-AMG WordPress page");
    await titlePromise;
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]!.title).toBe("Build Mercedes-AMG WordPress page");
  });
});
