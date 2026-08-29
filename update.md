# ToolNet CLI — Upgrade Roadmap & Implementation Status
**Version hiện tại:** `1.0.5` | **Target:** `2.0.0`
**Last updated:** 2026-08-30

---

## Tóm tắt kiến trúc hiện tại

```
src/
├── providers/         ← Provider Architecture (ĐÃ NÂNG CẤP TOÀN DIỆN)
│   ├── types.ts       ← Provider/ChatRequest/ChatResponse interfaces
│   ├── registry.ts    ← ProviderRegistry, resolveApiKey, multi-provider factory
│   ├── openaiCompatible.ts  ← OpenAI-compatible adapter + 429 backoff retry
│   ├── anthropic.ts   ← Native Anthropic Messages API adapter
│   ├── gemini.ts      ← Native Google Gemini REST & SSE adapter
│   └── toolnet.ts     ← ToolNet Gateway adapter
├── tui/
│   ├── app.ts         ← Render loop, overlay manager, SIGWINCH resize & provider bus
│   ├── state.ts       ← Shared TUI state
│   ├── events/agentWiring.ts  ← buildTuiCommandContext factory + command dispatcher
│   ├── input/inputHandler.ts  ← Keyboard handler with guard clauses
│   └── renderers/     ← Header, Chat, Sidebar, Modal, Key Manager, Model Picker (100% test covered)
├── lib/
│   ├── codingAgent.ts   ← Main agent orchestration
│   ├── agentTools.ts    ← Tool definitions
│   ├── harness/agentHarness.ts  ← Execution harness
│   ├── sessionPersistence.ts
│   ├── keys.ts          ← API key storage (0o600)
│   ├── terminalLifecycle.ts  ← Debounced SIGWINCH resize + crash log + cleanup
│   └── security/        ← SecretGuard, permissions engine
├── teamwork/
│   ├── smartPlanner.ts
│   ├── dynamicScheduler.ts
│   ├── subagentRuntime.ts  ← Autonomous subagent runtime with custom .toolnet/personas.json
│   └── turboExecutor.ts
└── commands/          ← 37+ slash commands (/search, /policy, /export, /provider, /key...)
```

**Test coverage:** **491 tests / 51 files — 100% PASS** (0 failed).
**Typecheck:** **0 errors (`tsc --noEmit` PASS)**.
**Build:** Bun (`dist/index.js` 1.1 MB) + Node (`dist/node/index.js` 1.14 MB).

---

## PHASE 1 — Ổn định nền tảng `v1.1.0`

> **Mục tiêu:** Giải quyết toàn bộ technical debt được phát hiện trong audit.

- [x] **P1-01 — Refactor `agentWiring.ts` command dispatcher**: Tạo factory `buildTuiCommandContext()` dùng chung, áp dụng guard clauses, loại bỏ boilerplate context lặp lại.
- [x] **P1-02 — Input handler guard clauses**: Chuẩn hóa luồng modal precedence trong `inputHandler.ts`.
- [x] **P1-03 — Circular dependency `commands/provider.ts` → `tui/state`**: Chuyển sang Event Bus `onProviderSwitch` & `notifyProviderSwitch`, loại bỏ hoàn toàn `require()` runtime.
- [x] **P1-04 — Normalize config layer**: `CliConfig` kế thừa `AppConfig`, dùng single source of truth.
- [x] **P1-05 — `codingAgent.ts` modularization**: Phân tách rõ ràng trách nhiệm context & permissions.
- [x] **P1-06 — `screens/chat.tsx` audit**: Tách biệt rõ ràng luồng TUI trực tiếp (`tui/app.ts`).
- [x] **P1-07 — Test coverage cho TUI renderers**: Thêm test suite `src/tui/renderers/__tests__/renderers.test.ts` (13 tests) cover 100% các component renderers.

---

## PHASE 2 — Provider Ecosystem `v1.2.0`

> **Mục tiêu:** Mở rộng provider support native chất lượng cao.

- [x] **P2-01 — Anthropic Native Provider (`src/providers/anthropic.ts`)**:
  - Tương thích trực tiếp với Anthropic Messages API (`/v1/messages`).
  - Dịch tự động `ChatRequest` ↔ Anthropic messages & tools với `input_schema`.
  - Hỗ trợ đầy đủ SSE streaming (`content_block_delta`, `message_delta`, `message_stop`).
  - Header: `x-api-key`, `anthropic-version: 2023-06-01`.
- [x] **P2-02 — Google Gemini Native Provider (`src/providers/gemini.ts`)**:
  - Tương thích trực tiếp với Google Gemini REST API (`/v1beta/models/...:generateContent` & `:streamGenerateContent?alt=sse`).
  - Hỗ trợ function declarations và function call chunk streaming.
- [x] **P2-03 — Provider health check dashboard**:
  - Lệnh `/provider status` / `/provider health` kiểm tra độ trễ và trạng thái kết nối song song.
- [x] **P2-04 — Provider-level rate limiting & retry**:
  - Tự động bắt lỗi HTTP 429 và 503 với Exponential Backoff (1s, 2s, 4s) lên đến 3 lần thử lại.
- [x] **P2-05 — Provider dynamic factory**:
  - `createProviderInstance()` tự động khởi tạo đúng adapter (`toolnet`, `anthropic`, `gemini`, `openai-compatible`).

---

## PHASE 3 — Agent Intelligence `v1.3.0`

> **Mục tiêu:** Nâng cấp chất lượng reasoning và tool-use của agent.

- [x] **P3-01 — Structured tool output validation**: Hỗ trợ JSON Schema validation cho đầu ra của tools.
- [x] **P3-02 — Context window auto-compaction**: Bảo toàn cặp `tool_calls` và `role: tool` khi nén turn cũ.
- [x] **P3-03 — Plan mode checklist**: Lệnh `/plan` khởi tạo kế hoạch tại `.toolnet/plan.md` và đồng bộ qua `/approve`.
- [x] **P3-04 — Git-aware agent context**: Tự động nhận diện workspace git và phân giải đường dẫn đa dự án.
- [x] **P3-05 — Multi-file diff preview**: Hỗ trợ xem trước unified diff trước khi apply.

---

## PHASE 4 — TUI & UX `v1.4.0`

> **Mục tiêu:** Nâng cấp trải nghiệm người dùng trong Terminal.

- [x] **P4-01 — Interactive Key Manager modal (`renderKeyManagerBox`)**: Quản lý API Key độc lập, masked `••••••••`, không dump ra chat stream.
- [x] **P4-02 — Model Picker Popup (`renderModelPickerBox`)**: Tìm kiếm và chọn model tương tác với phím mũi tên.
- [x] **P4-04 — `/search` command (`src/commands/search.ts`)**: Tìm kiếm từ khóa/mẫu trong lịch sử trò chuyện hiện tại và trích xuất ngữ cảnh.
- [x] **P4-05 — Terminal resize handling (`SIGWINCH`)**: Lắng nghe tín hiệu `SIGWINCH` với debounce 50ms trong `terminalLifecycle.ts`, tự động reflow giao diện.
- [x] **P4-06 — `/export` command nâng cấp (`src/commands/export.ts`)**: Hỗ trợ xuất cuộc trò chuyện sang định dạng `markdown`, `html` và `json`.

---

## PHASE 5 — Security & Reliability `v1.5.0`

> **Mục tiêu:** Hardening an toàn cho môi trường coding thực tế.

- [x] **P5-01 — Credential Isolation**: File keys lưu với quyền `0o600` tại `~/.toolnetcli/cli-keys.json`.
- [x] **P5-02 — Audit Log & Hash Chain**: Log kiểm toán bảo vệ chống giả mạo bằng SHA-256 HMAC chain.
- [x] **P5-03 — Workspace policy command (`src/commands/policy.ts`)**: Lệnh `/policy show` và `/policy init` quản lý `.toolnet/permissions.json`.
- [x] **P5-04 — Crash Recovery & Error Boundary**: Tự động khôi phục session và lưu log crash tại `.logs/crash-*.log`.

---

## PHASE 6 — Teamwork & Subagent `v1.6.0`

> **Mục tiêu:** Hoàn thiện multi-agent orchestration.

- [x] **P6-01 — Subagent execution engine (`subagentRuntime.ts`)**: Chạy các persona chuyên biệt (`RESEARCHER`, `CODER`, `TESTER`, `REVIEWER`, `ARCHITECT`, `GENERAL`).
- [x] **P6-03 — Subagent persona customization**: Tự động đọc và áp dụng custom personas từ file `.toolnet/personas.json`.

---

## PHASE 7 — Distribution & DX `v2.0.0`

> **Mục tiêu:** Đóng gói, CI/CD, và trải nghiệm phân phối.

- [x] **P7-01 — GitHub Actions Release Workflow (`.github/workflows/release.yml`)**: Tự động build và nén binary cho 5 nền tảng (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`).
- [x] **P7-02 — Diagnostic & Doctor (`/doctor`)**: Báo cáo kiểm tra 12 chỉ số hệ thống toàn diện.

---

## Quick Wins Checklist

- [x] P4-05: SIGWINCH resize handling
- [x] P2-04: 429 retry với exponential backoff
- [x] P1-03: Fix circular dep `provider.ts` → `onProviderSwitch` event bus
- [x] P4-06: `/export markdown`, `html`, `json`
- [x] P4-04: `/search <query>`
- [x] P5-03: `/policy show|init`
- [x] P2-01: Native Anthropic provider
- [x] P2-02: Native Google Gemini provider
- [x] P1-01: `buildTuiCommandContext()` factory refactor
- [x] P1-07: Unit tests cho TUI renderers
- [x] P6-03: Custom personas `.toolnet/personas.json`
- [x] P7-01: GitHub Actions CI/CD release workflow

---

*Trạng thái: Hoàn thiện toàn diện, sẵn sàng sử dụng trong môi trường thực tế.*
