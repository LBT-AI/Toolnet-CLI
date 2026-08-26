#!/usr/bin/env bun
import { initWorkspace } from "./lib/codingAgent";

// ---- Version (single source of truth) ----
import { getVersion, getVersionString, getVersionJson } from "./lib/version";
import type { ShellName } from "./lib/completion";
import { generateCompletionScript } from "./lib/completion";
import { handleUpdate } from "./lib/updater";
import { appConfigExists, loadAppConfig } from "./lib/appConfig";
import { runSetupWizard, isTty, printSetupHint } from "./lib/setupWizard";

const CLI_VERSION = getVersion();
const args = process.argv.slice(2);

// ---- --version / --help (fast, exits immediately) ----
if (args.includes("--version") || args.includes("-v")) {
  console.log(getVersionString());
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
ToolNet CLI — AI coding agent for the terminal

USAGE:
  toolnet [options]
  toolnet -p "Your prompt" [options]

OPTIONS:
  -p, --prompt <text>   Run once without opening the TUI
  -s, --simple          Run lightweight REPL
  -b, --bypass [level]  Enable Bypass/Jailbreak mode (e.g. --bypass godmode)
  -v, --version         Print version
  -h, --help            Show help
  --no-splash           Skip startup splash
  --verbose             Enable verbose output
  --json                JSON output with -p
  --resume              Resume last session
  --session <id>        Open a specific session
  --model <name>        Default model override

SUBCOMMANDS:
  config init           Run the first-run setup wizard
  config show           Display current configuration
  config path           Print config file path
  config get <key>      Get a config value
  config set <key> <v>  Set a config value
  usage [--json]        Show token usage for current session
  budget [show|set|clr] Manage spending budget
  doctor [--json]       Run diagnostic checks
  completion bash       Output Bash completion script
  completion zsh        Output Zsh completion script
  completion fish       Output Fish completion script
  update [--check]      Check for and apply updates
  update --check        Only check, do not apply
  version [--json]      Version and build metadata

INTERACTIVE COMMANDS:
  /help    /bypass    /status    /model    /session
  /sandbox /doctor    /update    /compact  /attach
  /config  /exit
`);
  process.exit(0);
}

// ---- CLI subcommand dispatch ----
const subCmd = args[0] ?? "";

if (subCmd === "config") {
  const subArg = args[1] ?? "";
  if (subArg === "init") {
    if (!isTty()) {
      printSetupHint();
      process.exit(1);
    }
    await runSetupWizard();
    process.exit(0);
  }
  if (subArg === "show") {
    const { config } = loadAppConfig();
    console.log(JSON.stringify(config, null, 2));
    process.exit(0);
  }
  if (subArg === "path") {
    const { getAppConfigPath } = await import("./lib/appConfig");
    console.log(getAppConfigPath());
    process.exit(0);
  }
  if (subArg === "get") {
    const key = args[2] ?? "";
    if (!key) { console.error("Usage: toolnet config get <key>"); process.exit(1); }
    const { config, created } = loadAppConfig();
    const val = (config as unknown as Record<string, unknown>)[key];
    if (val === undefined && !created) { console.error(`Unknown config key: ${key}`); process.exit(1); }
    console.log(typeof val === "object" ? JSON.stringify(val) : String(val ?? ""));
    process.exit(0);
  }
  if (subArg === "set") {
    const key = args[2] ?? "";
    const value = args[3] ?? "";
    if (!key || !value) { console.error("Usage: toolnet config set <key> <value>"); process.exit(1); }
    const { config } = loadAppConfig();
    const current = config as unknown as Record<string, unknown>;
    if (!(key in current)) { console.error(`Unknown config key: ${key}\nValid keys: ${Object.keys(current).join(", ")}`); process.exit(1); }
    // Coerce types
    let parsed: unknown = value;
    if (value === "true") parsed = true;
    else if (value === "false") parsed = false;
    else if (!isNaN(Number(value)) && value !== "") parsed = Number(value);
    const { updateAppConfig } = await import("./lib/appConfig");
    updateAppConfig({ [key]: parsed });
    console.log(`Set ${key} = ${JSON.stringify(parsed)}`);
    process.exit(0);
  }
  console.error(`Unknown config subcommand: ${subArg}\nUsage: toolnet config [init|show|path|get|set]`);
  process.exit(1);
}

if (subCmd === "completion") {
  const shell: string = args[1] ?? "";
  if (!["bash", "zsh", "fish"].includes(shell)) {
    console.error("Usage: toolnet completion [bash|zsh|fish]");
    process.exit(1);
  }
  process.stdout.write(generateCompletionScript(shell as ShellName));
  process.exit(0);
}

if (subCmd === "update") {
  await handleUpdate(args.slice(1));
  process.exit(0);
}

if (subCmd === "usage") {
  const { getGlobalTracker } = await import("./lib/usage");
  const tracker = getGlobalTracker();
  const usage = tracker.getSessionUsage();
  if (args.includes("--json")) {
    console.log(JSON.stringify(usage, null, 2));
  } else {
    console.log("Current session");
    console.log(`Input:   ${usage.inputTokens.toLocaleString()}`);
    console.log(`Output:  ${usage.outputTokens.toLocaleString()}`);
    console.log(`Cached:  ${usage.cachedInputTokens.toLocaleString()}`);
    console.log(`Total:   ${usage.totalTokens.toLocaleString()}`);
    console.log(`Cost:    ${usage.estimatedCostUsd !== null ? "$" + usage.estimatedCostUsd.toFixed(4) : "unknown"}`);
    console.log(`Requests: ${usage.requests}`);
  }
  process.exit(0);
}

if (subCmd === "budget") {
  const { getBudgetConfig, saveBudgetConfig, clearBudget } = await import("./lib/usage");
  const budgetArg = args[1] ?? "show";
  if (budgetArg === "show") {
    const cfg = getBudgetConfig();
    console.log(JSON.stringify(cfg, null, 2));
  } else if (budgetArg === "set") {
    const amount = parseFloat(args[2] ?? "");
    if (isNaN(amount) || amount <= 0) { console.error("Usage: toolnet budget set <amount-usd>"); process.exit(1); }
    const enforce = args.includes("--enforce");
    saveBudgetConfig({ budgetUsd: amount, enforceBudget: enforce });
    console.log(`Budget set to $${amount}${enforce ? " (enforced)" : ""}`);
  } else if (budgetArg === "clear") {
    clearBudget();
    console.log("Budget cleared.");
  } else {
    console.error("Usage: toolnet budget [show|set <amount>|clear]");
    process.exit(1);
  }
  process.exit(0);
}

if (subCmd === "doctor") {
  const { runDoctor, formatDoctorReport } = await import("./lib/doctor");
  const report = runDoctor();
  if (args.includes("--json")) {
    report.json = true;
    console.log(JSON.stringify({
      version: report.version,
      platform: report.platform,
      arch: report.arch,
      installMethod: report.installMethod,
      configPath: report.configPath,
      sessionsDir: report.sessionsDir,
      gatewayUrl: report.gatewayUrl,
      defaultModel: report.defaultModel,
      sandboxMode: report.sandboxMode,
      budgetUsd: report.budgetUsd,
      checks: report.checks,
    }, null, 2));
  } else {
    console.log(formatDoctorReport(report));
  }
  process.exit(0);
}

if (subCmd === "version") {
  if (args.includes("--json")) {
    console.log(JSON.stringify(getVersionJson(), null, 2));
  } else {
    console.log(getVersionString());
  }
  process.exit(0);
}

// ---- --bypass flag ----
if (args.includes("--bypass") || args.includes("-b")) {
  const { bypassEngine, ALL_BYPASS_LEVELS } = await import("./lib/bypass");
  const bpIdx = args.findIndex((a) => a === "--bypass" || a === "-b");
  let level: any = undefined;
  if (bpIdx >= 0 && args[bpIdx + 1] && !args[bpIdx + 1].startsWith("-") && ALL_BYPASS_LEVELS.includes(args[bpIdx + 1] as any)) {
    level = args[bpIdx + 1];
  }
  bypassEngine.setBypass(true, level || "godmode");
}

// ---- Mode detection (early, before any mode-dependent logic) ----
const isHeadless = args.includes("-p") || args.includes("--prompt");
const isSimple = args.includes("--simple") || args.includes("-s");
const isInteractiveMode = !isHeadless && !isSimple;

// ---- Workspace init (deferred so subcommands are silent) ----
initWorkspace();

// ---- Background update check (interactive only, non-blocking) ----
if (isInteractiveMode && isTty() && !process.env.TOOLNET_HEADLESS) {
  import("./lib/updater").then(({ backgroundCheck }) => {
    backgroundCheck().then((info) => {
      if (info?.hasUpdate) {
        process.stderr.write(`\x1b[33m⬆ ToolNet CLI ${info.latestVersion} available (current ${info.currentVersion}). Run 'toolnet update' to upgrade.\x1b[0m\n`);
      }
    }).catch(() => {});
  }).catch(() => {});
}

// ---- First-run detection (interactive mode only) ----

if (isInteractiveMode && isTty() && !appConfigExists()) {
  console.log("\n\x1b[36mFirst run detected — launching setup wizard…\x1b[0m\n");
  await runSetupWizard();
}

// ---- Non-interactive prompt mode ----
const promptIdx = args.findIndex(
  (arg) => arg === "-p" || arg === "--prompt"
);
if (promptIdx >= 0) {
  const prompt = args[promptIdx + 1];
  if (!prompt || prompt.startsWith("-")) {
    console.error("Error: -p/--prompt requires a prompt.");
    process.exit(1);
  }
  if (!appConfigExists()) {
    printSetupHint();
  }
  const { runNonInteractive } = await import("./lib/nonInteractive");
  const { parseFormat } = await import("./lib/structuredOutput");
  const formatFlag = args.includes("--json") ? "json" : args.includes("--format") ? args[args.indexOf("--format") + 1] : undefined;
  await runNonInteractive({
    prompt,
    json: args.includes("--json"),
    format: parseFormat(formatFlag),
    verbose: args.includes("--verbose")
  });
} else {
  if (isSimple) {
    const { main } = await import("./simple-repl");
    await main();
  } else {
    const { main } = await import("./tui");
    await main();
  }
}
export {};
