# Changelog
All notable changes to ToolNet CLI will be documented here.
The project follows Semantic Versioning.

## [1.1.0] - 2026-08-30
### Added
- **Native Anthropic Messages API Adapter (`src/providers/anthropic.ts`)**: Direct integration with `/v1/messages`, multi-turn tool calling, SSE streaming (`content_block_delta`), and `x-api-key` header handling.
- **Native Google Gemini REST & SSE Adapter (`src/providers/gemini.ts`)**: Direct integration with Gemini `/v1beta/models` endpoint, function declarations, and streaming chunk translation.
- **Multi-Provider Factory & Event Bus**: Hot provider switching with event bus listeners without process restarts or circular dependency hacks.
- **Interactive TUI Overlays**:
  - Model Picker (`/model`) interactive keyboard navigation.
  - Dedicated API Key Manager (`/key`) with masked key visualization, safe in-memory credential update, and confirmation dialogs.
- **Terminal Resize Lifecycle Engine**: Debounced `SIGWINCH` resize handler for smooth, flicker-free terminal reflows.
- **Interactive Commands**: `/search` (grep through conversation history), `/policy` (inspect & initialize workspace security policies), `/export` (export to markdown, HTML, or JSON).
- **Subagent Custom Personas**: Support for loading user-defined roles from `.toolnet/personas.json`.
- **Automated Multi-Platform Release CI/CD**: GitHub Actions release workflow for Linux, macOS, and Windows standalone executables.

### Changed
- Refactored slash command dispatcher with `buildTuiCommandContext()` factory and strict guard clauses.
- Added exponential backoff retry on HTTP `429` (Rate Limited) and `503` (Service Unavailable).
- Comprehensive unit test coverage expanded to 491 tests across 51 test suites (100% pass).

## [1.0.5] - 2026-08-17
### Added
- **Bypass & Jailbreak Engine 2.0 (`src/lib/bypass/`)**:
  - Expanded 10-level matrix with dedicated high-potency frameworks: `godmode` (Omnipotent Root), `devmode` (Developer Mode v2), `cybersec` (Offensive Security & Red Teaming), `chad-ultra`, `ultra`, `chad`, `chad-lite`, `full`, `lite`, `raw`, and `custom`.
  - **Multi-Language Anti-Refusal Interceptor**: Real-time heuristic detection of refusal patterns in English, Vietnamese, and Chinese.
  - **Auto-Escalation & Recovery Engine**: Automatically detects AI safety refusals ("I cannot...", "Tôi không thể...") and escalates bypass potency to re-generate the answer unconditionally.
  - **CLI Flags Support**: Added `--bypass [level]` and `-b [level]` command-line flags.
  - **REPL & TUI Integration**: Dynamic prompt badges (`[Bypass:GODMODE]`), persistent configuration storage (`~/.toolnetcli/bypass-config.json`), and `/bypass levels`, `/bypass retry`, `/bypass force` subcommands.

## [1.0.4] - 2026-08-17
### Added
- **Dual Binary Aliases**: Added `toolnetcli` alias alongside `toolnet` in package `bin` config for global execution.
- **Robust Argument Parsing**: Fixed CLI flag value handling in workspace detector (`initWorkspace`) to prevent capturing prompt or model flags as workspace targets.

## [1.0.3] - 2026-08-17
### Added
- **Alibaba Cloud / DashScope / Qwen Support**: Integrated Alibaba Cloud provider key management with auto-routing for `alibaba/*`, `dashscope/*`, and `qwen/*` model families.
- **Dedicated Key Management Command (`/key`)**: Interactive `/key` command to inspect, set, list (masked), and delete API keys for all supported providers (`alibaba`, `openai`, `anthropic`, `gemini`, `deepseek`, `groq`, `together`, `mistral`, `xai`, `minimax`, `cohere`).
- **Expanded ProviderPicker**: Added Alibaba, Together AI, Mistral, and xAI directly to the interactive TUI provider picker modal.
- **Environment Variable Fallback**: Auto-discovery of `DASHSCOPE_API_KEY`, `ALIBABA_API_KEY`, `QWEN_API_KEY`, and provider aliases.

## [1.0.2] - 2026-08-17
### Added
- **Unified AgentHarness 2.0**: Centralized execution kernel and lifecycle coordinator unifying Context, Security, Tools, Persistence, and Telemetry across Interactive, Headless, Turbo, and Teamwork modes.
- **Unified Context Engine**: Accurate token estimation, model context budgeting, automatic bulky tool pruning, atomic turn compaction preserving `tool_calls` and `role:tool` pairs, and session memory store.
- **Security & Permissions 2.0**: SecretGuard file protection and token redaction, 5-tier semantic command classifier, smart session trust (`[A] Allow for Session`), workspace policy file `.toolnet/permissions.json`, and structured audit logging.
- **Real Sub-Agent Execution Engine**: Autonomous child agent runtime with specialized personas (`RESEARCHER`, `CODER`, `TESTER`, `REVIEWER`, `ARCHITECT`, `GENERAL`), role-based tool filtering, infinite loop detection, and dependency context injection.
- **New Interactive Commands**: `/harness` (system status and telemetry snapshot), `/subagent` (direct specialized subagent dispatch).
- **Sub-Agent Delegation Tool**: `spawn_subagent` tool allowing Main Agent to delegate tasks autonomously.

### Changed
- Default sessions directory updated to `~/.toolnetcli/sessions` with backward-compatible fallback to `~/.toolnetapi/sessions`.
- Replaced mock worker in DynamicScheduler with live subagent execution loop.

## [1.0.1] - 2026-08-17
### Added
- Release preparation and npm package distribution.

## [1.0.0] - 2026-08-11
### Added
- Standalone ToolNet CLI repository
- Interactive terminal UI
- Coding agent runtime
- Build and Plan modes
- Workspace sandbox and permission system
- Session persistence
- Context compaction
- File and image attachments
- Structured patch application
- Git status and diff tools
- Web fetch
- Optional browser automation
- MCP integration
- Teamwork and sub-agent support
- Non-interactive prompt mode
- Bun build
- Node.js fallback build
- GitHub Actions CI
- Gateway unit tests
- Issue templates
- Contribution guidelines
### Changed
- ToolNet CLI separated from the ToolNet API repository
- Repository metadata now points to LBT-AI/Toolnet-CLI

[Unreleased]: https://github.com/LBT-AI/Toolnet-CLI/compare/v1.0.5...HEAD
[1.0.5]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.5
[1.0.4]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.4
[1.0.3]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.3
[1.0.2]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.2
[1.0.1]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.1
[1.0.0]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.0
