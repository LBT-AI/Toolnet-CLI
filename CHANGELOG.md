# Changelog
All notable changes to ToolNet CLI will be documented here.
The project follows Semantic Versioning.

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

[1.0.4]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.4
[1.0.3]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.3
[1.0.2]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.2
[1.0.1]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.1
[1.0.0]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.0
