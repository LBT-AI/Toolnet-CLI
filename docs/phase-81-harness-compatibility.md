# Phase 81 — Harness Compatibility Layer + Cross-Harness Eval

Status: **DONE** (commit `see git log`)

Baseline: Phase 73–80 complete at `1414cc6`.
Result: `2037 pass / 3 skip / 0 fail` (2040 tests, 152 files), `bun run typecheck` PASS,
`bun run build` PASS, `npm pack --dry-run` PASS, 5 consecutive clean full-suite runs.

---

## 1. Core idea: harness ≠ runtime

ORI's central lesson is that *the same model under different harness strategies is a
measurable variable*. ToolNet adopts that idea **without** adopting a second runtime.

```
Task
  → AgentHarness          (the ONE loop — unchanged owner)
  → HarnessProfile        (policy only — NEW)
  → AgentEngine
  → ModelRouter → ModelAdapter → Provider

Tool path (unchanged):
  Model output → ToolRegistry → Permission → ToolGateway → Tool
```

`HarnessProfile` contains **no** provider instance, **no** model reference, **no**
execution loop, and **no** tool executor. It is a value object describing policy.

### Source-study classification

| Reference | Responsibility studied | Decision |
| --- | --- | --- |
| ORI `install-ori-harness/SKILL.md` | harness≠model; model selection independent of harness; forward unknown args | **ADAPT** — profile is policy, router is untouched |
| ORI `create-agent-tui/SKILL.md` + `references/system-prompt.md` | system-prompt composition; behavioral instructions belong to harness policy, not the engine | **ADAPT** — `PromptPolicy` extracted from `AgentHarness.buildSystemPrompt` |
| ORI `spawn-ori-eval/SKILL.md` | pin harness+model, isolate env, separate harness quality from model quality | **ADAPT** — `EvalResult.harnessId` + cross-harness comparison |
| `OpenRouterTeam/benchmark-harness` | run isolation, scoring/output structure, reproducibility | **ADAPT (structure only)** — eval still runs through the production harness path |
| OpenCode `agent/agent.ts`, `session/processor.ts`, `session/llm.ts`, `tool/registry.ts` | policy vs execution separation, session/tool lifecycle, prompt assembly | **KEEP ToolNet's owners** — no second harness, no second tool registry |
| ToolNet `AgentHarness` | loop, prompt, retry, context, completion | **REPLACE internals with policies; KEEP the class** |

---

## 2. Files

### New — `src/core/harness/`

| File | Responsibility |
| --- | --- |
| `types.ts` | `HarnessProfile` + the four policy contracts |
| `profiles.ts` | five built-in profiles + the single auto-resolution map |
| `errors.ts` | `UnknownHarnessProfileError` (structured, actionable) |
| `registry.ts` | `HarnessRegistry` + `harnessRegistry` singleton |
| `resolver.ts` | `HarnessResolver` — explicit > config > task > default |
| `prompt.ts` | `PromptPolicy` → canonical prompt input |
| `tools.ts` | `ToolPolicy` → exposure/ordering/guidance (never permission) |
| `continuation.ts` | `ContinuationPolicy` → turn budget + canonical loop bound |
| `progress.ts` | deterministic progress detector |
| `context.ts` | `ContextPolicy` over the existing context engine |
| `evidence.ts` | `ExecutionEvidence` derived from the existing event stream |
| `verdict.ts` | `CompletionVerdict` (SUCCESS/PARTIAL/FAILED/CANCELLED/TIMEOUT) |
| `store.ts` | config-backed persistence of the selected profile |
| `index.ts` | public surface |

### New — tests

`src/core/harness/__tests__/{profiles,policies,evidence,integration,architecture}.test.ts`,
`src/core/eval/__tests__/crossHarness.test.ts`,
`src/commands/__tests__/{harnessCli,phase81EvalHarnessCli}.test.ts`,
`src/tui/__tests__/harnessProfileSelector.test.ts`.

### Modified

`src/lib/harness/agentHarness.ts` (policies wired into the single loop),
`src/lib/harness/types.ts`, `src/core/agent/agentEngine.ts`, `src/core/contracts.ts`,
`src/core/eval/{types,runner,index}.ts`, `src/commands/{evalCli,harness}.ts`,
`src/commands/harnessCli.ts`, `src/index.tsx`, `src/lib/appConfig.ts` (schema v4),
`src/lib/harnessCatalog.ts`, `src/tui/**` (read-only section),
`src/lib/plugins/pluginManager.ts` (flake root-cause fix — see §12),
`src/banner/__tests__/b2Banner.test.ts` (removed a wall-clock dependency).

Total: **38 files, +5422 / −77**.

---

## 3. Built-in profiles

| id | Prompt | Tools | Continuation | Context | Intent |
| --- | --- | --- | --- | --- | --- |
| `default` | full | all | pre-Phase-81 loop | full | **identity** — byte-for-byte pre-Phase-81 behaviour |
| `minimal` | minimal | all | canonical bounds | compact | small prompt, fewer orchestration instructions |
| `coding` | full | all | canonical bounds | balanced | inspect → edit → verify; no unverified "done" |
| `tool-heavy` | full | all | tighter repeat bound (2) | balanced | encourage necessary tools, stop duplicates |
| `reasoning` | full | all | generous turns | balanced | more planning budget, no chain-of-thought exposure |

No profile names a vendor or a model. `default` is asserted to produce the
pre-Phase-81 system prompt **byte-for-byte**, which is what makes the layer safe to
adopt one profile at a time.

Auto-resolution (`coding`/`debugging` → `coding`, `tool_heavy` → `tool-heavy`,
`reasoning`/`planning` → `reasoning`, else `default`) lives in **one** map in
`profiles.ts`; no CLI/TUI/harness branch knows the mapping.

---

## 4. Policy boundaries

| Policy | May do | May **never** do |
| --- | --- | --- |
| `PromptPolicy` | choose instruction blocks / verbosity | drop the permission boundary; bypass sandbox |
| `ToolPolicy` | narrow to a subset, reorder, add guidance | widen the set, decide permission, turn DENY→ALLOW |
| `ContinuationPolicy` | set turn budget, repeat bound, no-progress bound | loop unbounded |
| `ContextPolicy` | choose trim aggressiveness | drop a DENY decision or a security block |

**Security invariant (tested for every profile):** out-of-scope writes are denied,
an allow-list naming a denied tool does not grant it, approval is still required,
cancellation still propagates. A profile changes instruction strategy only.

---

## 5. Progress detection & loop bounds

Deterministic signals, in order: new tool call → new file mutation → new command
result → different response fingerprint → new diagnostic/test state → final response.
No LLM judge. `maxTurns`, `maxRepeatedToolCalls` and `maxConsecutiveNoProgressTurns`
are canonical on the profile; nothing else hard-codes its own bound. Repetition is
tracked per *consecutive* call, so `edit → test → edit → test` is not a loop.

---

## 6. Completion contract

`CompletionVerdict` is derived from **evidence**, never from the model emitting final
text:

* prose-only answer to a mutation task → never `SUCCESS`
* "tests pass" with no recorded test run → never `SUCCESS`
* real work done but a required step outstanding → `PARTIAL`
* loop abort / dead ends → `FAILED`
* user/parent abort → `CANCELLED` (never conflated with a failure)
* budget exceeded → `TIMEOUT`

`ExecutionEvidence` (`filesRead`, `filesChanged`, `commandsRun`, `testsRun`,
`toolCalls`, `failedToolCalls`, `permissionDenials`, `diagnostics`,
`verificationResults`) is **derived from the existing event stream** — no second
event system.

---

## 7. Eval integration

`EvalResult` gained `harnessId` + `harnessVersion`; the runner resolves the profile and
records identity. Cross-harness runs use the **same** `EvalRunner`, the same model, the
same tools and permissions — only the profile differs. Identical inputs produce
identical recorded identity (reproducibility test).

CLI:

```
toolnet eval harnesses
toolnet eval run <suite> --model <model> --harness <profile>
toolnet eval compare-harness --model <model> <harness...>
toolnet eval compare-harnesses ...
toolnet eval matrix <suite>
```

`compare-harness` prints success / tool-use / reliability / turns / latency and always
shows the sample count; no winner is declared below the sample threshold. `matrix`
builds the model × harness grid with a normalized score + sample count per cell and
never runs paid models en masse without an explicit request.

---

## 8. Router independence

Harness selection and model routing are orthogonal axes:

* explicit model still beats model auto-routing;
* explicit harness still beats harness auto-resolution;
* `coding` harness does **not** imply any particular model.

Architecture guards assert the router is unaware of harness profiles and the harness is
unaware of router internals.

---

## 9. CLI & TUI

```
toolnet harness list | show <id> | current | use <id> | reset
```

Persisted through the existing canonical config owner (`appConfig`, schema **v4**) —
no second config file. Unknown ids fail loudly (no silent fallback to `default`).

The TUI exposes a read-only **Profile** section in the existing harness panel: it lists
registered profiles, marks the active one, reflects external selection, and selects via
the same config API as the CLI. It renders no policy and constructs no provider.

---

## 10. Architecture guards (static tests)

* exactly one `AgentHarness`, `AgentEngine`, `ModelRouter`, `ToolRegistry`, `ToolGateway`
* one harness registry singleton
* `src/core/harness/**` contains no `provider.chat`/`stream`, no direct
  `ToolGateway.execute`, no `spawn`, no file writes, no network
* the TUI never constructs a provider for inference
* no vendor name decides harness auto-resolution

---

## 11. Test matrix

| Area | Coverage |
| --- | --- |
| profiles | identity `default`, narrowing, auto-resolution, unknown id |
| policies | prompt pass-through/verbosity, exposure vs permission, ordering, bounds |
| progress | signals, streaks, reset, disabled tracker |
| evidence | derivation from events, failure counting |
| verdict | fake success, verified write, cancellation, stuck loop |
| security | DENY + approval + cancellation under **every** profile |
| loops | repeated call, interleaved call, no progress, malformed call, tool error, cancel, max turns |
| controls | same model × different profile, reproducible identity |
| regressions | Phase 73–80 suites |

---

## 12. Flaky-test investigation (root cause **fixed**)

The phase inherited two reportedly flaky banner tests. Investigation found the real
cause, and it was a **production bug**, not a test problem:

`PluginManager.executePluginTool` created a 30 s timeout promise and then did

```ts
const execPromise = Promise.resolve(tool.execute(args, context));
const res = await Promise.race([execPromise, timeoutPromise]);
```

A plugin tool that throws **synchronously** (e.g. `p4_plugins.test.ts` → `explode`)
threw on the `execPromise` line, skipping `Promise.race` entirely and orphaning
`timeoutPromise`. 30 s later that promise rejected as an **unhandled error**, which Bun
then attributed to an *unrelated* test that happened to be running — producing a random
failure (`b2Banner`, `phase78RemoteMcpAuth`, `securityHardeningPhase4`, the Phase 81
loop test, …) roughly 30 s into every full-suite run.

Fix (deterministic synchronisation, no timeout raised):

* defer the call into the race so a synchronous throw flows through the same `catch`;
* clear the timer in `finally`.

Verification: the orphan error appears **0 times** in 12 post-fix full runs, with 5
consecutive clean runs. A/B against the untouched `1414cc6` baseline reproduced the
orphan error and unrelated failures under load, confirming it was pre-existing but
fixable.

Also removed a genuine wall-clock dependency in `b2Banner.test.ts` (frame interval only
governed how long the test waited; the injected clock already made frames
deterministic).

### Remaining classified flake

* `74.11 LIVE — real typescript-language-server > shutdown terminates the real process
  with no orphans` — the test polls a 5 s deadline for the OS to reap a killed child.
  Under heavy parallel load the reap can exceed that. **PRE_EXISTING_FLAKE**, unrelated
  to this phase, reproduced on the untouched baseline. Not "fixed" because the only
  available change would be raising a timeout, which this phase forbids.

No new flaky test was introduced; no timeout was increased.

---

## 13. Known limitations

* No LLM-as-judge grader (deterministic graders only, by design).
* Cross-harness matrix results are local (`~/.toolnet/evals/`); no remote leaderboard.
* Real-model smoke acceptance requires credentials; it is an explicit `ENVIRONMENT`
  skip when absent, never a faked pass.
* Harness profiles are not per-subagent-selectable yet; the parent's profile governs the
  child's loop policy, while permissions remain scoped by the existing subagent rules.
* The identity profile is the compatibility guarantee; adopting `coding`/`tool-heavy` as
  a default is a deliberate later decision.
