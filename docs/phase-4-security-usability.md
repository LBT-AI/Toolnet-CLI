# Phase 4 — Security Usability Without Weakening Safety

HEAD base: Phase 3 closed (`825cee8`)
Status: FIXED

## Problem (from docs/phase-0-7-security-false-positives.md)

Two false-positive classes made safe, read-only work impossible in `workspace`
mode while adding no real protection:

- **TN-R0-007A — inline interpreters.** `php` was missing from the parser's
  interpreter table, so `php -r 'echo "hello";'` was classified as generic
  workspace execution, while `SecurityEngine.determineShellCapability` matched a
  blanket `/\bphp\s+-r\s+/` regex and demanded the `DYNAMIC_EXECUTION`
  capability. That capability is locked by default (`dynamicExecution: false`),
  so *safe* inspection scripts were hard-DENYed outright.
- **TN-R0-007B — `/dev` redirects.** `SENSITIVE_SYSTEM_PREFIXES` contains
  `/dev`, and the classifier checked **every** redirect target. `echo x
  2>/dev/null` therefore became `SYSTEM_TAMPERING` / `CRITICAL_DENY` — a
  permanent block on a command that writes nothing at all.
- **TN-R0-007C — control.** `2>&1` parses to `{type:"2>&1", target:"1"}`; `"1"`
  is never pushed into `allRedirectTargets`, so fd duplication was already
  handled correctly and must stay that way.

The fix had to reduce false positives **without** weakening any safety control:
protected system writes, destructive `rm`/system mutation, privilege
escalation, credential paths, out-of-workspace writes and CRITICAL_DENY
invariants all stay exactly as they were.

## Design (required shape — implemented)

### 1. Intent, not interpreter name (TN-R0-007A)

A single source of truth lives in `src/lib/security/shellParser.ts`:

- `INTERPRETER_INLINE_FLAGS` — the interpreter → inline-flag map
  (`python/py3 -c`, `node -e|--eval`, `perl/ruby/lua -e`, `php -r`,
  `sh/bash/zsh/dash -c`). The parser reads its flags from this table, so
  `php -r` can never again be recognized in one layer and missed in another.
  `php` was added to `INTERPRETERS`.
- `inlineScriptIntent(script)` → `{ spawnsProcesses, deletesPaths,
  mutatesWorkspace, destructiveSystem }`, derived from structured pattern
  tables (subprocess/`shell_exec`/`child_process`…, `rmtree`/`unlink`/`rm …`,
  write-mode `open(…,"w")`/`writeFileSync`/`file_put_contents`/redirection …,
  and root/`~`/`$HOME`/`/etc`/`/var` targets).

Every layer consumes that one function:

| Layer | Rule |
|---|---|
| `commandClassifier.inspectCommandNode` §7 | destructive → `CRITICAL_DENY`; spawn → `DANGEROUS`/`DYNAMIC_EVALUATION`; mutation → `DANGEROUS`/`INLINE_SCRIPT_EVALUATION`; **read-only → falls through**, never a blanket DANGEROUS |
| `commandClassifier` main-flow interpreter gate | same ladder, applied to the whole command |
| `SecurityEngine.inlineInterpreterCapability` | destructive → `DELETE`/`SYSTEM`; spawn → `DYNAMIC_EXECUTION`; mutation → `MODIFY`; read-only → `EXECUTE` |
| `SecurityEngine.isDynamicExecution` | the blanket `bash -c` / `python -c` / `node -e` / `perl -e` / `ruby -e` / `php -r` name matches were **removed**; interpreter capability now comes from the AST-driven helper above |

`DYNAMIC_EXECUTION` is still locked by default, so a spawning/mutating payload
(`python -c 'import os; os.system("ls")'`, `php -r 'shell_exec("ls");'`) is
DENY in `workspace` and ASK in `ask` — never a blanket ALLOW.

Shell-variable detection was also disambiguated: `$x` inside a **non-shell**
interpreter script is data for that interpreter (PHP/Ruby variables), not shell
expansion, so it is no longer mistaken for `$CMD`-style dynamic execution.
Shell interpreters (`sh|bash|zsh|dash -c`) keep the fail-closed flag, so
`bash -c "$CMD"` stays `DYNAMIC_EXECUTION`.

### 2. FD-aware redirection (TN-R0-007B / 007C)

`src/lib/security/commandClassifier.ts` now owns redirect semantics:

- `HARMLESS_SINKS` = `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`,
  `/dev/zero`, `/dev/full`.
- `assessRedirection(red)` → `{ writesFilesystem, isHarmlessSink, isStderrOrAll,
  resolvedTarget }`; fd duplication (`2>&1`, `/dev/fd/N`, bare fd number) and
  discard sinks report `writesFilesystem: false`.
- `filesystemRedirectTargets(ast)` is the only list the classifier applies
  system/workspace/credential policy to. `2>/dev/null`, `2>>/dev/null`,
  `> /dev/null` and `2>&1` therefore never reach a `/dev` check, while
  `> /etc/...` still does.
- `SecurityEngine` step 2.5 (the out-of-workspace absolute-path scan) uses the
  same `isHarmlessSinkPath()` helper for both arguments and redirections, so
  `2>/dev/null` can no longer be mistaken for an out-of-workspace write, and
  `cat /dev/null` is no longer `SYSTEM_PATH_TARGET`.
- The parser still records the raw target in `allRedirectTargets` (unchanged,
  007C); interpretation happens once, in the classifier.

### 3. Controls preserved (unchanged, re-asserted)

`/etc`, `/var`, `/usr`, `/bin`, `/sbin`, `/root`, `/proc`, `/sys` writes,
`sudo`/`mkfs`/`dd`/`shutdown`, `rm -rf /`, credential paths, out-of-workspace
writes, capability locks and step-1 CRITICAL_DENY all behave exactly as before.
CRITICAL_DENY remains inviolable in `full-access` and under `userApproved:
true` (ToolGateway Guard 1) — **no mode is "allow everything"**.

## Behavior (verified end-to-end)

| Command | Before | After |
|---|---|---|
| `php -r 'echo "hello";'` | `DYNAMIC_EXECUTION` → workspace DENY | `EXECUTE` → workspace ALLOW |
| `php -r 'require "wp-load.php"; $x = 1; echo $x;'` | DENY (name + `$x`) | ALLOW |
| `python -c 'print(1)'` / `node -e 'console.log(1)'` | DENY | ALLOW |
| `bash -c 'echo x'` / `sh -c 'echo x'` | DENY | ALLOW |
| `php -r 'shell_exec("ls");'` | DENY | DENY (`DYNAMIC_EXECUTION`) |
| `php -r 'file_put_contents("a.txt","b");'` | DENY | workspace DENY / ask ASK (`MODIFY`) |
| `echo x 2>/dev/null` | `SYSTEM_TAMPERING` CRITICAL_DENY | `READ_ONLY` → ALLOW |
| `echo x 2>>/dev/null` | `SYSTEM_TAMPERING` | `READ_ONLY` → ALLOW |
| `echo x 2>&1` | READ_ONLY (007C) | `READ_ONLY` → ALLOW |
| `echo x > ./safe.txt` | ALLOW | ALLOW (and the file is really written) |
| `echo x > /etc/toolnet-phase4` | CRITICAL_DENY | CRITICAL_DENY, DENY in workspace/ask/full-access |
| `echo x 2>/dev/null > /etc/crontab` | CRITICAL_DENY | CRITICAL_DENY (sink cannot launder a protected write) |
| `php -r 'shell_exec("rm -rf /");'`, `python -c '…shutil.rmtree("/")'`, `bash -c 'rm -rf /'`, nested `bash -c` | CRITICAL_DENY | CRITICAL_DENY in every mode |

## Tests

New matrix (Task E, 11 scenarios + Task F):
`src/lib/security/__tests__/securityUsabilityPhase4.test.ts`

Updated suites that previously **encoded** the bug (assertions flipped to fixed
behavior; every destructive CRITICAL_DENY case kept):

- `src/lib/security/__tests__/dynamicExecutionPolicy.test.ts` — now asserts
  read-only php/python/node/bash/sh `EXECUTE`/ALLOW, gated spawn/mutation, and
  CRITICAL_DENY in workspace/ask/full-access.
- `src/lib/security/__tests__/shellRedirectionPolicy.test.ts` — now asserts FD
  semantics (`assessRedirection`, `filesystemRedirectTargets`), ALLOW for
  `/dev/null` forms, and the preserved `/etc` + laundering controls.
- `src/teamwork/__tests__/securityHardeningPhase4.test.ts` — §4 uses a genuinely
  dynamic payload (`bash -c 'cat a | wc -l'`) for the capability-lock cases and
  asserts read-only inline execution is `EXECUTE`/ALLOW.
- `src/teamwork/__tests__/layer4Phase1Security.test.ts` — split into gated
  (spawning) and read-only interpreter cases.

All tests are deterministic: no real providers, no timers, temp dirs only. The
one real execution is a workspace redirect inside a `mkdtemp` directory.

## Validation

| Gate | Result |
|---|---|
| `bun run typecheck` | PASS |
| `bun test` (full) | **3390 pass / 20 skip / 0 fail** (3410 tests, 291 files) |
| `bun run build` | PASS — bun `index.js` 2.80 MB, node `index.js` 2.92 MB |
| `npm pack --dry-run` | PASS — `toolnetcli-1.3.0.tgz`, 6 files |

Baseline before Phase 4 was 3362 pass / 20 skip (3382 tests, 290 files); this
phase adds 28 tests and 1 file with zero failures and zero regressions in the
prior-phase suites (`securityHardeningPhase3`, `securityHardeningRegression`,
`layer4Phase0Baseline`, `layer4Phase1Security`).

## Files changed

- `src/lib/security/shellParser.ts` — `php` interpreter, `INTERPRETER_INLINE_FLAGS`,
  `inlineScriptIntent` + pattern tables, script-scoped shell-variable handling.
- `src/lib/security/commandClassifier.ts` — `HARMLESS_SINKS`,
  `isHarmlessSinkPath`, `assessRedirection`, `filesystemRedirectTargets`,
  FD-aware redirect/argument checks, intent-aware interpreter gates.
- `src/lib/security/securityEngine.ts` — intent-aware
  `inlineInterpreterCapability`, read-only inline interpreter short-circuit,
  removal of blanket interpreter regexes, FD-aware absolute-path scan.
- `src/lib/security/__tests__/securityUsabilityPhase4.test.ts` (new),
  `dynamicExecutionPolicy.test.ts`, `shellRedirectionPolicy.test.ts`,
  `src/teamwork/__tests__/securityHardeningPhase4.test.ts`,
  `src/teamwork/__tests__/layer4Phase1Security.test.ts`.

## FINAL

- php -r safe inspection: FIXED — read-only `php -r` scripts classify as
  `EXECUTE` and are ALLOWed under workspace policy (no `DYNAMIC_EXECUTION`
  lock); spawning/mutating payloads stay gated (DYNAMIC_EXECUTION/MODIFY →
  workspace DENY, ask ASK).
- /dev/null: FIXED — `2>/dev/null`, `2>>/dev/null` and `> /dev/null` are
  FD-aware discard sinks, class `READ_ONLY`, ALLOW in workspace mode; never
  `SYSTEM_TAMPERING`.
- 2>&1: VERIFIED — fd duplication, `writesFilesystem: false`, `READ_ONLY`,
  ALLOW (TN-R0-007C preserved).
- Protected writes: PRESERVED — `> /etc/...` (and a sink next to it) stays
  `SYSTEM_TAMPERING` / `CRITICAL_DENY` / DENY in workspace, ask and full-access.
- Destructive controls: PRESERVED — `php -r 'shell_exec("rm -rf /")'`,
  `python -c 'shutil.rmtree("/")'`, `node -e` exec, `bash -c 'rm -rf /'` and
  nested `bash -c` stay CRITICAL_DENY in every mode; `userApproved` cannot
  override a hard DENY.
- Full tests: PASS — 3390 pass / 20 skip / 0 fail (3410 tests, 291 files);
  typecheck, build and `npm pack --dry-run` all PASS.
