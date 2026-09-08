import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { tuiState } from "../../tui/state";
import { handleKey, resetInputState } from "../../tui/input/inputHandler";
import { requestApprovalModal } from "../../tui/permissions/permissionModal";
import { renderConfirmationModal, APPROVAL_OPTIONS } from "../../tui/renderers/modalRenderer";
import { SessionTrustManager } from "../../lib/security/sessionTrust";
import { isAlwaysTrusted, clearAlwaysTrustForTests } from "../../lib/security/persistentTrust";
import { stripAnsi } from "../../tui/layout";

function tmpDir(): string {
  const d = path.join(os.tmpdir(), "toolnet-approval-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Max visible width of any cursor-positioned row in a box-drawing output. */
function maxRowWidth(box: string | string[]): number {
  const joined = typeof box === "string" ? box : box.join("\n");
  let max = 0;
  for (const seg of joined.split(/\x1b\[\d+;\d+H/)) {
    const clean = stripAnsi(seg).replace(/[ \t]+$/g, "");
    max = Math.max(max, clean.length);
  }
  return max;
}

const DOWN = Buffer.from("1b5b42", "hex");
const UP = Buffer.from("1b5b41", "hex");
const ENTER = Buffer.from("0d", "hex");
const ESC = Buffer.from("1b", "hex");
const cb = { renderAll: () => {} };

describe("Security Approval Modal Regression Suite", () => {
  let tmpConfigDir: string;
  let origEnv: Record<string, string | undefined>;

  beforeEach(() => {
    origEnv = { ...process.env };
    tmpConfigDir = tmpDir();
    process.env.TOOLNETCLI_CONFIG_DIR = tmpConfigDir;
    process.env.DATA_DIR = tmpConfigDir;
    clearAlwaysTrustForTests();
    new SessionTrustManager().clearAll();
    resetInputState();
    tuiState.pendingConfirmation = null;
    tuiState.overlay = { type: "none" };
    tuiState.messages = [];
    tuiState.isStreaming = false;
    tuiState.currentSessionId = `sess_approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    tuiState.appState = "ready";
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    } catch {}
    delete process.env.TOOLNETCLI_CONFIG_DIR;
    delete process.env.DATA_DIR;
    for (const k of Object.keys(process.env)) {
      if (!(k in origEnv)) delete process.env[k];
    }
    Object.assign(process.env, origEnv);
  });

  async function openApproval(): Promise<boolean> {
    const p = requestApprovalModal({
      toolName: "read_file",
      args: { path: "/tmp/target.txt" },
      reason: "Allow read_file /tmp/target.txt?",
    });
    expect(tuiState.pendingConfirmation).not.toBeNull();
    return p;
  }

  it("1. Startup — approval modal opens as an overlay with all 4 options", async () => {
    const promise = openApproval();
    expect(tuiState.pendingConfirmation?.prompt).toBe("Allow read_file /tmp/target.txt?");
    expect(tuiState.pendingConfirmation?.selectedIndex).toBe(0);

    const box = renderConfirmationModal(80, 24, tuiState.pendingConfirmation!);
    const stripped = stripAnsi(box.join("\n"));
    expect(stripped).toContain("Security approval");
    expect(stripped).toContain("Allow once");
    expect(stripped).toContain("Allow for this session");
    expect(stripped).toContain("Always trust this folder");
    expect(stripped).toContain("Deny");
    // First option is highlighted.
    expect(stripped.indexOf("❯ Allow once")).toBeGreaterThanOrEqual(0);

    // Opening the modal must not change the base input/footer state.
    expect(tuiState.inputBuffer).toBe("");
    // Dismiss so the open promise settles.
    handleKey(ESC, cb);
    expect(await promise).toBe(false);
  });

  it("2. Close via Allow once (Enter on first option) — resolves true, nothing recorded", async () => {
    const promise = openApproval();
    handleKey(ENTER, cb);
    expect(await promise).toBe(true);
    expect(tuiState.pendingConfirmation).toBeNull();
    const tm = new SessionTrustManager();
    expect(tm.isTrustedForSession(tuiState.currentSessionId, "read_file", "/tmp/target.txt", "workspace")).toBe(false);
    expect(tm.isDeniedForSession(tuiState.currentSessionId, "read_file", "/tmp/target.txt")).toBe(false);
    expect(isAlwaysTrusted("read_file", "/tmp/target.txt")).toBe(false);
  });

  it("3. Close via Allow for this session — resolves true and records SESSION trust", async () => {
    const promise = openApproval();
    handleKey(DOWN, cb); // select option 1 = Allow for this session
    expect(tuiState.pendingConfirmation?.selectedIndex).toBe(1);
    handleKey(ENTER, cb);
    expect(await promise).toBe(true);
    expect(tuiState.pendingConfirmation).toBeNull();
    const tm = new SessionTrustManager();
    expect(tm.isTrustedForSession(tuiState.currentSessionId, "read_file", "/tmp/target.txt", "workspace")).toBe(true);
    // Not persistent.
    expect(isAlwaysTrusted("read_file", "/tmp/target.txt")).toBe(false);
  });

  it("4. Close via Always trust this folder — resolves true and persists the rule", async () => {
    const promise = openApproval();
    handleKey(DOWN, cb);
    handleKey(DOWN, cb); // select option 2 = Always trust this folder
    expect(tuiState.pendingConfirmation?.selectedIndex).toBe(2);
    handleKey(ENTER, cb);
    expect(await promise).toBe(true);
    expect(tuiState.pendingConfirmation).toBeNull();
    expect(isAlwaysTrusted("read_file", "/tmp/target.txt")).toBe(true);
    // Current session is covered too.
    const tm = new SessionTrustManager();
    expect(tm.isTrustedForSession(tuiState.currentSessionId, "read_file", "/tmp/target.txt", "workspace")).toBe(true);
  });

  it("5. Close via Deny — resolves false and records session denial", async () => {
    const promise = openApproval();
    handleKey(DOWN, cb);
    handleKey(DOWN, cb);
    handleKey(DOWN, cb); // select option 3 = Deny
    expect(tuiState.pendingConfirmation?.selectedIndex).toBe(3);
    handleKey(ENTER, cb);
    expect(await promise).toBe(false);
    expect(tuiState.pendingConfirmation).toBeNull();
    const tm = new SessionTrustManager();
    expect(tm.isDeniedForSession(tuiState.currentSessionId, "read_file", "/tmp/target.txt")).toBe(true);
    expect(isAlwaysTrusted("read_file", "/tmp/target.txt")).toBe(false);
  });

  it("6. Esc dismisses — resolves false WITHOUT recording anything", async () => {
    const promise = openApproval();
    handleKey(ESC, cb);
    expect(await promise).toBe(false);
    expect(tuiState.pendingConfirmation).toBeNull();
    const tm = new SessionTrustManager();
    expect(tm.isTrustedForSession(tuiState.currentSessionId, "read_file", "/tmp/target.txt", "workspace")).toBe(false);
    expect(tm.isDeniedForSession(tuiState.currentSessionId, "read_file", "/tmp/target.txt")).toBe(false);
    expect(isAlwaysTrusted("read_file", "/tmp/target.txt")).toBe(false);
  });

  it("7. Single-key shortcuts still work: y/a/t/n", async () => {
    const p1 = openApproval();
    handleKey("y", cb);
    expect(await p1).toBe(true);

    const p2 = openApproval();
    handleKey("a", cb);
    expect(await p2).toBe(true);
    expect(new SessionTrustManager().isTrustedForSession(tuiState.currentSessionId, "read_file", "/tmp/target.txt", "workspace")).toBe(true);

    const p3 = openApproval();
    handleKey("t", cb);
    expect(await p3).toBe(true);
    expect(isAlwaysTrusted("read_file", "/tmp/target.txt")).toBe(true);

    const p4 = openApproval();
    handleKey("n", cb);
    expect(await p4).toBe(false);
    expect(new SessionTrustManager().isDeniedForSession(tuiState.currentSessionId, "read_file", "/tmp/target.txt")).toBe(true);
  });

  it("8. Resize while open — modal re-centers and stays within bounds at any size", () => {
    const conf = { prompt: "Do you trust the folder /very/long/path/name/that/should/truncate/cleanly/inside/the/modal/box?", resolve: () => {} };
    for (const [cols, rows] of [[100, 30], [60, 25], [50, 20], [40, 16]]) {
      const box = renderConfirmationModal(cols, rows, conf);
      expect(maxRowWidth(box)).toBeLessThanOrEqual(cols);
      const stripped = stripAnsi(box.join("\n"));
      expect(stripped).toContain("Workspace access");
      expect(stripped).toContain("Allow once");
      expect(stripped).toContain("Deny");
    }
  });

  it("9. Mobile 50x20 — modal fits, all options visible, no wrap", () => {
    const box = renderConfirmationModal(50, 20, {
      prompt: "Do you trust the folder /root/toolnet-cli?",
      selectedIndex: 2,
      resolve: () => {},
    });
    const stripped = stripAnsi(box.join("\n"));
    for (const opt of APPROVAL_OPTIONS) {
      expect(stripped).toContain(opt.label);
    }
    expect(stripped).toContain("❯ Always trust this folder");
    expect(maxRowWidth(box)).toBeLessThanOrEqual(50);
  });

  it("10. Approval can open repeatedly — each cycle resolves independently", async () => {
    for (let round = 0; round < 3; round++) {
      const promise = openApproval();
      expect(tuiState.pendingConfirmation).not.toBeNull();
      // Navigate to 'a' (Allow for this session) and select.
      handleKey(DOWN, cb);
      handleKey(ENTER, cb);
      expect(await promise).toBe(true);
      expect(tuiState.pendingConfirmation).toBeNull();
    }
  });

  it("11. Up arrow wraps to the last option, Down wraps to the first", async () => {
    const promise = openApproval();
    handleKey(UP, cb); // wrap: index 0 -> 3 (Deny)
    expect(tuiState.pendingConfirmation?.selectedIndex).toBe(3);
    handleKey(DOWN, cb); // wrap: 3 -> 0 (Allow once)
    expect(tuiState.pendingConfirmation?.selectedIndex).toBe(0);
    handleKey(ESC, cb);
    await promise;
  });
});