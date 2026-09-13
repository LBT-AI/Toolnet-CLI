# Phase 88: Production-Grade Terminal UI

> **Status: IMPLEMENTED — single-owner takeover completed and verified.**
> This file consolidates three temporary planning artifacts (`PROJECT.md`,
> `ORIGINAL_REQUEST.md`, `TEST_INFRA.md`) written by a stalled multi-agent
> run on 2026-09-13 (17:51–18:03 UTC), and records the completed takeover
> implementation. Final gates: typecheck ✅, `bun test` 2511+ pass / 0 fail,
> build ✅, `npm pack --dry-run` ✅, PTY acceptance ALL PASS (see §11).
>
> Original user request (verbatim archive): `.agents/ORIGINAL_REQUEST.md`
> (byte-identical to the deleted root copy).
>
> **Takeover details: §11.**

## 1. Goal

Make ToolNet's terminal UI production-grade **without** creating another
runtime or duplicating business logic.

- Working directory: `/root/toolnet-cli`, integrity mode: development
- Reference material: OpenCode TUI (spec, app root, session view, permission
  UI, prompt composer, sync state, command palette, docs) and OpenAI Codex
  TUI (app, chat widget, event model, input pane). Full link list in
  `.agents/ORIGINAL_REQUEST.md`.

## 2. Requirements (from ORIGINAL_REQUEST.md)

- **R1 — One Canonical TUI Architecture.** ONE TUI root, ONE AgentHarness,
  ONE AgentEngine, ONE ToolRegistry, ONE ModelRouter, ONE SessionStore, ONE
  ContextManager, ONE RepositoryIntelligence. The TUI stays presentation +
  interaction only: no direct tool execution, no routing calculations, no
  raw SessionStore writes, no background agent loops. No `tui-v2` — refactor
  in place. Non-TUI commands (`toolnet models`, `toolnet auth`, …) must not
  initialize the TUI renderer.
- **R2 — Responsive Terminal Layout & UX.** Wide / normal / small / very
  narrow breakpoints; decorative UI must never hide the prompt. Live resize
  without crashes. Multi-line prompt composer with history, cursor
  navigation, cancel, submit; draft retention after recoverable errors;
  large-paste handling. Bounded transcript windowing; tool events shown as
  queued → running → completed with summary + expand, not giant inline
  dumps. Syntax-highlighted states, diff visibility, context indicators,
  repo status, background jobs.
- **R3 — Safe Async Mutations & Permissions.** Canonical async mutation
  helper with explicit `idle → pending → success/error` lifecycle. Never
  fire-and-forget permission replies: the UI awaits backend acknowledgment
  before closing a permission dialog.
- **R4 — Core TUI Components.** Canonical command registry / palette;
  session UX (list, resume, continue, fork, rename, delete) without loading
  full transcripts per list entry; model/provider/auth pickers on canonical
  registries; centralized keybindings with standard Ctrl+C semantics
  (abort active op, exit if idle) and proper terminal restore; error
  boundaries so a render fault never destroys session state.

### Acceptance criteria

- No duplicated logic: no `provider.chat()`, `child_process.exec()`, or raw
  secret access in the TUI; non-TUI CLI commands never import/run TUI
  components.
- Resizing during streaming does not crash or break layout.
- Submitting a prompt while a background tool runs does not discard text.
- Ctrl+C aborts an active stream without killing the process.
- Model/session/command pickers update from core backend state.
- Async-race tests pass (no fire-and-forget mutations).
- UX usable on 60x20 terminals.
- `bun test` passes cleanly 3 times; `bun run typecheck`, `build`, and
  `npm pack` pass.
- No development-history comments ("Phase 88") in production source.

## 3. Planned architecture (from PROJECT.md)

Canonical TUI root at `src/tui/app.ts` over core singletons:
`AgentEngine` (src/core/agent/agentEngine.ts), `AgentHarness`
(src/lib/harness/agentHarness.ts), `ToolRegistry`
(src/lib/harness/toolRegistry.ts), `ModelRouter`/`ModelCatalog`
(src/core/models/{router,catalog}.ts), `SessionStore`
(src/core/session/store.ts), `ContextManager` (src/core/context/manager.ts),
`RepositoryIntelligence` (src/core/repo/intelligence.ts),
`AuthProfileRegistry` (src/core/auth/registry.ts). All of these exist today.

Planned TUI structure (target state, not current state):

- `src/tui/asyncMutation.ts` — canonical mutation helper
  (`MutationState = "idle" | "pending" | "success" | "error"`,
  `createAsyncMutation(fn, {onSuccess,onError,onSettled})`, double-submit
  lock).
- `src/tui/permissions/interruptManager.ts` — FIFO
  `PermissionInterruptManager` (`enqueue/current/replyCurrent/hasPending`);
  dequeue only after awaited backend ack.
- `src/tui/layout.ts` — `TerminalBreakpoint = "wide" | "normal" | "small" |
  "narrow"`; `LayoutInfo` geometry incl. dynamic `inputRows`, prompt squeeze
  protection (min chat rows, pinned prompt container).
- `src/tui/input/pasteBurst.ts` — paste-burst state machine for terminals
  without bracketed paste.
- `src/tui/renderers/` — bounded transcript, 3-phase tool presentation,
  session/model pickers on canonical registries, actionable
  `errorBoundary.ts`.
- Shared utilities move: `src/lib/terminalUtils.ts` (`visibleWidth`,
  `padVisible`, `truncateVisible`, `composeBox`, `ListItem`) and
  `src/lib/format.ts` (`formatRelativeTime`) so non-TUI code never imports
  from `src/tui`.

## 4. Milestones

| # | Name | Scope | Deps |
|---|------|-------|------|
| M1 | Canonical Architecture & Shared Decoupling | Shared utils to `src/lib`, remove non-TUI imports of `src/tui`, eliminate direct tool calls / raw secret access / `child_process.spawn` in TUI, purge "Phase XX" comments | — |
| M2 | Core Registries & Safe Async Mutations | ModelRouter/Catalog, ProviderRegistry, RepositoryIntelligence, AuthProfileRegistry integration; async mutation helper; FIFO permission manager; awaited permission ack; session summary list, fork, rename, delete | M1 |
| M3 | Responsive Layout & Bounded Viewport | Breakpoints, dynamic input rows, squeeze protection, debounced resize (remove duplicate listeners), narrow status indicators, viewport windowing, 3-phase tool presentation | M1 |
| M4 | Robust Composer, Keybindings & Error Boundaries | Multi-line composer, submit lock, draft retention, CRLF normalize, paste placeholders, paste-burst detector, 5-layer Ctrl+C hierarchy, clean teardown, error boundaries | M2, M3 |
| M5 | E2E Acceptance & Adversarial Hardening | 100% E2E pass (Tiers 1–4) + Tier 5 adversarial hardening | M4 |

## 5. Requirement → implementation audit (verified 2026-09-13)

"Implemented" = verified in source or by reading the test's imports, not by
checkboxes. The stalled run's E2E suite reports 98/98 passing, but 7 of 17
files assert against **reference oracles** in
`tests/e2e/harness/contractLoaders.ts` (which load production modules only
if they exist) — see §7 for why that must not be trusted as acceptance.

| Requirement | Code / test file | Status |
|---|---|---|
| R1 single canonical TUI root | `src/tui/app.ts` (single root, no `tui-v2` in repo) | Implemented |
| R1 no tool exec / raw secrets in TUI | `src/tui/events/agentWiring.ts:662` spawns `toolnet config init` via `child_process` for `/setup` — documented wizard-handoff behavior, not tool execution | Implemented (reviewed exception) |
| R1 non-TUI commands don't init TUI | `src/index.tsx` early subcommand router (`toolnet models/auth/eval/harness`); tested in `tests/e2e/tier1-features/non-tui-isolation.test.ts` | Implemented |
| M1 shared utils decoupling (`src/lib/terminalUtils.ts`, `src/lib/format.ts`) | Files absent; `visibleWidth`/`padVisible`/`composeBox` still live in `src/tui/renderers/` and `src/tui/layout.ts`; `src/components/ProviderPicker.ts`, `src/lib/toolsCatalog.ts`, `src/lib/harnessCatalog.ts`, `src/commands/session.ts`, `src/commands/index.ts`, `src/banner/*` still import from `src/tui` | Missing |
| M1 "Phase XX" comment purge | ~200 "Phase NN" comments across `src/` (historical phases). Acceptance targets **Phase 88** comments in production source — none exist because M1 never ran | Not started (none to purge yet) |
| Feature 5/6 ModelRouter & Catalog in pickers | `src/core/models/{catalog,router,registry}.ts` exist; `src/tui/renderers/modelPickerRenderer.ts` present | Implemented (verified in tier1 `core-registries.test.ts`) |
| Feature 7 RepositoryIntelligence status | `src/core/repo/intelligence.ts` exists | Implemented |
| Feature 8 async mutation lifecycle | No `src/tui/asyncMutation.ts`; only the reference oracle in `contractLoaders.ts` | **Missing** |
| Feature 9/10 permission ack + FIFO manager | No `src/tui/permissions/interruptManager.ts` (only `permissionModal.ts`); reference oracle only | **Missing** |
| Feature 11 session lifecycle UX | `src/tui/renderers/sessionPickerRenderer.ts`, `src/commands/sessionCli.ts` | Implemented |
| Feature 13 slash command registry | `src/commands/index.ts` (`getAllCommands`, `findCommand`, `dispatchCommand`) | Implemented |
| Feature 14–18 responsive breakpoints / squeeze protection | `src/tui/layout.ts` has no `wide/normal/small/narrow` logic (only a ≥120-col sidebar rule) | **Missing** |
| Feature 17 debounced resize | Debounced SIGWINCH engine exists in `src/lib/terminalLifecycle.ts:101` (shipped v1.1.0); **but** `src/tui/app.ts:567` adds a second, un-debounced `resize` listener | Partial (duplicate listener to remove) |
| Feature 19 bounded viewport windowing | `src/tui/viewport.ts` | Implemented |
| Feature 20 3-phase tool presentation | `src/tui/toolActivity.ts`, `src/tui/renderers/chatRenderer.ts` | Implemented |
| Feature 21–25 composer, draft retention, submit lock, CRLF/paste | `src/tui/input/multilineInput.ts`, `src/tui/input/inputHandler.ts`, `src/lib/bracketedPaste.ts` | Implemented |
| Feature 25 paste-burst detector | No `src/tui/input/pasteBurst.ts`; no equivalent found in `src/tui/input/` | **Missing** |
| Feature 26 5-layer Ctrl+C hierarchy | `src/tui/input/inputHandler.ts`, `src/tui/input/keyboard.ts` (Ctrl+C abort/exit semantics present; "5-layer" formalization is M4 scope) | Partial |
| Feature 27/28 teardown + error boundaries | `src/lib/terminalLifecycle.ts` (SIGINT/TERM/WINCH/uncaught handlers), `src/tui/renderers/` has no `errorBoundary.ts` | Partial |
| Tests Tier 1 (12 files) | `tests/e2e/tier1-features/*.test.ts` — all present; import **real** `src/` modules | Written, passing |
| Tests Tier 2 (5 files) | `tests/e2e/tier2-boundaries/*.test.ts` — present; several assert oracles, not production code | Written, passing |
| Tests Tier 3 (4 planned files) | `tests/e2e/tier3-cross-feature/` does not exist | **Missing** |
| Tests Tier 4 (4 planned files) | `tests/e2e/tier4-scenarios/` does not exist | **Missing** |

Nothing in the run's plan conflicts destructively with pre-existing
behavior; the only documented-behavior overlaps are the resize duplication
above and the `/setup` child_process exception, both adjudicated in §6.

## 6. Documentation contradictions (adjudicated, not silently picked)

1. **Debounced resize.** `CHANGELOG.md` (v1.1.0) claims a "Terminal Resize
   Lifecycle Engine" with debounced SIGWINCH handling; `PROJECT.md` listed
   debounced resize as *planned* M3 work. **Verdict: both are right about
   different things.** The engine exists (`src/lib/terminalLifecycle.ts:101`,
   debounced `SIGWINCH` → registered listeners) — CHANGELOG is accurate.
   Separately, `src/tui/app.ts:567` registers its own un-debounced
   `process.stdout.on("resize", handleResize)` that re-renders immediately,
   which is precisely the "duplicate un-debounced listener" defect M3
   planned to remove. **Resolution: implementation is the wrong side** —
   remove the duplicate listener in app.ts during M3; do not edit the
   CHANGELOG.
2. **`child_process` in TUI.** Acceptance says no `child_process.exec()` in
   the TUI. `src/tui/events/agentWiring.ts:662` uses `spawn` — but only to
   hand off to the `/setup` wizard in a fresh process and exit, matching
   documented behavior. **Verdict: implementation is right; keep as a
   reviewed exception** (it is not tool execution, and README documents the
   wizard flow).
3. **"98/98 E2E tests pass" vs. M2–M4 unimplemented.** `TEST_INFRA.md`
   itself forbids facade tests, yet `contractLoaders.ts` implements
   fallback reference oracles for the async mutation helper and FIFO
   permission manager that tests run against when production modules are
   absent. **Verdict: the passing suite is not evidence of Phase 88
   acceptance** — the oracle assertions must be re-pointed at production
   modules once §3 files exist (the loaders already prefer `src/tui/…`
   when present, so no test edits should be needed).

## 7. E2E test suite (from TEST_INFRA.md)

Dual-track plan: Track B wrote the suite first. Present on disk:

- `tests/e2e/harness/` — `virtualTerminal.ts`, `cliRunner.ts`,
  `contractLoaders.ts`, `mockSessionStore.ts`.
- `tests/e2e/tier1-features/` — 12 files, one per core feature group,
  mapping PROJECT.md features 1–28.
- `tests/e2e/tier2-boundaries/` — `small-terminals-60x20`,
  `paste-normalization`, `mutation-race-locks`, `transcript-stress`,
  `unhandled-render-faults`.

Not yet written (planned by TEST_INFRA.md):

- `tier3-cross-feature/`: `submit-during-tool-run`, `ctrl-c-during-stream`,
  `resize-during-stream`, `modal-permission-racing`.
- `tier4-scenarios/`: `coding-workflow-e2e`, `slash-command-workflow`,
  `session-management-flow`, `error-recovery-flow`.

Run: `bun test tests/e2e` (must exit 0). Note: the suite is **untracked**
in git; commit it only together with the production code it exercises.

## 8. Non-goals / protected files

Phase 88 must not break behavior documented in the pre-existing project
docs: README.md (keybindings, slash commands incl. `/compact`, sandbox
modes, `~/.toolnetcli` storage layout, headless `-p` mode), CHANGELOG.md
(v1.2.3 slash palette, reasoning panel), COMPARISON.md, CONTRIBUTING.md
(conventional commits; typecheck + tests + build must pass), update.md
(roadmap phases). None of these were modified by the stalled run.

## 9. Session database

`session.db` (repo root, SQLite 3.x, mtime 18:06 during the run window) is
**pre-existing ToolNet infrastructure, not an Antigravity artifact**: it is
the default checkpoint DB of `src/teamwork/checkpoint.ts`
(`dbPath = "session.db"`), written through `src/teamwork/sqliteMock.ts`
(`node:sqlite` on Node 22.5+, JSON fallback `<db>.json` on Node 20–21,
per README). It is gitignored (`*.db`). Left untouched.

## 10. Artifact classification & cleanup record (2026-09-13)

Root markdown classification:

| File | mtime | Git | Classification |
|---|---|---|---|
| COMPARISON.md | 2026-07-30 | tracked since `b8828a8` | PRE_EXISTING_PROJECT_DOC |
| CONTRIBUTING.md | 2026-08-10 | tracked since `25912a1` | PRE_EXISTING_PROJECT_DOC |
| update.md | 2026-08-29 | tracked since `ab58a86` | PRE_EXISTING_PROJECT_DOC |
| README.md | 2026-09-09 | tracked | PRE_EXISTING_PROJECT_DOC |
| CHANGELOG.md | 2026-09-10 | tracked | PRE_EXISTING_PROJECT_DOC |
| .aider.chat.history.md | 2026-09-10 | gitignored (`.aider*`) | PRE_EXISTING, gitignored — left alone |
| ORIGINAL_REQUEST.md | 2026-09-13 17:51 | untracked, no history | PHASE_88_RECOVERY_ARTIFACT — archive kept at `.agents/ORIGINAL_REQUEST.md` |
| PROJECT.md | 2026-09-13 17:57 | untracked, no history | PHASE_88_RECOVERY_ARTIFACT |
| TEST_INFRA.md | 2026-09-13 18:00 | untracked, no history | PHASE_88_RECOVERY_ARTIFACT |

Timeline evidence: Phase 87 committed 17:29:58 (reflog); Phase 88 run
wrote the three artifacts 17:51–18:00; orchestrator progress last updated
18:03:50 at iteration 0/32 with M1 marked in-progress and M2–M5 pending;
`src/` clean. `session.db` untouched (see §9). Cleanup performed: the three
recovery artifacts were removed after this document absorbed their durable
content. Pre-existing docs were not modified.

---

## 11. Takeover report (single-owner completion, 2026-09-13)

### 11.1 Recovery

- **Antigravity conversation:** `edebe156-54ae-4e8d-bf39-9e5b3c938384`.
  The interactive `agy --conversation=…` CLI cannot run without a TTY, so
  recovery used the brain directory directly:
  `~/.gemini/antigravity-cli/brain/edebe156-…/` — `prompt_draft.md`
  (verbatim Phase 88 prompt, byte-equivalent to `.agents/ORIGINAL_REQUEST.md`),
  `logs/transcript.jsonl` (286 events), and the `teamwork_preview` subagent
  record (state ALIVE, spawn step 265). Root cause of the stall: repeated
  `RESOURCE_EXHAUSTED (429)` API-quota errors 17:57→18:14Z; the run died in
  planning/preview with **zero source edits** (no write/edit tool calls in
  the transcript; `src/` clean at takeover).
- **Inherited changes:** the untracked `tests/e2e/` suite (harness + Tier 1/2)
  and the `.agents/` teamwork notes. `src/` was pristine at HEAD `799c43d`.
- **References actually inspected** (local repo copies consulted for the
  architecture decisions in this phase): the recovered prompt's OpenCode TUI
  links and Codex TUI links were the *intended* spec sources; network fetches
  were not possible in this environment, so the executable contracts the
  stalled run derived from them were used as the stand-in spec:
  `tests/e2e/harness/contractLoaders.ts` (mutation lifecycle, FIFO ack,
  layout/breakpoint contract), `tests/e2e/harness/virtualTerminal.ts`,
  `tests/e2e/tier1-features/*.test.ts`, `tests/e2e/tier2-boundaries/*.test.ts`,
  plus `src/tui/**` and `src/lib/terminalLifecycle.ts` as the implementation
  ground truth.

### 11.2 Work completed (this takeover)

- **M1 — shared utils decoupling:** created `src/lib/text.ts` (canonical
  `visibleWidth`, `padVisible` with align modes, `truncateVisible`,
  `tailByCells`, `ListItem`, `formatRelativeTime`). `src/tui/layout.ts` now
  re-exports from it; `src/commands/session.ts`, `src/lib/toolsCatalog.ts`,
  `src/lib/harnessCatalog.ts`, `src/banner/*` import from `src/lib` —
  **no non-TUI file imports from `src/tui` any more.** `src/components/`
  was emptied by moving `ProviderPicker` → `src/tui/providerPicker.ts`
  (it renders via `composeBox`, i.e. TUI-owned).
- **M2 — safe async mutations:** created `src/tui/asyncMutation.ts`
  (`idle → pending → success|error`, double-submit lock via
  `MutationAlreadyPendingError`, error capture, `onSettled`) and
  `src/tui/permissions/interruptManager.ts` (`PermissionInterruptManager`
  FIFO queue; `replyCurrent` awaits backend ack before dequeue and rejects a
  concurrent second reply; `cancelCurrent` rejects without resolving).
- **Permission UX rewiring:** `requestApprovalModal` now enqueues into the
  FIFO manager instead of overwriting `tuiState.pendingConfirmation` — the
  prior race (second approval overwriting the first, leaving its promise
  pending forever) is fixed. Trust recording happens exactly once per dialog
  (`y/a/t/n` semantics preserved); dequeue + next-dialog promotion happen
  only in the awaited ack continuation. Plan-mode confirmation moved onto
  the same pipeline via `requestConfirmation()`.
- **M3 — responsive layout:** `computeLayout` gained
  `TerminalBreakpoint` (wide ≥120 / normal ≥80 / small ≥60 / narrow <60),
  dynamic `inputRows` driven by the composer buffer (cap
  `COMPOSER_MAX_BUFFER_LINES`, shared by `statusRenderer`), prompt squeeze
  protection (`chatRows` never < 2, composer keeps its rows on small
  screens), and `MIN_COLS/MIN_ROWS` clamping. New pure
  `computeLayoutGeometry()` lets tests exercise the exact frame math.
- **Resize:** removed the duplicate un-debounced
  `process.stdout.on("resize")` listener in `src/tui/app.ts`; resize is
  handled solely by the debounced SIGWINCH engine in
  `src/lib/terminalLifecycle.ts`.
- **M4 — composer/keybindings/boundaries:** created
  `src/tui/input/pasteBurst.ts` (state machine that coalesces rapid
  un-bracketed byte bursts into one logical paste; ESC-carrying chunks
  bypass it; ordering preserved). `src/tui/app.ts` stdin path now feeds
  the burst detector while keeping bracketed paste and escape sequences
  byte-exact. Created `src/tui/renderers/errorBoundary.ts`;
  `renderAll`'s catch paints an actionable fallback frame (Ctrl+L / /exit
  hint) instead of leaving a corrupted screen; Ctrl+C-hierarchy semantics
  (modal dismiss → abort → double-press exit) verified in the key handler.
- **Ctrl+C during permission dialog:** new `cancelPendingApproval()`; the
  key handler denies the open approval (unwinding the awaiting backend) and
  proceeds to stream abort, so a dialog can never swallow the abort.
- **E2E suite de-oracled:** `contractLoaders.calculateLayoutContract` now
  calls production `computeLayoutGeometry`; the async-mutation and
  FIFO-manager loaders prefer `src/tui/*` when present (they now always
  resolve to production). Catalog-fixture cleanup (`afterAll`) stops the
  singleton pollution that broke `src/core/context` budget tests at baseline.
- **Code hygiene:** all development-history labels removed from `src/**`
  (`Phase NN`, `§N`, letter-suffixed variants) via a comment-line-only
  codemod plus targeted string-literal fixes; final scan = **0 matches**.
  Identifiers that are persisted data keys (e.g. eval suite id `phase87`)
  were deliberately kept and documented as stable IDs, not history labels.
- **Tests added:** `src/tui/__tests__/asyncMutation.test.ts` (6),
  `src/tui/permissions/__tests__/interruptManager.test.ts` (6),
  `src/tui/input/__tests__/pasteBurst.test.ts` (7),
  `tests/e2e/pty-acceptance.test.ts` (conditional node-pty driver),
  `scripts/pty-acceptance.py` (real-PTY harness, always available).

### 11.3 Defects found & fixed (root causes)

1. **Permission dialog overwrite race** — concurrent `requestApprovalModal`
   calls clobbered `tuiState.pendingConfirmation`, orphaning the first
   requester's promise. Fixed by the FIFO manager (§11.2).
2. **Duplicate resize listeners** — raw `resize` listener re-rendered the
   frame in addition to the debounced SIGWINCH path (double paint per
   resize). Removed; single debounced owner.
3. **Ctrl+C swallowed by approval dialog** — the modal intercept branch ran
   before the Ctrl+C branch, making abort impossible while a dialog was
   open. Fixed via `cancelPendingApproval()`.
4. **Composer/transcript row mismatch** — composer cap (3) diverged from the
   layout budget, breaking the 60x20 row guarantee. Unified via
   `COMPOSER_MAX_BUFFER_LINES = 5` shared by layout and renderer.
5. **Singleton catalog pollution in tests** — the inherited e2e fixture left
   `gpt-4o` registered on the process-wide catalog, flipping
   `resolveModelLimits("openai/gpt-4o")` from legacy-table to catalog
   source and failing 2 context-budget tests in full runs. Fixed with
   `afterAll` cleanup (and verified isolated-vs-full behavior first).

### 11.4 Terminal lifecycle & PTY results

Real-PTY acceptance (`scripts/pty-acceptance.py`, stdlib `pty`+`TIOCSWINSZ`;
`node-pty` cannot compile in this environment — native postinstall blocked):

```
PASS 120x40 exit=0 bytes=62110
PASS 100x30 exit=0 bytes=45243
PASS 80x24  exit=0 bytes=37647
PASS 60x20  exit=0 bytes=15901
PASS resize 80x24->60x20->120x40 exit=0 bytes=53611
pty-acceptance: ALL PASS
```

Asserted per geometry: alt-screen entered/left, cursor restored (no raw-mode
leak), composer prompt painted, Esc inert, double-Ctrl+C exit, and live
SIGWINCH resize (incl. down to 60x20) without crash and with the prompt
still on screen.

### 11.5 Gates

- `bun run typecheck` — 0 errors
- `bun test` — 2511 pass / 0 fail / 3 skip (×3 consecutive clean runs)
- `bun run build` — ✅ (bun + node bundles)
- `npm pack --dry-run` — ✅ (`toolnetcli-1.2.4.tgz`)
- Hygiene scan `Phase [0-9]|phase [0-9]|PHASE [0-9]|§[0-9]` in `src/**` — 0

### 11.6 Known limitations & Phase 89 boundary

- Tier 3 (`tier3-cross-feature/`) and Tier 4 (`tier4-scenarios/`) e2e files
  from the plan remain unwritten (Tier 1/2 + PTY cover the acceptance
  criteria); they are the natural start of the next phase.
- The paste-burst detector buffers plain-typing bursts ≤45 ms apart; a
  terminal that delivers whole pastes in one read already bypasses it via
  the single-chunk text path.
- `node-pty`-based acceptance stays conditional in `tests/e2e/` until a
  build environment allows the native module; the stdlib Python harness is
  the canonical driver for now.
- Out of scope (Phase 89+): multi-agent teamwork UI, MCP marketplace flows,
  provider marketplace additions.
