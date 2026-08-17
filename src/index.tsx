#!/usr/bin/env bun
import { initWorkspace } from "./lib/codingAgent";
const CLI_VERSION = "1.0.5";
initWorkspace();
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  console.log(`ToolNet CLI v${CLI_VERSION} (${process.platform}-${process.arch})`);
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
INTERACTIVE COMMANDS:
  /help
  /bypass
  /status
  /model
  /session
  /sandbox
  /doctor
  /update
  /compact
  /attach
  /exit
`);
  process.exit(0);
}

// Check --bypass flag
if (args.includes("--bypass") || args.includes("-b")) {
  const { bypassEngine, ALL_BYPASS_LEVELS } = await import("./lib/bypass");
  const bpIdx = args.findIndex((a) => a === "--bypass" || a === "-b");
  let level: any = undefined;
  if (bpIdx >= 0 && args[bpIdx + 1] && !args[bpIdx + 1].startsWith("-") && ALL_BYPASS_LEVELS.includes(args[bpIdx + 1] as any)) {
    level = args[bpIdx + 1];
  }
  bypassEngine.setBypass(true, level || "godmode");
}
const promptIdx = args.findIndex(
  (arg) => arg === "-p" || arg === "--prompt"
);
if (promptIdx >= 0) {
  const prompt = args[promptIdx + 1];
  if (!prompt || prompt.startsWith("-")) {
    console.error("Error: -p/--prompt requires a prompt.");
    process.exit(1);
  }
  const { runNonInteractive } = await import("./lib/nonInteractive");
  await runNonInteractive({
    prompt,
    json: args.includes("--json"),
    verbose: args.includes("--verbose")
  });
} else {
  const simple = args.includes("--simple") || args.includes("-s");
  if (simple) {
    const { main } = await import("./simple-repl");
    await main();
  } else {
    const { main } = await import("./tui");
    await main();
  }
}
export {};
