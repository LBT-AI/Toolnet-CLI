/**
 * First-run setup wizard for ToolNet CLI.
 *
 * Launched when:
 *   toolnet config init
 *   (or auto-detected on first interactive launch when no config exists)
 *
 * Questions:
 *  1. Gateway / API mode
 *  2. Gateway URL (if gateway mode) or API URL (if direct mode)
 *  3. API key / provider (stored via key-manager, not plaintext config)
 *  4. Default model
 *  5. Sandbox mode
 *  6. Theme (optional)
 */

import * as rl from "node:readline";
import { updateAppConfig, type AppConfig, type SandboxMode, SANDBOX_MODES, loadAppConfig } from "./appConfig";
import { saveCliKey, getCliKey, maskApiKey, type StoredKeyInfo, listAllCliKeys } from "./keys";

function createPrompt(): rl.Interface {
  return rl.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(r: rl.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    r.question(question, (answer: string) => resolve(answer.trim()));
  });
}

const PROVIDERS = ["openai", "anthropic", "gemini", "deepseek", "openrouter", "groq", "together", "mistral", "alibaba"] as const;

export interface WizardResult {
  mode: "gateway" | "direct" | "skip";
  config: AppConfig;
  keySet: boolean;
}

/**
 * Returns true when stdin is a TTY (interactive session).
 * For non-interactive heads (e.g. piped input) we skip the wizard.
 */
export function isTty(): boolean {
  try {
    return Boolean(process.stdin?.isTTY);
  } catch { return false; }
}

/**
 * Run the interactive setup wizard.
 * Returns WizardResult so callers (tests, auto-init) can inspect what was set.
 */
export async function runSetupWizard(): Promise<WizardResult> {
  const { config: existing, created } = loadAppConfig();
  const result: WizardResult = { mode: "skip", config: existing, keySet: false };
  const r = createPrompt();

  try {
    console.log("\n\x1b[1m\x1b[38;5;46mToolNet CLI — First-Time Setup\x1b[0m\n");

    if (!created) {
      const answer = await ask(r, "Configuration already exists. Re-run setup? [y/N] ");
      if (!answer || !answer.toLowerCase().startsWith("y")) {
        return result;
      }
    }

    // 1. Mode
    console.log("\n\x1b[1m1. Connection Mode\x1b[0m");
    console.log("   gateway — local ToolNet gateway (default)");
    console.log("   direct  — direct API calls to a provider");
    console.log("   skip    — keep current settings");
    const modeInput = await ask(r, "\n  Choose mode [gateway/direct/skip]: ");
    const mode = modeInput === "direct" ? "direct" : modeInput === "skip" ? "skip" : "gateway";
    result.mode = mode;

    if (mode === "skip") return result;

    // 2. URL
    let gatewayUrl: string | null = existing.gatewayUrl;
    let apiUrl: string | null = existing.apiUrl;
    if (mode === "gateway") {
      const urlInput = await ask(r, `\n  Gateway URL [${existing.gatewayUrl || "http://127.0.0.1:20127"}]: `);
      if (urlInput) gatewayUrl = urlInput;
    } else {
      console.log("\n  Enter the provider API endpoint (e.g. https://api.openai.com/v1)");
      const urlInput = await ask(r, `  API URL [${existing.apiUrl || "none"}]: `);
      if (urlInput) apiUrl = urlInput;
    }

    // 3. API key
    const existingKeys = listAllCliKeys();
    if (existingKeys.length) {
      console.log("\n\x1b[1m2. API Key\x1b[0m");
      console.log("  Existing keys:");
      for (const k of existingKeys) {
        console.log(`    ${k.provider}: ${k.maskedKey} (${k.source === "env" ? "env: " + k.envVar : "stored"})`);
      }
      const changeKey = await ask(r, "  Store a new key? [y/N] ");
      if (changeKey && changeKey.toLowerCase().startsWith("y")) {
        await promptAndSaveKey(r, result);
      }
    } else {
      console.log("\n\x1b[1m2. API Key\x1b[0m");
      console.log(`  Providers: ${PROVIDERS.join(", ")}`);
      await promptAndSaveKey(r, result);
    }

    // 4. Default model
    const defaultModels: Record<string, string> = {
      openai: "openai/gpt-4o",
      anthropic: "anthropic/claude-sonnet-4-20250514",
      gemini: "google/gemini-2.0-flash",
      deepseek: "deepseek/deepseek-chat",
      openrouter: "openai/gpt-4o",
    };
    const suggested = defaultModels[existing.keyProvider || "openai"] || "openai/gpt-4o";
    const modelInput = await ask(r, `\n\x1b[1m3. Default Model\x1b[0m\n  Enter a model identifier\n  Default [${suggested}]: `);
    const defaultModel = modelInput || suggested;

    // 5. Sandbox mode
    console.log("\n\x1b[1m4. Sandbox Mode\x1b[0m");
    console.log("   workspace  — restrict to workspace directory (default)");
    console.log("   ask        — prompt before file access outside workspace");
    console.log("   full-access — no sandbox restrictions");
    const sandboxInput = await ask(r, "  Choose [workspace/ask/full-access]: ");
    const sandboxMode: SandboxMode = SANDBOX_MODES.includes(sandboxInput as SandboxMode)
      ? (sandboxInput as SandboxMode)
      : existing.sandboxMode || "ask";

    // 6. Theme
    const themeInput = await ask(r, "\n\x1b[1m5. Theme (optional)\x1b[0m\n  dark / light [dark]: ");
    const theme = themeInput || "dark";

    const config = updateAppConfig({
      gatewayUrl: mode === "gateway" ? (gatewayUrl ?? existing.gatewayUrl) : null,
      apiUrl: mode === "direct" ? (apiUrl ?? null) : existing.apiUrl,
      defaultModel,
      sandboxMode,
      theme,
    });
    result.config = config;

    console.log("\n\x1b[38;5;46m✔ Setup complete.\x1b[0m Run `toolnet` to get started.\n");
    return result;
  } finally {
    r.close();
  }
}

async function promptAndSaveKey(r: rl.Interface, result: WizardResult): Promise<void> {
  const providerInput = await ask(r, "  Provider name: ");
  const provider = providerInput.toLowerCase().trim();
  if (!provider) return;

  const key = await ask(r, "  API key (will be stored locally, mode 0600): ");
  if (!key) return;

  saveCliKey(provider, key);
  result.keySet = true;
  result.config.keyProvider = provider;
  updateAppConfig({ keyProvider: provider });
  console.log(`  ✔ Saved key for ${provider} (${maskApiKey(key)})`);
}

/** Non-interactive hint when TTY is unavailable. */
export function printSetupHint(): void {
  console.log(
    "\n\x1b[33mFirst-run setup required.\x1b[0m Run:\n" +
    "  toolnet config init\n\n" +
    "Or set API key manually:\n" +
    "  export ANTHROPIC_API_KEY=sk-...\n" +
    "  export OPENAI_API_KEY=sk-...\n"
  );
}
