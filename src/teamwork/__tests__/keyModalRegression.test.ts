import { test, it, expect, describe, beforeEach, afterEach } from "bun:test";
import { tuiState } from "../../tui/state";
import { handleKey, handlePaste, getInputState, setInputState, resetInputState } from "../../tui/input/inputHandler";
import { saveCliKey, deleteCliKey, getCliKey } from "../../lib/keys";
import { renderKeyManagerBox } from "../../tui/renderers/keyManagerRenderer";
import { stripAnsi } from "../../tui/layout";

describe("/key Modal Input & Paste Regression Tests", () => {
  beforeEach(() => {
    resetInputState();
    tuiState.showKeyManager = false;
    tuiState.keyManagerInput = null;
    tuiState.keyManagerConfirmDelete = null;
    tuiState.showModelPicker = false;
    tuiState.pendingConfirmation = null;
    tuiState.showHelp = false;
    tuiState.toastMsg = "";
    deleteCliKey("mockprovider");
    deleteCliKey("openai");
    deleteCliKey("anthropic");
  });

  afterEach(() => {
    deleteCliKey("mockprovider");
    deleteCliKey("openai");
    deleteCliKey("anthropic");
    tuiState.closeKeyManager();
    resetInputState();
  });

  it("1. Single key typing into Set Key modal", () => {
    tuiState.openKeyManager();
    expect(tuiState.showKeyManager).toBe(true);

    // Open input for first provider (Enter or 'a')
    handleKey(Buffer.from("0d", "hex"));
    expect(tuiState.keyManagerInput).not.toBeNull();
    const provider = tuiState.keyManagerInput!.provider;

    // Type 's', 'k', '-', '1', 'a'
    handleKey(Buffer.from("s"));
    handleKey(Buffer.from("k"));
    handleKey(Buffer.from("-"));
    handleKey(Buffer.from("1"));
    handleKey(Buffer.from("a"));

    expect(tuiState.keyManagerInput?.buffer).toBe("sk-1a");
    expect(tuiState.keyManagerInput?.cursor).toBe(5);

    // Verify command line input is completely empty (no leakage)
    expect(tuiState.inputBuffer).toBe("");
    expect(getInputState().buffer).toBe("");
  });

  it("2. Multi-character paste (SSH / iOS terminal raw text chunk)", () => {
    tuiState.openKeyManager();
    tuiState.keyManagerInput = { provider: "mockprovider", buffer: "", cursor: 0 };

    // Simulate multi-character chunk from terminal paste
    const secretKey = "sk-proj-test1234567890abcdef";
    handleKey(Buffer.from(secretKey));

    expect(tuiState.keyManagerInput?.buffer).toBe(secretKey);
    expect(tuiState.keyManagerInput?.cursor).toBe(secretKey.length);

    // Verify command line input is not leaked
    expect(tuiState.inputBuffer).toBe("");
    expect(getInputState().buffer).toBe("");
  });

  it("3. Bracketed paste (\\x1b[200~ ... \\x1b[201~)", () => {
    tuiState.openKeyManager();
    tuiState.keyManagerInput = { provider: "mockprovider", buffer: "", cursor: 0 };

    // Terminal bracketed paste sequence
    const rawBracketed = "\x1b[200~sk-ant-api03-bracketed-key-value\x1b[201~";
    handleKey(Buffer.from(rawBracketed));

    expect(tuiState.keyManagerInput?.buffer).toBe("sk-ant-api03-bracketed-key-value");
    expect(tuiState.keyManagerInput?.cursor).toBe("sk-ant-api03-bracketed-key-value".length);

    // Verify command line input has no leaked content
    expect(tuiState.inputBuffer).toBe("");
    expect(getInputState().buffer).toBe("");
  });

  it("4. Unicode typing & paste in Set Key modal", () => {
    tuiState.openKeyManager();
    tuiState.keyManagerInput = { provider: "mockprovider", buffer: "", cursor: 0 };

    const unicodeKey = "sk-khóa-bảo-mật-🔑-tiếng-việt-123";
    handleKey(Buffer.from(unicodeKey, "utf8"));

    expect(tuiState.keyManagerInput?.buffer).toBe(unicodeKey);
    expect(tuiState.keyManagerInput?.buffer).toContain("khóa-bảo-mật-🔑-tiếng-việt");
    expect(tuiState.inputBuffer).toBe("");
  });

  it("5. Paste when modal is active does NOT leak down to command line", () => {
    // A. Active KeyManagerInput modal
    tuiState.openKeyManager();
    tuiState.keyManagerInput = { provider: "mockprovider", buffer: "", cursor: 0 };

    handlePaste("pasted-secret-api-key-999");
    expect(tuiState.keyManagerInput?.buffer).toBe("pasted-secret-api-key-999");
    expect(tuiState.inputBuffer).toBe("");
    expect(getInputState().buffer).toBe("");

    // B. KeyManager list mode (no input open yet)
    tuiState.keyManagerInput = null;
    handlePaste("stray-paste-during-list-nav");
    expect(tuiState.inputBuffer).toBe("");
    expect(getInputState().buffer).toBe("");

    // C. Model Picker active
    tuiState.closeKeyManager();
    tuiState.showModelPicker = true;
    tuiState.availableModels = ["gpt-4o", "claude-3-5-sonnet"];
    tuiState.filteredModels = ["gpt-4o", "claude-3-5-sonnet"];
    tuiState.modelSearchQuery = "";

    handlePaste("claude");
    expect(tuiState.modelSearchQuery).toBe("claude");
    expect(tuiState.inputBuffer).toBe("");

    // D. No modal active -> paste goes to command line
    tuiState.showModelPicker = false;
    handlePaste("npm run build");
    expect(tuiState.inputBuffer).toBe("npm run build");
    expect(getInputState().buffer).toBe("npm run build");
  });

  it("6. Backspace, Delete, Left/Right Arrows, Home, End, Ctrl+U in Set Key modal", () => {
    tuiState.openKeyManager();
    tuiState.keyManagerInput = { provider: "mockprovider", buffer: "abcd", cursor: 4 };

    // Move Left (1b5b44) -> cursor 3
    handleKey(Buffer.from("1b5b44", "hex"));
    expect(tuiState.keyManagerInput?.cursor).toBe(3);

    // Backspace (7f) -> deletes 'c', buffer "abd", cursor 2
    handleKey(Buffer.from("7f", "hex"));
    expect(tuiState.keyManagerInput?.buffer).toBe("abd");
    expect(tuiState.keyManagerInput?.cursor).toBe(2);

    // Delete (1b5b337e) -> deletes 'd', buffer "ab", cursor 2
    handleKey(Buffer.from("1b5b337e", "hex"));
    expect(tuiState.keyManagerInput?.buffer).toBe("ab");
    expect(tuiState.keyManagerInput?.cursor).toBe(2);

    // Home (01 or 1b5b48) -> cursor 0
    handleKey(Buffer.from("01", "hex"));
    expect(tuiState.keyManagerInput?.cursor).toBe(0);

    // Insert 'Z' -> buffer "Zab", cursor 1
    handleKey(Buffer.from("Z"));
    expect(tuiState.keyManagerInput?.buffer).toBe("Zab");
    expect(tuiState.keyManagerInput?.cursor).toBe(1);

    // End (05 or 1b5b46) -> cursor 3
    handleKey(Buffer.from("05", "hex"));
    expect(tuiState.keyManagerInput?.cursor).toBe(3);

    // Ctrl+U (15) -> clear line
    handleKey(Buffer.from("15", "hex"));
    expect(tuiState.keyManagerInput?.buffer).toBe("");
    expect(tuiState.keyManagerInput?.cursor).toBe(0);
  });

  it("7. Enter = Save key and close input modal", () => {
    tuiState.openKeyManager();
    tuiState.keyManagerInput = { provider: "mockprovider", buffer: "sk-saved-valid-key-1234", cursor: 24 };

    // Press Enter (0d)
    handleKey(Buffer.from("0d", "hex"));

    // Modal input closed
    expect(tuiState.keyManagerInput).toBeNull();
    // Key saved to disk
    expect(getCliKey("mockprovider")).toBe("sk-saved-valid-key-1234");
    // Toast notification displayed
    expect(tuiState.toastMsg).toContain("Saved API key for mockprovider");
  });

  it("8. Esc = Cancel input without saving", () => {
    tuiState.openKeyManager();
    tuiState.keyManagerInput = { provider: "mockprovider", buffer: "sk-cancelled-key-9999", cursor: 23 };

    // Press Esc (1b)
    handleKey(Buffer.from("1b", "hex"));

    // Modal input closed
    expect(tuiState.keyManagerInput).toBeNull();
    // Key is NOT saved
    expect(getCliKey("mockprovider")).toBeNull();
  });

  it("9. Masked API key in UI rendering & never logs plaintext key", () => {
    const secretKey = "sk-super-secret-production-token-12345";
    const rendered = renderKeyManagerBox(80, 24, {
      keyManagerIdx: 0,
      keyManagerInput: { provider: "mockprovider", buffer: secretKey, cursor: secretKey.length },
    });

    const stripped = stripAnsi(rendered);

    // Box has title & hint
    expect(stripped).toContain("Set Key: mockprovider");
    expect(stripped).toContain("Enter API Key (input will be masked):");

    // Bullet characters are displayed
    expect(stripped).toContain("•••");
    expect(stripped).toContain("█");

    // Plaintext key MUST NEVER appear in rendered output
    expect(stripped).not.toContain(secretKey);
    expect(stripped).not.toContain("super-secret-production-token");
  });

  it("10. Long API keys (100+ chars) render cleanly with windowed masking", () => {
    const veryLongKey = "sk-ant-api03-" + "a".repeat(120);
    const rendered = renderKeyManagerBox(70, 24, {
      keyManagerIdx: 0,
      keyManagerInput: { provider: "anthropic", buffer: veryLongKey, cursor: 50 },
    });

    const stripped = stripAnsi(rendered);
    expect(stripped).toContain("Set Key: anthropic");
    expect(stripped).toContain("•••");
    expect(stripped).toContain("█");
    // Does not expose plaintext
    expect(stripped).not.toContain(veryLongKey);
    expect(stripped).not.toContain("aaaa");
  });
});
