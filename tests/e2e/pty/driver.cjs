#!/usr/bin/env node
/**
 * Real-PTY driver for TUI acceptance.
 *
 * Runs under node because node-pty's forkpty event delivery is unreliable when
 * the parent process is Bun (child spawns but produces no output). The bun test
 * suite spawns this driver and parses the JSON envelope; the terminal session
 * itself is 100% real: pseudo-terminal, raw keystrokes, actual exit.
 *
 * Script entries are [delayOrMarker, keys] pairs processed sequentially:
 *   - delayOrMarker "WAIT:<text>" holds until the output stream contains
 *     <text> (startup readiness — never assume a fixed cold-start delay);
 *   - otherwise it is a delay in ms before writing `keys` ("" writes nothing).
 * `keys` may be "RESIZE:CxR" to resize the pseudo-terminal instead of writing.
 */
"use strict";

let pty = null;
try {
  pty = require("node-pty");
} catch {
  pty = null;
}

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}

const cols = parseInt(arg("--cols", "80"), 10);
const rows = parseInt(arg("--rows", "24"), 10);
const entry = arg("--entry", "dist/node/index.js");
const cwd = arg("--cwd", process.cwd());
let script = [];
try {
  script = JSON.parse(arg("--script", "[]"));
} catch {
  script = [];
}

if (!pty) {
  console.log(JSON.stringify({ available: false, reason: "node-pty not installed" }));
  process.exit(0);
}

const proc = pty.spawn("node", [entry], {
  name: "xterm-256color",
  cols,
  rows,
  cwd,
  env: { ...process.env, TERM: "xterm-256color" },
});

let output = "";
let settled = false;
let exitCode = 0;

const finish = (code) => {
  if (settled) return;
  settled = true;
  exitCode = code;
  // Let trailing onData chunks land before snapshotting the stream.
  setTimeout(() => {
    console.log(JSON.stringify({ available: true, exitCode, output }));
    process.exit(0);
  }, 250);
};

proc.onData((d) => {
  output += d;
});
proc.onExit(({ exitCode: code }) => finish(code));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (const step of script) {
    if (settled) return;
    const marker = String(step[0] ?? "");
    const action = step[1] ?? "";
    if (marker.startsWith("WAIT:")) {
      const needle = marker.slice(5);
      const deadline = Date.now() + 30_000;
      while (!output.includes(needle)) {
        if (settled) return;
        if (Date.now() > deadline) break; // proceed anyway; assertions decide
        await sleep(100);
      }
      // Readiness reached — fall through and write this step's keys.
    } else {
      await sleep(Number(marker) || 0);
    }
    if (settled) return;
    if (typeof action === "string" && action.startsWith("RESIZE:")) {
      const [c, r] = action.slice(7).split("x").map((n) => parseInt(n, 10));
      try {
        proc.resize(c, r);
      } catch {}
      continue;
    }
    try {
      proc.write(action);
    } catch {}
  }
  // Safety net: if the app never exits, kill and report what was captured.
  const drain = async () => {
    while (!settled) await sleep(100);
  };
  await Promise.race([drain(), sleep(15_000)]);
  try {
    proc.kill();
  } catch {}
  finish(exitCode);
})();
