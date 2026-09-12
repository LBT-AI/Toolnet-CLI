# Phase 83 — External Harness Adapter + ORI-Style Interoperability

**Status:** DONE
**Baseline:** `52bc32e` (Phase 82 — provider routing intelligence)
**Final commit:** see `git log -1` after merge (this document written pre-commit)
**Branch:** `main`

---

## 1. Purpose

ToolNet can now execute coding tasks not only on its own native harness but also
on **external coding harnesses** (independent executables such as OpenCode and
Codex), and can compare them under the eval system on identical fixtures.

External harnesses are **interoperability targets, not a second runtime**.
There is still exactly ONE AgentEngine, ONE AgentHarness, ONE ModelRouter,
ONE ToolRegistry, ONE ToolGateway.

```
                 HarnessExecutionService.run({ target })
                   /                      \
            target: native          target: external:<id>
                  |                        |
          AgentHarness (existing)   ExternalHarnessRunner
                  |                        |
     AgentEngine → ModelRouter       ExternalHarnessRegistry
     → ModelAdapter → ToolRegistry          |
        (native path unchanged)      opencode | codex | claude | hermes
```

## 2. Source references actually read

| Reference | Verdict | What was taken |
|---|---|---|
| ORI Harness skill (install-ori-harness/SKILL.md) | ADAPT | harness ≠ model; unknown args forwarded; missing harness reported cleanly; harness list (claude/codex/opencode/hermes) |
| ORI Eval skill (spawn-ori-eval/SKILL.md) | ADAPT | pin model+harness; isolated temp workspace; harness quality ≠ model quality |
| OpenCode `cli/cmd/run.ts` (dev branch) | ADAPT | `--format json` event stream, `--session` resume, `--model` override, prompt/stdin, non-interactive semantics |
| Codex `exec/src/exec_events.rs` + jsonl output processor | ADAPT | `ThreadEvent` JSONL schema: thread.started / turn.completed(usage) / turn.failed / item.* lifecycle |
| Codex `exec/src/lib.rs` | READ | stdout reserved for final output; JSONL is the machine channel |
| OpenCode session/processor, llm.ts, agent.ts | NOT_APPLICABLE | internal runtime concerns; OpenCode is an external executable here |

No reference code was copied verbatim; schemas were transcribed into parsers.

## 3. Canonical owners (new)

All new code lives in `src/core/externalHarness/`:

| File | Owner |
|---|---|
| `types.ts` | `ExternalHarnessDefinition`, tri-state `ExternalHarnessCapabilities` (`true/false/"unknown"` — never assumed), canonical `ExternalHarnessEvent` union, `ExternalHarnessResult`, `ExecutionTrust`, session namespace helpers (`external:<id>:<sid>`) |
| `errors.ts` | `HarnessNotFoundError`, `HarnessUnavailableError`, `HarnessCapabilityError`, `HarnessSpawnError`, `HarnessProtocolError`, `HarnessTimeoutError`, `HarnessCancelledError`, `HarnessExitError` — all with `code`, `harnessId`, `retryable`, `cause`, `safeMessage`; secrets never enter messages |
| `registry.ts` | **THE** `ExternalHarnessRegistry` — definitions only, no execution. `register/get/list/resolve/detect` with bounded-TTL detection cache, duplicate-id refusal |
| `process.ts` | Safe child execution: argv-only spawn (never `sh -c`), env = `scrubChildEnv` allowlist + adapter-declared env names, explicit cwd, bounded output capture (`MAX_STREAM_BYTES`), AbortSignal → **process-tree kill**, timeout → process-tree kill, exit-code capture |
| `runner.ts` | **THE** `ExternalHarnessRunner` — detect → build argv → spawn → consume streams → parse events → normalize result. Zero harness-specific branches |
| `adapters.ts` | Harness-specific behavior: OpenCode, Codex (first-class), Claude + Hermes (conservative definitions) |
| `service.ts` | **THE** `HarnessExecutionService` — dispatch only: `native` → existing AgentHarness, `external` → runner. No loop moved here |
| `index.ts` | Barrel + registry pre-population with built-in adapters |

## 4. Adapters

### OpenCode (first-class)
- Executable: `opencode`; detection via `--version` (bounded, no side effects).
- Invocation: `opencode run --format json [--session <id>] [--model <m>] -- <prompt>` — prompt passed as argv, never shell text.
- Events: NDJSON stream on stdout; `{"type":"error",...}` mapped to failure (defect found **live**: earlier drafts only handled `session.error` and would have misclassified auth failure as PARTIAL — fixed after a real run against opencode 1.18.30).
- Capabilities verified: structuredOutput ✔, streaming ✔, modelOverride ✔, sessionResume ✔, sessionFork ✔, abort ✔.
- Never mutates global OpenCode config.

### Codex (first-class)
- Invocation: `codex exec --json [--model <m>] <prompt>`; parser mirrors the real `ThreadEvent` schema (thread.started / turn.started / item.started|updated|completed / turn.completed with usage / turn.failed with error).
- Terminal semantics: `turn.completed` → SUCCESS (with usage), `turn.failed` → FAILED with structured reason, regardless of exit code.
- Unknown additive fields tolerated; partial final JSONL line does not hang the parser.

### Claude / Hermes (conservative)
- Definitions registered with `structuredOutput: "unknown"`, conservative text parsing, no invented JSON schemas.
- If binary absent: detection returns `unavailable` — tests never require them.

## 5. Trust boundary (explicit, tested)

`ExternalHarnessDefinition.executionTrust = "external_managed"` for all Phase 83 adapters.

- An external harness executes **its own tools with its own permissions**.
- ToolNet does **not** claim ToolGateway/Permission protected an external edit.
- External harnesses are **never auto-routed**: a normal ToolNet task stays native unless a user explicitly targets an external harness via CLI/config.
- Model override: `ExternalModelSelection` is resolved by the **real ModelRouter** first; if the adapter cannot express it → `HarnessCapabilityError`. No silent substitution, no editing external global config.

## 6. Security model (all tested)

- Prompt containing `;`, `&&`, `$()`, backticks, quotes, newlines is inert argv data (spawn is `executable + argv[]`).
- Env injection: adapter-declared allowlist only, still passed through the secret denylist; values never logged.
- cwd explicit and validated via existing workspace path validation.
- Abort/timeout kill the **full process tree** (reuses the Phase 76 `killProcessTree` utility).
- stdout/stderr bounded; stderr flood cannot exhaust memory and does not by itself imply failure.
- Secrets redacted from every event/`metadata` payload before any surface (log/result/eval).

## 7. Session identity

External sessions are namespaced `external:<harnessId>:<externalId>` and carry `harnessId`. Resume validates harness identity — resuming an OpenCode session through Codex is a structured error.

## 8. Eval integration

`src/core/eval/` extended in place (no second runner):

- `EvalTarget.executionTarget: "native" | "external:<id>"` on the request; recorded in `EvalResult` alongside `harnessId`/`harnessProfileId`.
- External execution goes through `HarnessExecutionService`, graders still grade **real filesystem evidence** (FileMutationGrader etc.), not harness prose.
- Unknown/unregistered target → `ENVIRONMENT` failure class (caller problem, not model quality).
- Matrix dimension is now model × harness profile × execution target. ToolNet "coding" profile ≠ external "codex" harness — kept lexically distinct everywhere.

## 9. CLI

```
toolnet harness external list              # registered definitions
toolnet harness external status            # detection: installed? version? structured?
toolnet harness external show <id>         # full capability matrix
toolnet harness external run <id> --prompt "..."
toolnet harness external run <id> -- <args forwarded verbatim as argv>
```

Everything after `--` is forwarded as argv — never concatenated shell text. TUI: external entries appear in the existing harness catalog panel (installed/unavailable, version, structured-output, resume) — read-only, no policy in the UI.

## 10. Tests

51 tests in `src/core/externalHarness/__tests__/` (+ eval/CLI suites extended):

| Suite | Coverage |
|---|---|
| `registryProcess.test.ts` | registry register/duplicate/unknown; argv safety (shell metacharacters inert); env allowlist; cwd; abort kill; timeout kill; bounded output; exit codes; stderr capture |
| `adapters.test.ts` | Codex JSONL (valid/unknown field/partial line/turn.failed/exit-0-with-failure), OpenCode NDJSON (valid/unknown event/malformed/error event/session id), Claude/Hermes conservative paths |
| `evalCli.test.ts` | eval `executionTarget` end-to-end through the service (fake self-contained adapter), capability gating (`HarnessCapabilityError`), ENVIRONMENT classification for unknown targets |
| `architecture.test.ts` | exactly one registry/runner/service; external modules import no ToolGateway/Permission/provider.chat; adapters import nothing forbidden; production `src/` (excluding tests) has no `sh -c`/`bash -c` child spawn added by this phase |

## 11. Live acceptance

| Harness | Status |
|---|---|
| OpenCode 1.18.30 (`/usr/bin/opencode`) | **LIVE smoke executed**: real binary, temp workspace, `run --format json` NDJSON parsed end-to-end. Found and fixed the real `type:"error"` event defect during this run (auth-failure surface) |
| Codex | ENVIRONMENT/SKIPPED — binary not installed |
| Claude | ENVIRONMENT/SKIPPED — binary not installed |
| Hermes | ENVIRONMENT/SKIPPED — binary not installed |
| Billed external model call | Requires `TOOLNET_EXTERNAL_LIVE_TEST=1` (not set) |

No live pass was faked anywhere.

## 12. Defects found and fixed (§26 hunt)

1. OpenCode `{"type":"error"}` events misclassified as PARTIAL — found via live run, fixed, regression-tested.
2. Exit-0 + structured `turn.failed` would have read as SUCCESS in early Codex handling — terminal-event semantics enforced, tested.
3. Partial trailing JSONL line could stall a line-based parser — bounded buffering + ignore-unterminated-final-line, tested.
4. Eval `HarnessNotFoundError` was classified `CORE_RUNTIME` — now `ENVIRONMENT` (caller/environment problem), keeping model-quality metrics clean.
5. Test-fixture adapter inherited the real opencode executable and spawned a real child — fixture made self-contained with an explicit fake executable.

## 13. Gates

```
bun run typecheck   PASS
bun test            2121 pass / 3 skip / 0 fail   (3 consecutive clean runs — EvalRunner touched)
bun run build       PASS (index.js 2.40 MB)
npm pack --dry-run  PASS (toolnetcli-1.2.4.tgz)
```

Pre-existing wall-clock flakes (`b2Banner.test.ts`, `p8.banner.test.ts`): not observed in the Phase 83 clean runs; classified PRE_EXISTING_FLAKE, timeout unchanged.

## 14. Known limitations

- Codex/Claude/Hermes adapters are schema-verified but not live-verified (binaries absent).
- TTFT/latency metrics for external harnesses are not collected (adapters don't expose timing events).
- External usage normalization is best-effort per adapter (Codex turn.completed usage; OpenCode step events); missing fields stay unknown.
- No credential injection: env allowlist only (Phase 84 owns credential profiles).
- Cross-harness eval requires the target harness to be installed and non-interactive-capable; otherwise ENVIRONMENT skip.

## 15. Deferred to Phase 84 (integration points)

- `ExternalHarnessDefinition.envAllowlist` is the seam for credential profiles.
- `HarnessExecutionService.run()` is the single dispatch seam if Phase 84 adds per-target auth pre-checks.
- Session namespace helpers already emit harness identity for token-binding of stored credentials.
- `registry.detect()` TTL cache is where re-probe-on-credential-change would hook in.

## 16. Files changed

New: `src/core/externalHarness/{types,errors,registry,process,runner,adapters,service,index}.ts`, 4 test suites, this document.
Modified: `src/core/eval/{runner,types}.ts` (executionTarget), `src/commands/harnessCli.ts` (external subcommands), `src/index.tsx` (CLI wiring), `src/lib/harnessCatalog.ts` (external entries in catalog), `src/core/models/errors.ts` (redaction reuse).
