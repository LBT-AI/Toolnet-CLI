# Changelog

## [1.4.0] - 2026-09-29
### Added
- **Adaptive turn budget**: long, genuinely progressing tasks now extend the soft turn budget in bounded chunks instead of dying at a fixed count, with a no-progress guard, an equivalent-failure loop guard and a hard safety cap.
- **Structured error-driven recovery**: tool failures now carry machine-readable structured errors and a bounded, code-driven recovery policy (alternate tool, changed strategy, replan, or a deliberate stop) — never an unbounded retry loop.
- **Durable session steer / continuation**: a follow-up submitted while a task is running is admitted as a session steer, promoted exactly once at the next turn boundary, and survives a crash via the session journal.
- **Release hardening**: cross-platform CI, pinned Bun/Node toolchain, a tracked-file secret scan, reproducible binary builds with checksums, and a deterministic installer smoke test.

### Fixed
- **Tool-result correlation**: out-of-order and same-name tool results are matched by call id (never by position or name), including the streaming transcript reconciler.
- **Browser capability**: the `browser` tool is only offered when a real Chromium/Playwright runtime is available; otherwise it returns a `TOOL_UNAVAILABLE` error that the recovery policy can route around.
- **Web fetch resilience**: timeouts, transient network errors and HTTP status classes are classified deterministically; 4xx is never blindly retried and recovery is bounded.
- **Read/file ergonomics**: `read_file` on a directory now suggests and recovers with `list_dir`.
- **Security usability (false positives)**: safe `php -r` read-only inspection and `2>/dev/null` redirections are no longer blocked, while destructive inline payloads and protected-path writes stay denied.
- **Session/steer lifecycle**: removed the empty-prompt continuation and the completion-boundary timers; one foreground request runs at a time, a failed run never settles as done, cancellation can no longer be resurrected by a late provider success, and a crashed run now resumes as `interrupted` with no destructive tool replay.
- **Installer correctness**: a successful `install.sh` run no longer exits non-zero from an EXIT-trap unbound-variable error, and the Windows archive/member naming now matches `install.ps1` and the Scoop manifest.

### Changed
- Pinned the supported toolchain: Bun `1.4.0`, Node `22` (Node `>=20` supported). CI runs on Ubuntu, macOS and Windows and executes real CLI smoke tests.
- `node-pty` is now a declared dev dependency so the PTY acceptance suites are reproducibly provisioned; they skip explicitly (never silently pass) when unavailable or off-POSIX.
- Removed generated runtime/emulator state from version control and added `.gitignore` rules for `.wrangler/`, SQLite `-shm`/`-wal` files and release archives.

## [1.3.0] - 2026-09-27
### Added
- Added ToolNet Skills as the default built-in MCP server for immediate usability without configuration.
- Added provider routing intelligence with fallback mechanisms.
- Render structured file-mutation diffs in the TUI for clearer code review.
- Show live long-running tool activity and unify semantic terminal colors.
- Allow TUI to admit BUSY follow-ups as session steers at the next turn boundary.
- Support durable session titles and auto-title on the first real task.
- Collapse long pastes in the composer to avoid flooding the terminal frame.

### Changed
- Improved context engine with a token budgeting compaction as a lossy, per-model checkpoint.
- Hardened security and test environment isolation (reset policy engine, isolate session state).
- Improved terminal interface reliability: anchored cursor correctly, stabilized viewport under live updates, fixed mobile IME input for Vietnamese text, and parsed inline markdown.
- Standardized and extended model provider support (added default models like agnes-2.0-flash, bob/fast, bob/rnj-1-test).
- Improved cross-harness compatibility and environment isolation for testing.

All notable changes to ToolNet CLI will be documented here.
The project follows Semantic Versioning.

## [1.2.3] - 2026-09-10
### Added
- **Reasoning controls**: `/reasoning` command (`auto|low|medium|high|off`) to configure reasoning/thinking effort, with a collapsible Thinking panel showing effort, elapsed time and token usage. Models without configurable reasoning ignore the setting.
- **Conversation language handling**: automatic detection of Vietnamese / Chinese / English with support for explicit language requests, so replies match the user's language throughout a session.
### Changed
- **Slash command palette redesign**: full-width sheet layout, realtime filtering by name and description, complete keyboard navigation (arrows, Ctrl+P/N, PgUp/PgDn, Home/End, wrap-around) and correct rendering on narrow terminals.
### Removed
- Legacy banner, boot-animation and mascot modules superseded by the consolidated banner implementation.

## [1.2.2] - 2026-09-06
### Packaging
- Clean npm installation dependency graph: no ERESOLVE, conflicting peer, or deprecated dependency warnings on fresh production install.
- Removed conflicting OpenTUI peer dependencies (`@opentui/keymap`, `opentui-spinner`) not used by ToolNet.
- Removed deprecated transitive `glob@9.3.5` by resolving `babel-plugin-module-resolver` against non-deprecated `glob@13`.
- Single CLI command: `toolnet` (removed `toolnetcli` binary alias; npm package name remains `toolnetcli`).
- First-install packaging fixes.

## [1.2.1] - 2026-09-05
### Security / Execution
- Routed model-callable tool execution through the ToolGateway chokepoint, with approval/session-trust handling, shell environment and working-directory scrubbing, process-tree hardening, and convergent critical-deny enforcement.
### Teamwork
- Replaced fake worker success with structured worker results, enforced budgets and dependency correctness, and hardened retry/concurrency behavior.
### MCP
- Added trust gating, namespace isolation, secret-free child environments, timeout/output caps, and lifecycle cleanup for local MCP execution. Remote HTTP/SSE MCP remains unsupported.
### State
- Standardized persistent state on `~/.toolnetcli`, with legacy-state migration while retaining project-local `.toolnet` data.
### Context
- Added per-session isolation, protection against late asynchronous completions, provider-compatible compaction, and improved token accounting.
### Final hardening
- Added `safeFetch` redaction, expanded red-team coverage, strengthened audit integrity, and verified package/clean-HOME smoke paths.

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

[Unreleased]: https://github.com/LBT-AI/Toolnet-CLI/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.2.1
[1.1.0]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.1.0
[1.0.4]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.4
[1.0.3]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.3
[1.0.2]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.2
[1.0.1]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.1
[1.0.0]: https://github.com/LBT-AI/Toolnet-CLI/releases/tag/v1.0.0
