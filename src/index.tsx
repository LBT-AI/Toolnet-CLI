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
  console.error(`Unknown config subcommand: ${subArg}\nUsage: toolnet config [init|show|path]`);
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

// ---- Workspace init (deferred so subcommands are silent) ----
initWorkspace();

// ---- First-run detection (interactive mode only) ----
const isHeadless = args.includes("-p") || args.includes("--prompt");
const isSimple = args.includes("--simple") || args.includes("-s");
const isInteractiveMode = !isHeadless && !isSimple;

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
  await runNonInteractive({
    prompt,
    json: args.includes("--json"),
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
