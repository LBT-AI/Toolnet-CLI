# Phase 87: Advanced Coding Agent & Repository Intelligence

## Summary
This phase introduced the `RepositoryIntelligence` service to build out repository mapping, instruction loading, and change impact planning. The execution loop remains single-threaded via `AgentHarness` and `AgentEngine`. The new context is seamlessly injected into the active task prompt without bypassing tool gateway restrictions or creating rogue subagents.

## Architectural Changes

1. **Repository Intelligence Core (`src/core/repo/`)**:
   - `profile.ts`: Deterministic project identification, finding frameworks, tests, package managers, and root contexts.
   - `map.ts`: Bounded `RepoMapNode` extraction that analyzes a limited workspace depth for symbols using LSP or fallback heuristics.
   - `instructions.ts`: Cached and scoped lookup of `AGENTS.md` instructions following closest-match precedence.
   - `changeImpact.ts`: Lightweight detection of likely edited files, testing requirements, and change risk.
   - `intelligence.ts`: Facade singleton that aggregates these modules into a single `CompactRepoContext`.

2. **Harness Integration**:
   - `AgentHarness.buildSystemPrompt` is now asynchronously backed to embed the `RepositoryIntelligence` output directly into `projectSummary`.
   - Replaced duplicate execution attempts or out-of-bounds loops with robust prompt conditioning (plan first, execute cautiously).

3. **Execution Evidence**:
   - Extended `ExecutionEvidence` to explicitly capture verification pipeline data: `changedFiles`, `verifiedMutations`, `diagnosticsBefore`, `diagnosticsAfter`, `testsPassed`, `testsFailed`, `builds`, and `verificationFailures`.
   - Correctly recorded in the execution ledger.

4. **CLI Commands**:
   - Introduced `toolnet repo [status|map|explain|instructions]` subcommands to expose `RepositoryIntelligence` capabilities.
   - Introduced `toolnet verify` as a fallback CLI check for the user.

5. **Evaluation Suite**:
   - Injected a rigorous `phase87Suite` inside `EvalRunner` boasting 20 strict coding fixtures mapped to the new edit-verify-test-repair loop.

## Invariants Maintained
- NO new secondary agent loops were created.
- NO `child_process.exec` workarounds bypass the `ToolGateway`.
- NO direct file edits occur without traversing `ToolGateway`.
- ONE unified `CompletionVerdict`.
- Verified `AgentHarness` event streams remain the single source of truth for execution evidence.

## Verification
- Tests passed clean natively.
- CI pipeline green.
- Artifacts generated deterministically.
