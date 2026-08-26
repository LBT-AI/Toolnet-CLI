<div align="center">

# ⚡ ToolNet CLI

### *The Autonomous Multi-Agent Terminal AI Coding Assistant*

[![npm version](https://img.shields.io/npm/v/toolnetcli.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/toolnetcli)
[![license](https://img.shields.io/npm/l/toolnetcli.svg?style=flat-square&color=green)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg?style=flat-square)](https://nodejs.org)
[![bun](https://img.shields.io/badge/bun-%3E%3D1.1.0-orange.svg?style=flat-square)](https://bun.sh)
[![tests](https://img.shields.io/badge/tests-271%20passing-success.svg?style=flat-square)](https://github.com/LBT-AI/Toolnet-CLI)

**ToolNet CLI** is a next-generation, high-performance terminal coding assistant engineered for developers, devops, and agentic workflows. Built on the **Unified AgentHarness 2.0** architecture, it unifies interactive terminal streaming, autonomous multi-agent task graphs (DAG), role-based sub-agent delegation, intelligent context compaction, and multi-tier security sandboxing into a single developer tool.

[Quick Start](#-quick-start) • [Architecture](#-architecture) • [Features](#-core-features) • [Slash Commands](#-slash-commands) • [Keybindings](#-interactive-keybindings) • [Security 2.0](#-security--permissions-20)

---

</div>

## 🌟 Core Features

- **⚙️ Unified AgentHarness 2.0 Kernel**: Central execution engine coordinating Context, Security, Tool Registry, MCP Gateway, and Session Persistence across all runtime modes.
- **🤖 Real Sub-Agent Execution Engine**: Autonomous child agent loop with specialized personas (`RESEARCHER`, `CODER`, `TESTER`, `REVIEWER`, `ARCHITECT`, `GENERAL`), role-based tool filtering, and dependency chaining.
- **🧠 Unified Context Management Engine**: Exact token estimation across model families, automatic bulky tool output pruning, atomic turn compaction (preserving `assistant.tool_calls` and `role: "tool"` pairs), and persistent session memory.
- **🛡️ Security & Permissions 2.0 (SecretGuard)**: 5-tier semantic command risk classification (`CRITICAL_DENY`, `DANGEROUS`, `SAFE_BUILD`, `SAFE_READ`, `MODERATE_WRITE`), sensitive file shielding (`.env*`, `.ssh`, `.aws`, `.npmrc`), and smart session trust (`[A] Allow for Session`).
- **🖥️ Native ANSI Full-Screen TUI**: Zero-dependency TUI compatible with Termius, mobile SSH, tmux, and all standard terminal emulators. Supports bracketed paste, streaming markdown rendering, and live tool status indicators.
- **🔌 Model Context Protocol (MCP)**: Seamless integration with local and remote MCP servers via stdio and SSE.
- **⚡ Multiple Execution Strategies**:
  - **Interactive TUI**: Live conversational pairing with streaming responses.
  - **Headless Prompt (`-p`)**: Single-pass execution for scripts, CI/CD, and pipelines with optional `--json` output.
  - **Turbo Mode**: Ultra low-latency single-pass resolution for localized micro-tasks.
  - **Teamwork DAG Orchestrator**: Dynamic task graph decomposition executing multi-agent DAGs concurrently.

---

## 🚀 Quick Start

### Installation

#### macOS / Linux (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/LBT-AI/Toolnet-CLI/main/install.sh | sh
```

This downloads a standalone binary — no Bun or Node.js required.

#### npm

```bash
npm install -g toolnetcli@latest
```

#### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/LBT-AI/Toolnet-CLI/main/install.ps1 | iex
```

#### Homebrew

```bash
brew install lbt-ai/tap/toolnet
```

#### Scoop (Windows)

```bash
scoop install toolnet
```

> **Note:** Homebrew and Scoop packages are coming soon.

### Uninstall

```bash
# Binary install
rm /usr/local/bin/toolnet  # or ~/.local/bin/toolnet

# npm install
npm uninstall -g toolnetcli

# Homebrew
brew uninstall toolnet

# Scoop
scoop uninstall toolnet
```

### Launching Interactive Mode

```bash
# Launch interactive TUI in the current workspace
toolnet

# Resume the most recent session
toolnet --resume

# Load a specific session ID
toolnet --session sess_12345
```

### Non-Interactive (Headless) Mode

```bash
# Run a single query directly from CLI / scripts
toolnet -p "Audit this repository for security vulnerabilities and summarize dependencies"

# Structured JSON output for CI/CD automation
toolnet -p "Check for TypeScript errors in src/" --json
```

---

## 🏗️ Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        UNIFIED AGENT HARNESS 2.0                           │
│                 (Master Execution Kernel & Orchestration)                  │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  [Runtime Context]        [Core Subsystems]        [Execution Modes]       │
│  ├── Workspace & Root     ├── Context Engine       ├── Interactive (TUI)   │
│  ├── Session Persistence  ├── Security 2.0 Guard   ├── Headless (-p)       │
│  ├── Model Gateway        ├── Tool Registry & MCP  ├── Turbo Single-Pass   │
│  └── Framework Detector   └── EventBus Telemetry   └── Teamwork DAG        │
│                                                                            │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │
           ┌──────────────────────────┴──────────────────────────┐
           ▼                                                     ▼
┌──────────────────────────────┐              ┌──────────────────────────────┐
│       MAIN AGENT RUNTIME     │              │    SUB-AGENT RUNTIME ENGINE  │
│  • Autonomous Tool Loop      │─── delegates ├── Researcher (Read/Grep/Web) │
│  • Interactive Streaming     │     via      ├── Coder (Write/Patch/Edit)   │
│  • Multi-turn Session Flow   │ spawn_agent  ├── Tester (Test/Diagnostics)  │
│  • Atomic Compactor          │              ├── Reviewer (Diff/Security)   │
└──────────────────────────────┘              └──────────────────────────────┘
```

---

## ⌨️ Interactive Keybindings

| Keybinding | Action | Description |
| :--- | :--- | :--- |
| <kbd>Enter</kbd> | **Send Message** | Submits your prompt to the active agent |
| <kbd>Tab</kbd> | **Toggle Mode** | Switches between **Build** mode (code execution) and **Plan** mode (read-only planning) |
| <kbd>Ctrl+K</kbd> | **Switch Model** | Opens the interactive model & provider picker |
| <kbd>Ctrl+C</kbd> | **Cancel / Exit** | Aborts the active generation or exits the TUI |
| <kbd>Ctrl+L</kbd> | **Clear Screen** | Clears the terminal screen buffer |
| <kbd>PageUp</kbd> / <kbd>PageDown</kbd> | **Scroll Chat** | Navigates through long conversation history |

---

## 💬 Slash Commands

| Command | Aliases | Description |
| :--- | :--- | :--- |
| `/harness` | `/kernel`, `/sys` | Displays Unified AgentHarness status, active subsystems, framework detection, and token telemetry |
| `/subagent [role] <task>` | `/sub`, `/agent` | Spawns a dedicated subagent (`RESEARCHER`, `CODER`, `TESTER`, `REVIEWER`, `ARCHITECT`) |
| `/sandbox [mode]` | `/sb` | Inspects or sets sandbox mode (`workspace`, `ask`, `full-access`, or `clear` session rules) |
| `/compact` | `/compress` | Triggers atomic context compaction and displays context token budget utilization |
| `/status` | `/st` | Checks ToolNet API Gateway connectivity, active providers, and tunnels |
| `/model [name]` | `/m` | Switches the active language model or lists available models |
| `/teamwork <prompt>` | `/tw` | Decomposes a complex objective into an autonomous DAG task graph |
| `/tools` | — | Lists all available tools, file operations, and execution permissions |
| `/mcp` | — | Manages Model Context Protocol (MCP) servers and client tools |
| `/skills` | — | Lists locally installed project skills and extensions |
| `/session [list\|new\|switch]` | — | Manages multi-session persistence and history switching |
| `/undo` / `/redo` | — | Reverts or reapplies file changes made by surgical patch tools |
| `/qa <prompt>` | — | Runs autonomous automated QA and test suite diagnostics |
| `/doctor` | — | Runs local diagnostic checks on environment, tools, and connectivity |
| `/update` | — | Checks for ToolNet CLI updates on npm |

---

## 🛡️ Security & Permissions 2.0

ToolNet CLI includes an enterprise-grade, multi-layered security engine to keep your machine safe:

```
[Tool Call Request]
        │
        ▼
[SecretGuard] ───► Is sensitive file (.env, id_rsa, .npmrc, ~/.ssh)? ──► BLOCK in workspace mode
        │
        ▼
[Semantic Command Classifier] ───► Evaluate Shell AST (CRITICAL_DENY / DANGEROUS / SAFE)
        │
        ▼
[Session Trust Manager] ───► Was this tool/command allowed for the session? ──► ALLOW
        │
        ▼
[Interactive Approval Modal] ──► [Y] Once   [A] Allow for Session   [N] Deny
        │
        ▼
[Audit Logger] ───► Log structured JSONL event to .logs/security-audit.jsonl
```

### Sandbox Modes
- **`workspace` (Default)**: Restricts read/write operations strictly within the project workspace root. Blocks access to credential files (`.env*`, `id_rsa*`) and dangerous shell commands (`rm -rf /`, `mkfs`).
- **`ask`**: Prompts the user interactively before executing sensitive file operations or dangerous commands.
- **`full-access`**: Unrestricted execution mode for automated containerized CI/CD environments.

---

## 📂 Configuration & Storage

| Path | Purpose |
| :--- | :--- |
| `~/.toolnetcli/sessions/` | Saved JSON session histories and message turns |
| `~/.toolnetapi/config.json` | Global CLI preferences (default model, base URL, theme) |
| `.toolnet/permissions.json` | Project-specific workspace security policy |
| `.logs/security-audit.jsonl` | Structured security evaluation audit log |

### Environment Variables
- `TOOLNETCLI_SESSIONS_DIR`: Custom path for session storage.
- `TOOLNET_API_URL`: Custom Gateway endpoint URL (default: `http://127.0.0.1:20127`).
- `TOOLNET_DEBUG`: Set to `1` to enable verbose debugging logs.

---

## 🛠️ Development & Testing

```bash
# Clone repository
git clone https://github.com/LBT-AI/Toolnet-CLI.git
cd Toolnet-CLI

# Install dependencies
bun install

# Typecheck
bun run typecheck

# Run comprehensive test suite (271 tests)
bun test

# Build production bundles (Bun & Node.js)
bun run build
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

---

<div align="center">
  <b>Built with ❤️ by the <a href="https://github.com/LBT-AI">LBT-AI Team</a></b>
</div>
