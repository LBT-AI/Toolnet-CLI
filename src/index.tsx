#!/usr/bin/env bun

import { initWorkspace } from "./lib/codingAgent";

initWorkspace();

const args = process.argv.slice(2);

// Check --version / -v
if (args.includes("--version") || args.includes("-v")) {
  console.log(`toolnet-api v1.0.0 (${process.platform}-${process.arch})`);
  process.exit(0);
}

// Check --help / -h
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
ToolNet API CLI — AI coding agent for the terminal

USAGE:
  toolnet [options]
  toolnet -p "Your prompt" [options]

OPTIONS:
  -p, --prompt <text>   Run prompt non-interactively for scripts & CI
  -s, --simple          Run lightweight REPL interface
  -v, --version         Print version information
  -h, --help            Print help information
  --no-splash           Skip TUI splash animation
  --verbose             Enable verbose debug logging
  --json                Output result in JSON format (with -p)

SLASH COMMANDS (Interactive Mode):
  /help, /status, /model, /session, /sandbox, /doctor, /update, /compact, /attach, /exit
`);
  process.exit(0);
}

// Handle non-interactive prompt mode: -p or --prompt
const promptIdx = args.findIndex(a => a === "-p" || a === "--prompt");
if (promptIdx >= 0 && promptIdx < args.length - 1) {
  const prompt = args[promptIdx + 1];
  const isJson = args.includes("--json");
  const isVerbose = args.includes("--verbose");

  const { runNonInteractive } = await import("./lib/nonInteractive");
  await runNonInteractive({ prompt, json: isJson, verbose: isVerbose });
}

const SIMPLE = args.includes("--simple") || args.includes("-s");

if (SIMPLE) {
  const { main: mainRepl } = await import("./simple-repl");
  await mainRepl();
} else {
  const { main: mainTui } = await import("./tui");
  await mainTui();
}

export {};
