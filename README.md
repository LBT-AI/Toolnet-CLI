# ToolNet API CLI (`toolnet-api`)

> AI Coding Agent for the Terminal with TUI, Real Sandbox Engine, Structured Patches, Vision Support, Context Compaction & Non-Interactive CI Mode.

[![CLI CI Pipeline](https://github.com/LBT-AI/Toolnet-CLI/actions/workflows/cli-ci.yml/badge.svg)](https://github.com/LBT-AI/Toolnet-CLI/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![npm version](https://img.shields.io/npm/v/toolnet-api.svg)](https://www.npmjs.com/package/toolnet-api)

## Features

- **Full Terminal TUI**: Fast, responsive raw-mode terminal interface compatible with mobile SSH (Termius) & modern ANSI terminals.
- **3 Sandbox Modes (`workspace` | `ask` | `full-access`)**: Path traversal protection, realpath symlink escape prevention, and modal approval for dangerous shell commands or out-of-workspace file actions.
- **Structured Patching & Undo (`apply_patch`)**: Unified diff parsing and application. 100% undoable via `/undo`.
- **Vision Model & Attachment Support (`@file`, `/attach`)**: Attach images (`.png`, `.jpg`, `.webp`) or text files. Automatically converts images to base64 Data URLs for GPT-4o, Claude 3.5, Gemini 1.5, etc.
- **Context Compaction (`/compact`)**: Automatic and manual summarization of long conversation turns at 75% threshold (~23k tokens), preserving system prompts, structured history summary, and active working state.
- **Optional Browser Automation (`browser`)**: Lazy-loaded Playwright/Chromium integration for JS rendering, clicking elements, filling forms, and screenshots.
- **Non-Interactive CI Mode (`-p "prompt"`)**: Execute prompts non-interactively in shell scripts & CI with optional `--json` output.
- **Diagnostics & Health (`/doctor`, `/update`)**: Instant system diagnostics, environment checks, and npm registry update checker.

## Quick Start

### Installation

```bash
npm install -g toolnet-api
```

### Usage

```bash
# Interactive TUI Mode
toolnet

# Non-Interactive Mode (for scripts & CI)
toolnet -p "Fix the login bug in src/auth.ts" --json

# Diagnostic Check
toolnet /doctor
```

## CLI Flags

| Flag | Description |
| --- | --- |
| `-p, --prompt <text>` | Run prompt non-interactively and exit |
| `-s, --simple` | Run lightweight REPL interface |
| `-v, --version` | Print CLI version information |
| `-h, --help` | Print help documentation |
| `--no-splash` | Skip TUI splash screen animation |
| `--verbose` | Enable debug logging |
| `--json` | Format non-interactive `-p` output as JSON |

## Slash Commands

| Command | Description |
| --- | --- |
| `/sandbox [mode]` | View or switch sandbox mode (`workspace`, `ask`, `full-access`) |
| `/compact` | Compact conversation history to free context window space |
| `/attach <path>` | Attach a file or screenshot image to the conversation |
| `/doctor` | Run system health checks & environment diagnostics |
| `/update` | Check npm registry for CLI updates |
| `/session [name]` | Manage or switch disk-backed session state |
| `/undo` | Undo the last file modification made by ToolNet |
| `/redo` | Redo the last undone file modification |
| `/exit` | Exit the CLI application |

## Architecture

- **Engine**: Native Bun & Node.js cross-runtime launcher with PATH preservation (`bin/toolnet.js`).
- **Permissions**: `lib/permissions.ts` enforcing strict workspace boundaries & dangerous shell command detection.
- **Sessions**: Disk-backed sessions persisted at `~/.toolnetapi/sessions/*.json`.

## License

MIT © [LBT-AI](https://github.com/LBT-AI)
