/**
 * P7 — First-run / setup wizard regression tests (HOTFIX v1.2.2).
 *
 * Locks in the corrected startup UX:
 *  1. Fresh HOME opens provider setup directly (no fake/default config).
 *  2. "Configuration already exists. Re-run setup?" is gone.
 *  3. Connection Mode is gone.
 *  4. direct/skip prompt is gone.
 *  5. Empty/default config is NOT "configured".
 *  6. Partial config resumes at the correct setup step.
 *  7. Valid config goes straight to the main TUI.
 *  8. Cancel (Esc/Ctrl+C) leaves no half-config behind.
 *  9. Manual setup (/setup + `toolnet config init`) still works.
 * 10. Fresh-install clean-HOME smoke test.
 */

import { describe, it, expect, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p7-test-"));
}

function cleanDir(d: string) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {}
}

const KNOWN_KEY_ENV = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "TOOLNET_API_KEY",
  "TOOLNET_TOKEN",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
];

function resetState() {
  const { resetAppConfigCache } = require("../../lib/appConfig");
  const { resetProvidersConfigCache } = require("../../providers");
  resetAppConfigCache();
  resetProvidersConfigCache();
}

/** A scripted WizardIO for driving the wizard deterministically. */
class FakeIO {
  prints: string[] = [];
  calls: Array<{ kind: "select" | "hidden" | "text"; prompt: string; options?: string[] }> = [];
  private queue: Array<{ kind: "select" | "hidden" | "text"; value?: number | string; abort?: boolean; abortFrom?: "hidden" | "text" }>;

  constructor(queue: Array<{ kind: "select" | "hidden" | "text"; value?: number | string; abort?: boolean; abortFrom?: "hidden" | "text" }>) {
    this.queue = queue;
  }

  print = (t: string) => {
    this.prints.push(String(t));
  };

  async select(prompt: string, options: string[]) {
    const item = this.queue.find((q) => q.kind === "select");
    if (!item) throw new Error("No scripted select action — got options: " + options.join(","));
    this.calls.push({ kind: "select", prompt, options });
    this.queue.splice(this.queue.indexOf(item), 1);
    if (item.abort) return { value: "", index: 0, aborted: true };
    const val = typeof item.value === "number" ? options[item.value] : item.value ?? "";
    return { value: val, index: options.indexOf(val), aborted: false };
  }

  async hiddenInput(prompt: string) {
    this.calls.push({ kind: "hidden", prompt });
    const item = this.queue.find((q) => q.kind === "hidden");
    if (!item) throw new Error("No scripted hidden input — prompt: " + prompt);
    this.queue.splice(this.queue.indexOf(item), 1);
    if (item.abort) return { value: "", aborted: true };
    return { value: typeof item.value === "string" ? item.value : "", aborted: false };
  }

  async textInput(prompt: string, opts?: { default?: string }) {
    this.calls.push({ kind: "text", prompt });
    const item = this.queue.find((q) => q.kind === "text" || q.kind === "hidden");
    if (!item) {
      return { value: opts?.default ?? "", aborted: false };
    }
    this.queue.splice(this.queue.indexOf(item), 1);
    if (item.abort) return { value: "", aborted: true };
    return { value: typeof item.value === "string" ? item.value : opts?.default ?? "", aborted: false };
  }

  get allText(): string {
    return [...this.prints, ...this.calls.map((c) => c.prompt)].join("\n");
  }
}

const FAKE_MODELS = [
  { id: "test-model-a", object: "model", created: 0, owned_by: "test" },
  { id: "test-model-b", object: "model", created: 0, owned_by: "test" },
];

function writeConfigJson(dir: string, cfg: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2));
}

function writeProvidersJson(dir: string, cfg: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify(cfg, null, 2));
}

function writeCliKeys(dir: string, keys: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cli-keys.json"), JSON.stringify(keys, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Test context
// ---------------------------------------------------------------------------

let dir: string;
let origDir: string | undefined;
const envBackup = new Map<string, string | undefined>();

beforeEach(() => {
  origDir = process.env.TOOLNETCLI_CONFIG_DIR;
  dir = tmpDir();
  process.env.TOOLNETCLI_CONFIG_DIR = dir;
  envBackup.clear();
  for (const k of KNOWN_KEY_ENV) {
    envBackup.set(k, process.env[k]);
    delete process.env[k];
  }
  resetState();
});

afterEach(() => {
  cleanDir(dir);
  if (origDir !== undefined) process.env.TOOLNETCLI_CONFIG_DIR = origDir;
  else delete process.env.TOOLNETCLI_CONFIG_DIR;
  for (const [k, v] of envBackup) {
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  }
  resetState();
});

// ---------------------------------------------------------------------------
// 1. Fresh HOME opens provider setup directly
// ---------------------------------------------------------------------------

describe("P7 — Fresh HOME opens setup at the provider step", () => {
  it("fresh HOME is not 'configured' and misses the provider step", () => {
    const { analyzeSetupState } = require("../../lib/setupWizard") as any;
    const state = analyzeSetupState();
    expect(state.fresh).toBe(true);
    expect(state.usable).toBe(false);
    expect(state.missing).toEqual(["provider"]);
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "providers.json"))).toBe(false);
  });

  it("wizard flow starts with the provider selector, then key, then model", async () => {
    const { runSetupWizardFlow } = require("../../lib/setupWizard");
    const io = new FakeIO([
      { kind: "select", value: 0 },
      { kind: "hidden", value: "sk-fresh-home" },
      { kind: "select", value: 0 },
    ]);
    const res = await runSetupWizardFlow(io as any, { fetchModels: async () => FAKE_MODELS });
    expect(res.completed).toBe(true);
    expect(io.calls[0].kind).toBe("select");
    expect(io.calls[0].options).toEqual(["ToolNet", "OpenAI", "Anthropic", "Gemini", "Custom"]);
    expect(io.calls[1].kind).toBe("hidden");
    expect(io.calls[2].kind).toBe("select");
    expect(io.calls[2].prompt).toContain("Model:");
  });

  it("persists provider + key + model after a fresh setup", async () => {
    const { runSetupWizardFlow } = require("../../lib/setupWizard");
    const io = new FakeIO([
      { kind: "select", value: 1 }, // OpenAI
      { kind: "hidden", value: "sk-openai-test" },
      { kind: "select", value: 0 },
    ]);
    const res = await runSetupWizardFlow(io as any, { fetchModels: async () => FAKE_MODELS });
    expect(res.completed).toBe(true);
    expect(res.providerId).toBe("openai");
    expect(res.model).toBe("test-model-a");

    const { loadAppConfig } = require("../../lib/appConfig");
    const { getActiveProviderConfig } = require("../../providers");
    const { config } = loadAppConfig();
    expect(config.provider).toBe("openai");
    expect(config.keyProvider).toBe("openai");
    expect(config.defaultModel).toBe("test-model-a");
    const active = getActiveProviderConfig();
    expect(active).not.toBeNull();
    expect(active!.id).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// 2-4. Removed broken first-run strings / steps
// ---------------------------------------------------------------------------

describe("P7 — Removed broken first-run UX", () => {
  it("no wizard output contains the removed first-run strings", async () => {
    const { runSetupWizardFlow } = require("../../lib/setupWizard");
    const io = new FakeIO([
      { kind: "select", value: 0 },
      { kind: "hidden", value: "sk-x" },
      { kind: "select", value: 0 },
    ]);
    await runSetupWizardFlow(io as any, { fetchModels: async () => FAKE_MODELS });
    const out = io.allText;
    for (const forbidden of ["First run detected", "Configuration already exists", "Re-run setup", "Connection Mode", "direct/skip", "Choose mode"]) {
      expect(out).not.toContain(forbidden);
    }
  });

  it("provider selector offers providers, not direct/skip", async () => {
    const { runSetupWizardFlow } = require("../../lib/setupWizard");
    const io = new FakeIO([
      { kind: "select", value: 0 },
      { kind: "hidden", value: "sk-x" },
      { kind: "select", value: 0 },
    ]);
    await runSetupWizardFlow(io as any, { fetchModels: async () => FAKE_MODELS });
    const options = io.calls[0].options ?? [];
    expect(options).not.toContain("direct");
    expect(options).not.toContain("skip");
    expect(options).toContain("Custom");
  });

  it("runtime entry no longer contains the broken first-run strings", () => {
    const src = fs.readFileSync(path.join(__dirname, "../../index.tsx"), "utf8");
    const codeLines = src.split("\n").filter((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*") && !t.startsWith(" *");
    });
    for (const forbidden of ["First run detected", "Configuration already exists", "Re-run setup?", "Connection Mode", "direct/skip", "Choose mode"]) {
      for (const line of codeLines) {
        expect(line).not.toContain(forbidden);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Empty config != configured
// ---------------------------------------------------------------------------

describe("P7 — Empty/default config is not configured", () => {
  it("a default config.json alone is not usable", () => {
    writeConfigJson(dir, {
      schemaVersion: 2,
      gatewayUrl: null,
      apiUrl: null,
      keyProvider: null,
      provider: null,
      baseUrl: null,
      defaultModel: "",
      sandboxMode: "workspace",
      theme: "dark",
      updateCheckIntervalHours: 24,
      updateCheckEnabled: true,
    });
    resetState();
    const { analyzeSetupState } = require("../../lib/setupWizard");
    const state = analyzeSetupState();
    expect(state.usable).toBe(false);
    expect(state.missing).toContain("provider");
  });

  it("an empty provider config without key is not usable", () => {
    writeConfigJson(dir, { defaultModel: "openai/gpt-4o", sandboxMode: "workspace", theme: "dark", updateCheckEnabled: true });
    writeProvidersJson(dir, { schemaVersion: 1, providers: [{ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", type: "openai", defaultModel: "gpt-4o" }], activeProviderId: "openai" });
    resetState();
    const { analyzeSetupState } = require("../../lib/setupWizard");
    const state = analyzeSetupState();
    expect(state.usable).toBe(false);
    expect(state.missing).toContain("key");
  });
});

// ---------------------------------------------------------------------------
// 6. Partial config resumes at the correct step
// ---------------------------------------------------------------------------

describe("P7 — Partial config resumes at the correct step", () => {
  it("provider missing → resumes at provider selector", () => {
    writeConfigJson(dir, { defaultModel: "", sandboxMode: "workspace", theme: "dark", updateCheckEnabled: true });
    resetState();
    const { analyzeSetupState } = require("../../lib/setupWizard");
    expect(analyzeSetupState().missing[0]).toBe("provider");
  });

  it("key missing → resumes at API key, not provider", () => {
    writeConfigJson(dir, { defaultModel: "gpt-4o", sandboxMode: "workspace", theme: "dark", updateCheckEnabled: true });
    writeProvidersJson(dir, { schemaVersion: 1, providers: [{ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", type: "openai", defaultModel: "gpt-4o" }], activeProviderId: "openai" });
    resetState();
    const { runSetupWizardFlow } = require("../../lib/setupWizard");
    const io = new FakeIO([{ kind: "hidden", value: "sk-partial-key" }]);
    return runSetupWizardFlow(io as any, { fetchModels: async () => FAKE_MODELS }).then((res: { completed: boolean; providerId: string | null }) => {
      expect(res.completed).toBe(true);
      // Resumes exactly at the missing key step — no provider, no model prompt.
      expect(io.calls.length).toBe(1);
      expect(io.calls[0].kind).toBe("hidden");
      expect(res.providerId).toBe("openai");
    });
  });

  it("model missing → resumes at model picker, not provider/key", () => {
    writeConfigJson(dir, { defaultModel: "", sandboxMode: "workspace", theme: "dark", updateCheckEnabled: true });
    writeCliKeys(dir, { openai: "sk-partial-model" });
    writeProvidersJson(dir, { schemaVersion: 1, providers: [{ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", type: "openai", defaultModel: "" }], activeProviderId: "openai" });
    resetState();
    const { runSetupWizardFlow } = require("../../lib/setupWizard");
    const io = new FakeIO([{ kind: "select", value: 0 }]);
    return runSetupWizardFlow(io as any, { fetchModels: async () => FAKE_MODELS }).then((res: { completed: boolean; model: string | null }) => {
      expect(res.completed).toBe(true);
      expect(io.calls.length).toBe(1);
      expect(io.calls[0].kind).toBe("select");
      expect(io.calls[0].prompt).toContain("Model:");
      expect(res.model).toBe("test-model-a");
    });
  });

  it("partial config preserving existing stored base URL", async () => {
    writeConfigJson(dir, { defaultModel: "custom-model", sandboxMode: "workspace", theme: "dark", updateCheckEnabled: true });
    writeCliKeys(dir, { openai: "sk-preserved" });
    writeProvidersJson(dir, {
      schemaVersion: 1,
      providers: [{ id: "openai", name: "Custom OpenAI Proxy", baseUrl: "https://my-proxy.example.com/v1", type: "openai", defaultModel: "custom-model" }],
      activeProviderId: "openai",
    });
    resetState();
    const { runSetupWizardFlow } = require("../../lib/setupWizard");
    const io = new FakeIO([]);
    const res = await runSetupWizardFlow(io as any, { fetchModels: async () => FAKE_MODELS });
    const { getActiveProviderConfig } = require("../../providers");
    const active = getActiveProviderConfig()!;
    expect(res.completed).toBe(true);
    expect(active.baseUrl).toBe("https://my-proxy.example.com/v1");
    expect(active.defaultModel).toBe("custom-model");
  });
});

// ---------------------------------------------------------------------------
// 7. Valid config → straight to main TUI (no wizard)
// ---------------------------------------------------------------------------

describe("P7 — Valid config skips the wizard", () => {
  it("hasUsableConfiguration is true for provider + key + model", async () => {
    const { runSetupWizardFlow } = require("../../lib/setupWizard");
    const io = new FakeIO([
      { kind: "select", value: 0 },
      { kind: "hidden", value: "sk-valid" },
      { kind: "select", value: 0 },
    ]);
    await runSetupWizardFlow(io as any, { fetchModels: async () => FAKE_MODELS });

    const { hasUsableConfiguration, analyzeSetupState } = require("../../lib/setupWizard");
    expect(hasUsableConfiguration()).toBe(true);
    expect(analyzeSetupState().usable).toBe(true);
    expect(analyzeSetupState().missing).toEqual([]);
  });

  it("shouldAutoLaunchSetup is false (no wizard) when config is usable and TTY", async () => {
    const { runSetupWizardFlow } = require("../../lib/setupWizard");
    const io = new FakeIO([
      { kind: "select", value: 0 },
      { kind: "hidden", value: "sk-valid2" },
      { kind: "select", value: 0 },
    ]);
    await runSetupWizardFlow(io as any, { fetchModels: async () => FAKE_MODELS });

    const { shouldAutoLaunchSetup } = require("../../lib/setupWizard");
    const orig = (process.stdin as any).isTTY;
    try {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      expect(shouldAutoLaunchSetup()).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: orig, configurable: true });
    }
  });

  it("shouldAutoLaunchSetup is true on a fresh HOME TTY", () => {
    const { shouldAutoLaunchSetup } = require("../../lib/setupWizard");
    const orig = (process.stdin as any).isTTY;
    try {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      expect(shouldAutoLaunchSetup()).toBe(true);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: orig, configurable: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Cancel setup → no half-config
// ---------------------------------------------------------------------------

describe("P7 — Cancel leaves no half-config", () => {
  it("aborting at the API key step writes nothing", async () => {
    const { runSetupWizardFlow } = require("../../lib/setupWizard");
    const io = new FakeIO([
      { kind: "select", value: 0 },
      { kind: "hidden", abort: true },
    ]);
    const res = await runSetupWizardFlow(io as any, { fetchModels: async () => FAKE_MODELS });
    expect(res.completed).toBe(false);
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "providers.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "cli-keys.json"))).toBe(false);
  });

  it("aborting at the provider step writes nothing", async () => {
    const { runSetupWizardFlow } = require("../../lib/setupWizard");
    const io = new FakeIO([{ kind: "select", abort: true }]);
    const res = await runSetupWizardFlow(io as any, { fetchModels: async () => FAKE_MODELS });
    expect(res.completed).toBe(false);
    expect(fs.existsSync(path.join(dir, "config.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "providers.json"))).toBe(false);
  });

  it("aborting leaves an existing partial config untouched", async () => {
    // Already-migrated config + provider with a saved key, but no model —
    // the wizard resumes at the model step, and canceling it writes nothing.
    writeConfigJson(dir, { schemaVersion: 2, gatewayUrl: null, apiUrl: null, keyProvider: "openai", provider: "openai", baseUrl: "https://api.openai.com/v1", defaultModel: "", sandboxMode: "workspace", theme: "dark", updateCheckIntervalHours: 24, updateCheckEnabled: true });
    writeCliKeys(dir, { openai: "sk-partial-key" });
    writeProvidersJson(dir, { schemaVersion: 1, providers: [{ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", type: "openai", defaultModel: "" }], activeProviderId: "openai" });
    resetState();
    const beforeKeys = fs.readFileSync(path.join(dir, "cli-keys.json"), "utf8");
    const beforeProviders = fs.readFileSync(path.join(dir, "providers.json"), "utf8");

    const { runSetupWizardFlow } = require("../../lib/setupWizard");
    const io = new FakeIO([{ kind: "select", abort: true }]);
    const res = await runSetupWizardFlow(io as any, { fetchModels: async () => FAKE_MODELS });
    expect(res.completed).toBe(false);
    // No wizard data was written: providers.json and cli-keys.json are untouched
    // byte-for-byte, and config.json still has NO model (the wizard did not
    // fill in a half-config — loadAppConfig only normalizes the file format).
    expect(fs.readFileSync(path.join(dir, "providers.json"), "utf8")).toBe(beforeProviders);
    expect(fs.readFileSync(path.join(dir, "cli-keys.json"), "utf8")).toBe(beforeKeys);
    const configAfter = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    expect(configAfter.provider).toBe("openai");
    expect(configAfter.defaultModel).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 9. Manual setup still opens the wizard (forceAll)
// ---------------------------------------------------------------------------

describe("P7 — Manual setup (/setup & config init) still works", () => {
  it("forceAll re-runs the full wizard even when config is usable", async () => {
    const { runSetupWizardFlow } = require("../../lib/setupWizard");
    const setupIo = new FakeIO([
      { kind: "select", value: 0 },
      { kind: "hidden", value: "sk-usable" },
      { kind: "select", value: 0 },
    ]);
    await runSetupWizardFlow(setupIo as any, { fetchModels: async () => FAKE_MODELS });
    expect(require("../../lib/setupWizard").hasUsableConfiguration()).toBe(true);

    const manualIo = new FakeIO([
      { kind: "select", value: 2 }, // Anthropic this time
      { kind: "hidden", value: "sk-replaced" },
      { kind: "select", value: 1 },
    ]);
    const res = await runSetupWizardFlow(manualIo as any, { forceAll: true, fetchModels: async () => FAKE_MODELS });
    expect(res.completed).toBe(true);
    expect(res.providerId).toBe("anthropic");
    expect(res.model).toBe("test-model-b");
    expect(manualIo.calls[0].kind).toBe("select");
    expect(manualIo.calls[1].kind).toBe("hidden");
    expect(manualIo.calls[2].prompt).toContain("Model:");
  });

  it("TUI registers /setup in the command list and handler", () => {
    const { COMMANDS } = require("../../tui/store") as any;
    const commands = (COMMANDS as Array<{ name: string }>).map((c) => c.name);
    expect(commands).toContain("/setup");
    const src = fs.readFileSync(path.join(__dirname, "../../tui/events/agentWiring.ts"), "utf8");
    expect(src).toContain('case "/setup"');
    expect(src).toContain("config\", \"init");
  });
});

// ---------------------------------------------------------------------------
// Helper: spawn CLI under a PTY (util-linux `script`) and drive it
// ---------------------------------------------------------------------------

async function runPty(args: string[], env: Record<string, string>, scriptInput: Array<{ waitMarker: string; send: string }>, timeoutMs = 30000): Promise<{ output: string; code: number | null }> {
  const entry = path.join(__dirname, "../../../src/index.tsx");
  const cmd = `env ${Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")} bun ${JSON.stringify(entry)} ${args.join(" ")}`;

  const pty = spawn("script", ["-qec", cmd, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  const inputQueue = { scripts: [...scriptInput], index: 0 };
  pty.stdout.on("data", (d: Buffer) => {
    output += d.toString("utf8");
    while (
      inputQueue.index < inputQueue.scripts.length &&
      output.includes(inputQueue.scripts[inputQueue.index].waitMarker)
    ) {
      const s = inputQueue.scripts[inputQueue.index];
      try {
        pty.stdin.write(s.send);
      } catch {}
      inputQueue.index++;
    }
  });
  pty.stderr.on("data", (d: Buffer) => {
    output += d.toString("utf8");
  });
  pty.stdin.on("error", () => {});

  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      try {
        pty.kill("SIGKILL");
      } catch {}
      resolve(null);
    }, timeoutMs);
    pty.on("exit", (c) => {
      clearTimeout(timer);
      resolve(c);
    });
    pty.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  if (pty.stdin.writable) pty.stdin.end();
  return { output, code };
}

// ---------------------------------------------------------------------------
// 10. Fresh-install clean-HOME smoke test
// ---------------------------------------------------------------------------

describe("P7 — Fresh clean-HOME smoke test", () => {
  setDefaultTimeout(60_000);

  it.skip(
    "runs `toolnet` on an empty HOME: provider setup direct → save → main TUI",
    async () => {
      const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), "p7-smoke-"));
      const cfgDir = path.join(smokeHome, ".toolnetcli");
      const { output, code } = await runPty(
        ["--no-splash"],
        { HOME: smokeHome, TOOLNETCLI_CONFIG_DIR: cfgDir, TOOLNET_HEADLESS: "1", NO_COLOR: "1" },
        [
          { waitMarker: "Select provider:", send: "\x1b[B\r" },
          { waitMarker: "API Key:", send: "sk-smoke-tty\r" },
          { waitMarker: "Model:", send: "\r" },
          { waitMarker: "Enter a coding task", send: "/exit\r" },
        ]
      );

      // 1. Startup opened the provider setup directly.
      expect(output).toContain("Select provider:");
      expect(output).toContain("✓ Configuration saved");
      // 2-4. The broken first-run strings are gone from real output.
      for (const forbidden of ["First run detected", "Configuration already exists", "Re-run setup", "Connection Mode", "direct/skip"]) {
        expect(output).not.toContain(forbidden);
      }
      // After the wizard the config is usable and persisted.
      const config = JSON.parse(fs.readFileSync(path.join(cfgDir, "config.json"), "utf8"));
      const providers = JSON.parse(fs.readFileSync(path.join(cfgDir, "providers.json"), "utf8"));
      const keys = JSON.parse(fs.readFileSync(path.join(cfgDir, "cli-keys.json"), "utf8"));
      expect(config.provider).toBeTruthy();
      expect(config.defaultModel).toBeTruthy();
      expect(providers.activeProviderId).toBeTruthy();
      expect(Object.keys(keys).length).toBeGreaterThan(0);
      // /exit gracefully left the TUI.
      expect(code).toBe(0);
      cleanDir(smokeHome);
    }
  );

  it(
    "`toolnet config init` works non-interactively via piped answers (manual setup)",
    async () => {
      const smokeHome = fs.mkdtempSync(path.join(os.tmpdir(), "p7-smoke2-"));
      const cfgDir = path.join(smokeHome, ".toolnetcli");
      const entry = path.join(__dirname, "../../../src/index.tsx");
      const env = { HOME: smokeHome, TOOLNETCLI_CONFIG_DIR: cfgDir, TOOLNET_HEADLESS: "1", NO_COLOR: "1" };

      // Answers: provider 2=OpenAI, then API key, then first model
      const inputs = "2\nsk-smoke-pipe\n1\n";
      const res = await new Promise<{ stdout: string; code: number | null }>((resolve, reject) => {
        const child = spawn("bun", ["run", entry, "config", "init"], {
          env: { ...process.env, ...env },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let outBuf = "";
        child.stdout.on("data", (d) => (outBuf += d.toString()));
        child.stderr.on("data", (d) => (outBuf += d.toString()));
        child.on("error", reject);
        child.stdin.write(inputs);
        child.stdin.end();
        child.on("exit", (c) => resolve({ stdout: outBuf, code: c }));
      });
      expect(res.code).toBe(0);
      expect(res.stdout).toContain("Select provider:");
      expect(res.stdout).toContain("✓ Configuration saved");
      for (const forbidden of ["First run detected", "Configuration already exists", "Re-run setup", "Connection Mode", "direct/skip"]) {
        expect(res.stdout).not.toContain(forbidden);
      }
      const config = JSON.parse(fs.readFileSync(path.join(cfgDir, "config.json"), "utf8"));
      const providers = JSON.parse(fs.readFileSync(path.join(cfgDir, "providers.json"), "utf8"));
      const keys = JSON.parse(fs.readFileSync(path.join(cfgDir, "cli-keys.json"), "utf8"));
      expect(config.provider).toBe("openai");
      expect(providers.activeProviderId).toBe("openai");
      expect(keys.openai).toBeTruthy();
      cleanDir(smokeHome);
    }
  );
});