/**
 * First-run setup wizard for ToolNet CLI.
 *
 * Launched when:
 *   toolnet config init
 *   (or auto-detected on first interactive launch when no config exists)
 *
 * Questions:
 *  1. Provider mode (direct API / ToolNet gateway / skip)
 *  2. Base URL
 *  3. API key / provider
 *  4. Default model
 *  5. Sandbox mode
 *  6. Theme (optional)
 */

import * as rl from "node:readline";
import { updateAppConfig, type AppConfig, type SandboxMode, SANDBOX_MODES, loadAppConfig } from "./appConfig";
import { saveCliKey, getCliKey, maskApiKey, type StoredKeyInfo, listAllCliKeys } from "./keys";
import { addProvider, setActiveProvider, type ProviderConfig } from "../providers";

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
  mode: "direct" | "skip";
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
    console.log("   direct  — connect directly to an AI provider API");
    console.log("   skip    — keep current settings");
    const modeInput = await ask(r, "\n  Choose mode [direct/skip]: ");
    const mode = modeInput === "skip" ? "skip" : "direct";
    result.mode = mode;

    if (mode === "skip") return result;

    // 2. URL
    console.log("\n\x1b[1m2. API Base URL\x1b[0m");
    console.log("   Enter the provider API endpoint (e.g. https://api.openai.com/v1)");
    const urlInput = await ask(r, `  Base URL [${existing.baseUrl || existing.apiUrl || "none"}]: `);
    const baseUrl = urlInput || existing.baseUrl || existing.apiUrl || "";

    // 3. API key
    const existingKeys = listAllCliKeys();
    if (existingKeys.length) {
      console.log("\n\x1b[1m3. API Key\x1b[0m");
      console.log("  Existing keys:");
      for (const k of existingKeys) {
        console.log(`    ${k.provider}: ${k.maskedKey} (${k.source === "env" ? "env: " + k.envVar : "stored"})`);
      }
      const changeKey = await ask(r, "  Store a new key? [y/N] ");
      if (changeKey && changeKey.toLowerCase().startsWith("y")) {
        await promptAndSaveKey(r, result);
      }
    } else {
      console.log("\n\x1b[1m3. API Key\x1b[0m");
      console.log(`  Providers: ${PROVIDERS.join(", ")}`);
      await promptAndSaveKey(r, result);
    }

    // 4. Default model
    const defaultModels: Record<string, string> = {
      openai: "gpt-4o",
      anthropic: "claude-sonnet-4-20250514",
      gemini: "gemini-2.0-flash",
      deepseek: "deepseek-chat",
      openrouter: "gpt-4o",
    };
    const suggested = defaultModels[existing.keyProvider || "openai"] || "";
    const modelInput = await ask(r, `\n\x1b[1m4. Default Model\x1b[0m\n  Enter a model identifier\n  Default [${suggested || "none"}]: `);
    const defaultModel = modelInput || suggested;

    // 5. Sandbox mode
    console.log("\n\x1b[1m5. Sandbox Mode\x1b[0m");
    console.log("   workspace  — restrict to workspace directory (default)");
    console.log("   ask        — prompt before file access outside workspace");
    console.log("   full-access — no sandbox restrictions");
    const sandboxInput = await ask(r, "  Choose [workspace/ask/full-access]: ");
    const sandboxMode: SandboxMode = SANDBOX_MODES.includes(sandboxInput as SandboxMode)
      ? (sandboxInput as SandboxMode)
      : existing.sandboxMode || "ask";

    // 6. Theme
    const themeInput = await ask(r, "\n\x1b[1m6. Theme (optional)\x1b[0m\n  dark / light [dark]: ");
    const theme = themeInput || "dark";

    // 7. Update check
    const updateInput = await ask(r, "\n\x1b[1m7. Auto-update check\x1b[0m\n  Check for updates on launch? [Y/n]: ");
    const updateCheckEnabled = !updateInput || !updateInput.toLowerCase().startsWith("n");

    // Save provider to provider registry
    if (baseUrl) {
      const providerId = (existing.keyProvider || result.config.keyProvider || "openai-compatible").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      const providerConfig: ProviderConfig = {
        id: providerId,
        name: existing.keyProvider || result.config.keyProvider || providerId,
        baseUrl: baseUrl,
        apiKeyEnv: result.config.keyProvider ? `${result.config.keyProvider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY` : undefined,
        defaultModel: defaultModel || undefined,
      };
      addProvider(providerConfig);
      setActiveProvider(providerId);
    }

    const providerId = baseUrl ? (existing.keyProvider || result.config.keyProvider || "openai-compatible").toLowerCase().replace(/[^a-z0-9_-]/g, "-") : null;
    const config = updateAppConfig({
      gatewayUrl: null,
      apiUrl: null,
      baseUrl: baseUrl || null,
      provider: providerId,
      defaultModel,
      sandboxMode,
      theme,
      updateCheckEnabled,
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
