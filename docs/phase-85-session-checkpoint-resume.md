# Phase 85 — Durable Session, Checkpoint, Resume and Crash Recovery

Handoff document. Phase 86 (Context Intelligence) and later owners should read
this before changing anything session-related.

## 1. Baseline

| Item | Value |
| --- | --- |
| Baseline commit | `5cc385a0000ef3be7788dd4a92e758583afb77aa` (Phase 84 docs) |
| Phase 84 code commit | `7c51b45` |
| Phase 83 commit | `119569f` |
| Worktree at start | clean, on `main`, pushed |
| Baseline gates | typecheck PASS, **2212 pass / 3 skip / 0 fail**, build PASS, pack PASS |

No pre-existing regression was found, so no baseline investigation was required.

## 2. References actually inspected

| Reference | Finding | Disposition |
| --- | --- | --- |
| Codex `codex-rs/core/src/session/rollout_reconstruction.rs` | History is an append-only `RolloutItem` JSONL journal; the newest surviving `Compacted` checkpoint with `replacement_history` is a complete history **base**, and only the suffix after it is replayed. Compaction *clears* the baseline. | **ADAPT** — journal + checkpoint-base + suffix replay, implemented forward and deterministically. |
| OpenCode `packages/opencode/src/session/schema.ts` | Session/Message/Part ids are branded, prefixed, ascending identifiers. | **ADAPT** (id validation and monotonic sequences) / **NOT_APPLICABLE** (Effect schema runtime). |
| OpenCode `session/compaction.ts` | Compaction replaces history with a summary and re-establishes a baseline. | **NOT_APPLICABLE** to Phase 85 — context compaction is Phase 86. Only its *persistence* is supported here. |
| ToolNet `src/lib/sessionPersistence.ts` (470 lines, pre-existing) | THE canonical session persistence: one `<id>.json` per session, full rewrite per save, no versioning/atomicity/journal/checkpoint/lock. | **EXTEND** — this file remains the owner; it now delegates durability to the store. |
| ToolNet `src/teamwork/checkpoint.ts` | A SQLite-ish checkpoint table for **teamwork DAG milestones**. | **NOT_APPLICABLE** — different domain; not merged. |
| ToolNet `src/lib/crashRecovery.ts` | A single-process crash *breadcrumb* (`recovery/last_session.json`). | **KEEP** untouched — it answers "was the last exit clean?", the store answers "what is the durable session state?". |
| ToolNet `src/core/auth/credentialStore.ts` | Hardened storage pattern: lazy path, atomic temp+rename, quarantine, symlink refusal. | **ADAPT** for the session store's atomic primitives. |
| ToolNet `src/lib/harness/evidence.ts`, `verdict.ts` | Canonical `ExecutionEvidence` and `CompletionVerdict`. | **KEEP/REUSE** — checkpoints store an evidence *summary* derived from them; no second evidence system. |

## 3. Files changed

**New — `src/core/session/`** (THE durable layer):

| File | Responsibility |
| --- | --- |
| `types.ts` | `SessionRecord`, `SessionEvent`, `SessionCheckpoint`, `SessionIndex`, `SessionStatus`, `WorkspaceIdentity`, `ExecutionEvidenceSummary`, id validation contract. |
| `errors.ts` | Structured session errors (`code`, `sessionId`, `retryable`, safe message). |
| `paths.ts` | Session-id validation and safe path resolution; canonical sessions dir. |
| `atomic.ts` | `writeFileAtomic` (temp + fsync + rename + dir fsync), `appendLineDurable`, `quarantineFile`. |
| `journal.ts` | JSONL event/checkpoint journals with tolerant replay and sequence invariants. |
| `lock.ts` | Exclusive per-session lock (O_EXCL) with conservative stale recovery. |
| `workspace.ts` | Workspace identity and `same/moved/missing/mismatch` classification. |
| `resume.ts` | Pure reconstruction: `replaySession`, `selectCheckpointHead`. |
| `store.ts` | `SessionStore` — the single write/read authority (`sessionStore` singleton). |
| `index.ts` | Barrel. |

**New — `src/commands/sessionCli.ts`**: `toolnet session list|current|show|resume|continue|fork|rename|delete|doctor`.

**Tests — `src/core/session/__tests__/`**: `store`, `journal`, `resume`, `lifecycle`, `cli`, `architecture`, `restartAcceptance` (**95 tests**).

**Modified**:

- `src/lib/sessionPersistence.ts` — keeps its exported API (and the legacy on-disk `sessionId` field), delegates durability to the store; adds `listSessionSummaries()`.
- `src/lib/session.ts` — adds `getSessionSummaries`, `resumeSession`, `getLatestSessionForWorkspace`; auth pinning preserved.
- `src/index.tsx` — `toolnet session` now dispatches to the new CLI.
- `src/tui/state.ts` — picker built from **index metadata** (no transcript loads), carrying status/harness.
- `src/tui/renderers/sessionPickerRenderer.ts` — renders status and harness.

## 4. Architecture before → after

**Before**: session state was a single JSON file rewritten wholesale on each save, with no version, no journal, no checkpoint, no lock, no workspace binding and no crash semantics.

**After**:

```
callers (harness, TUI, CLI, legacy facade)
        │
   SessionStore  ← THE single owner
        │
  ┌─────┼──────────────┬───────────────┐
  │     │              │               │
record  event journal  checkpoint log  index (derived, self-healing)
(atomic)(append-only)  (append-only)
```

Responsibilities the store absorbed: versioning, atomic durability, sequence
allocation, checkpoint head, index maintenance, locking, corruption quarantine,
legacy migration, workspace binding, fork/continue/delete and doctor.

There is **one** AgentHarness, AgentEngine, AgentLoop, ModelRouter,
ProviderRegistry, ModelCatalog, tool registry, ToolGateway, CredentialResolver
and SessionStore. No second event system, transcript store or agent loop exists.

## 5. Storage layout

```
~/.toolnetcli/sessions/            (<TOOLNETCLI_SESSIONS_DIR> override wins)
  <id>.json                        materialized record (atomic, mode 0600)
  <id>.events.jsonl                canonical event journal (append-only)
  <id>.checkpoints.jsonl           reconstruction boundaries (append-only)
  <id>.lock                        exclusive owner lock
  .index.json                      list metadata (dot-prefixed: never scanned as a session)
  last_session.txt                 resume pointer
```

Sessions are **never** stored in the source repository or the cwd. The record
JSON also carries `sessionId` alongside the structured `id` so readers built
against the earlier flat format keep working.

## 6. Schema version and migration

`SESSION_SCHEMA_VERSION = 1`. Loading an unversioned (legacy) record upgrades it
**in memory** and leaves the original file untouched until the next save —
migration is deterministic, testable and non-destructive. A record claiming a
*newer* version than this build is refused (non-strict: skipped with a warning;
strict: `SessionUnsupportedVersionError`) rather than guessed at.

## 7. Event journal and crash-safe append

Canonical events: `session.created`, `session.status`, `session.completed`,
`session.failed`, `session.cancelled`, `user.message`, `assistant.message`,
`tool.started`, `tool.completed`, `tool.failed`, `permission.decision`,
`model.selection`, `harness.selection`, `auth.pin`, `checkpoint.created`.

Each append is one complete line. Recovery tolerates:

- a **torn final line** (dropped, reported as `truncated`, earlier records intact);
- an **unreadable interior line** (isolated; neighbours preserved);
- **duplicate / out-of-order sequences** (ignored, counted — never reordered);
- **unknown additive event types** (preserved and reported, never acted on).

No UI repaint, spinner or streaming token is journaled.

## 8. Checkpoint lifecycle and atomicity

A checkpoint is a durable **reconstruction boundary**, not a git commit. Write
ordering (the invariant that makes recovery deterministic):

1. append the journal events;
2. write the **record** atomically, including the **new** `checkpointHead`
   (fixed during this phase — the record previously kept a stale head);
3. append the **checkpoint line**, referencing an already-durable `eventSequence`.

Because the checkpoint line *is* the boundary, a head can never point at a
nonexistent checkpoint. Checkpoints are taken at session creation, turn
completion, before a fork, and on explicit request — never per token.

## 9. Resume reconstruction

`SessionStore.resume(id)`:

1. load the record (migrating legacy shapes);
2. read the journal and the checkpoint log;
3. select the newest checkpoint whose `eventSequence <= journal.lastSequence`
   (a checkpoint referencing lost state is skipped in favour of an earlier one);
4. replay only the journal events **after** that checkpoint, forward, once;
5. classify the workspace (`same` / `moved` / `missing` / `mismatch`);
6. apply the crash rule: an active status with no terminal event and **no live
   owner** becomes `interrupted`.

Replay is **state-only**: it never runs a tool, spawns a process or touches the
network. `resume` does not restore an `AbortSignal`, provider client, socket or
child process — the caller resolves runtime dependencies fresh.

## 10. Tool side-effect safety

If the journal durably shows `tool.started` with no matching
`tool.completed`/`tool.failed`, the call is reported as `interrupted` with
`reason: started_without_completion` and an **unknown** outcome. It is **never
replayed automatically**, because a mutating tool may have half-applied. Only
the harness, after inspecting the real workspace, may decide to act again. This
is asserted by the cross-process acceptance test (the interrupted `edit_file`
never becomes a fabricated tool result).

## 11. Workspace identity

`WorkspaceIdentity = { path, root, gitRoot?, key }`. `key` prefers git provenance
(`git:<origin>#<relative path>`, so a move is detectable), then a project marker
(`pkg:<name>#<rel>`), then the directory name. Classification order is deliberate:
a different key is always `mismatch` (and refuses to resume); only then can a
same-key workspace be `missing` or `moved`. `continue` is workspace-scoped — a
session from another repository is never resumed by accident.

## 12. Auth / model / harness identity

Only **stable ids** persist: `model`, `provider`, `harness`, `authProfileId`.
Credentials are resolved fresh through the Phase 84 `CredentialResolver` at call
time, so a resumed session cannot replay a rotated key. A persisted
`authProfileId` that no longer resolves is a terminal
`SessionCredentialUnavailableError` — never a silent fall back to another
account. External-harness and subagent sessions keep their own namespaces
(`external:codex:<id>`, `sub:<parent>:<agent>:n`); a native session is never
resumed through an external harness and vice versa.

## 13. Session status machine

`idle · running · waiting_permission · completed · failed · cancelled · interrupted`

On restart: `running|waiting_permission → interrupted` unless a live owner is
detected. Interrupted is never reported as completed.

## 14. Locking and concurrency

A per-session lock file created with `O_EXCL` is the cross-process mutual
exclusion mechanism. Stale recovery is conservative: a lock is reclaimed only
when the owning pid is provably gone on this host, or after a hard-stale window
(30 min) — so a crashed process never leaves a session permanently dead and a
live process is never preempted. `release` only removes a lock still owned by the
caller.

Mutations are synchronous (write + rename) inside a single-threaded runtime, so
each read-modify-write is atomic; overlapping async saves were tested (30 and 40
concurrent operations, no lost update, strictly increasing sequences). The list
index is *derived*: if it is lost, stale or mismatched it is rebuilt from the
records, so index damage costs one rebuild and never correctness.

## 15. Corruption, quarantine and doctor

A corrupt record, index or (by policy) journal is moved aside with a
`.corrupt-<timestamp>` suffix, the contents are **never logged**, and the store
continues rather than crashing startup. `toolnet session doctor` is read-only
(no model calls, no tool execution, no destructive repair) and reports: index
presence/validity/rebuild, corrupt records, corrupt journals, missing
checkpoints, missing workspaces, stale locks, orphan directories and missing
pinned auth profiles.

## 16. Session lifecycle operations

- **continue** — most recent session for the current workspace; `null` starts a new one.
- **fork** — takes a pre-fork checkpoint on the source, then creates a child with
  `parentSessionId` + `forkedFromCheckpointId`. The source is not mutated and
  nested tool-call structures are deep-copied; the credential is resolved fresh.
- **rename** — sets the structured `title` and the legacy `metadata.name` together.
- **delete** — never silently cascades: a parent with forks requires `--cascade`.
- **retention** — metadata (`createdAt`/`updatedAt`) is available for a future
  prune; nothing is auto-deleted and no hidden policy is applied.

## 17. CLI and TUI

```
toolnet session list [--json] [--workspace]
toolnet session current
toolnet session show <id> [--json]
toolnet session resume <id> [--dry-run] [--allow-mismatch] [--json]
toolnet session continue [--json]
toolnet session fork <id> [--title <name>]
toolnet session rename <id> <title>
toolnet session delete <id> [--cascade]
toolnet session doctor [--json]
```

`<id>` accepts an exact id or an unambiguous prefix; ambiguity is reported, not
guessed. `resume` performs the real durable resume, marks the crash decision, and
prints the exact interactive command (`toolnet --session <id>`); interactive boot
stays owned by the TUI entry, which already accepts `--session`. The TUI session
picker is fed from index metadata only and now shows status and harness.

Because of the §40 hygiene rule, the session module and the new CLI carry **no**
development-history labels (verified by a guard test). The repository still has
185 pre-existing production files with `Phase NN` labels from earlier phases;
retrofitting those is a separate, repo-wide change and was **not** done here.

## 18. Defects actually found (root-caused and regression-tested)

1. **Stale checkpoint head** — `save()` persisted the record *before* updating
   `checkpointHead`, so disk kept the previous head while the checkpoint log
   advanced. Fixed by computing the head first and writing the record with it.
2. **Cross-directory cache leakage** — the store memoized its sessions directory
   at first use, so a redirected HOME/`TOOLNETCLI_SESSIONS_DIR` kept serving the
   old directory. Fixed: the directory is resolved per call and caches reset on
   change.
3. **Path traversal** — legacy `loadSession`/`deleteSessionFile` joined raw user
   input into a path (`../escape`). Now every id is validated and the resolved
   path is re-checked to be inside the sessions directory.
4. **Index vs record disagreement** — `listAllSessions` trusted the index for
   ordering; a record updated outside the store listed in the wrong place. The
   full-record listing now sorts by the record's own `updatedAt`.
5. **Arbitrary same-millisecond ordering** — sessions created in the same
   millisecond sorted nondeterministically. Tie-break is now id-descending
   (generated ids embed creation time).
6. **Misleading doctor output** — a fresh store reported `Index: damaged
   (rebuilt)`. Now distinguished as `absent`.
7. **Legacy display field** — `createNewSession(name)` and `renameSessionFile`
   dropped `metadata.name`, which every front-end reads. Both now keep `title`
   and `metadata.name` in step.

Each has a regression test in the suites above.

## 19. Tests

```
src/core/session/__tests__/store.test.ts             20 pass
src/core/session/__tests__/journal.test.ts           10 pass
src/core/session/__tests__/resume.test.ts            28 pass
src/core/session/__tests__/lifecycle.test.ts         17 pass
src/core/session/__tests__/cli.test.ts               22 pass
src/core/session/__tests__/architecture.test.ts       7 pass
src/core/session/__tests__/restartAcceptance.test.ts  2 pass
                                                     -------
                                                     106 assertions groups / 112 with legacy suites
```

Coverage includes: atomicity, temp-file cleanliness, concurrent saves and
appends, locking (live + stale), corruption quarantine, unsupported versions,
legacy migration, id safety, delete-with-children, doctor, all crash windows
(torn journal tail, torn checkpoint tail, checkpoint referencing lost state,
events after the last checkpoint), interrupted-tool semantics, workspace
classification, fork isolation, and the real three-process restart.

## 20. Live acceptance

Real, local, no provider required:

1. process 1 — create a native session, checkpoint it, durably start a mutating
   tool, exit without releasing the lock;
2. process 2 — a **new** process resumes: status `interrupted`, `edit_file`
   reported with an unknown outcome, identities restored;
3. process 2 — continues the task and checkpoints;
4. process 3 — confirms the continuation persisted exactly once and that the
   interrupted tool produced no fabricated result.

A second acceptance test confirms a live lock in another process is refused
(`SESSION_LOCKED`). The whole CLI surface was also exercised end-to-end against
the built bundle (`bin/toolnet.js`).

External-harness resume: **ENVIRONMENT / SKIPPED** — no external harness session
was started during acceptance; the reference path is covered by the store tests.

## 21. Gate results

```
bun run typecheck     PASS
bun test              2307 pass / 3 skip / 0 fail   (3 consecutive clean full runs)
bun run build         PASS  (607 modules, index.js 2.53 MB)
npm pack --dry-run    PASS  (toolnetcli-1.2.4.tgz, 6 files, 5.0 MB unpacked)
```

The 3 skips are the pre-existing environment/live skips
(`P7 clean-HOME smoke`, `REAL MODEL E2E`, `Phase 79 live OpenRouter`). The known
wall-clock flaky banner tests (`b2Banner`, `p8.banner`) did **not** flake in any
of the three runs and no timeout was raised.

## 22. Known limitations

- **Index durability**: the index is a derived cache; a lost update is
  self-healed by a rebuild, not prevented.
- **Cross-process appends**: concurrent *writers* are serialized by the lock, but
  the lock is advisory — a process that ignores it can still append (sequences
  are rejected on read, so the journal degrades safely rather than corrupting).
- **No transcript size cap yet**: retention metadata exists (`createdAt`,
  `updatedAt`, message counts) but `session prune` is deliberately not
  implemented.
- **Compaction boundary**: only compaction *persistence* is supported. Token
  budgets, summary prompts and long-context selection remain Phase 86's job — no
  second compaction system was introduced.
- **External harness transcripts** are stored as references + normalized
  evidence; ToolNet does not duplicate a harness's private session internals.
- **Pre-existing phase labels** remain in 185 unrelated production files (§17).

## 23. Phase 86 integration boundary

Phase 86 (Context Intelligence) may **not** add a second session store. It should:

- emit compaction as events on the existing journal and take a checkpoint
  before/after it;
- treat a checkpoint as the new history base after compaction (the same
  base + suffix replay this layer implements);
- extend `ExecutionEvidenceSummary` rather than adding a parallel evidence type;
- keep `SessionRecord.context` as the opaque carrier for the compaction snapshot
  (it is already persisted, capped and restored through `loadSessionContext`).

## 24. Final commit

```
commit  5d63ee347ee88a60afccce1220ae2aa97c31a613
branch  main
push    origin/main
```

Gate summary on this exact revision:

```
bun run typecheck     PASS
bun test              2308 pass / 3 skip / 0 fail   (3 consecutive clean full runs)
bun run build         PASS
npm pack --dry-run    PASS
```
