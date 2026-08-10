#!/usr/bin/env bun
import { initWorkspace } from "./lib/codingAgent";
const CLI_VERSION = "1.0.0";
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
  -v, --version         Print version
  -h, --help            Show help
  --no-splash           Skip startup splash
  --verbose             Enable verbose output
  --json                JSON output with -p
INTERACTIVE COMMANDS:
  /help
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
