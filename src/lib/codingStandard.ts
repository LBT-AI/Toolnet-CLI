/**
 * ToolNet Coding Standard — mandatory rules for all code generated or
 * modified by ToolNet (both ToolNet's own code and user project code).
 */

export const CODING_STANDARD = `CODING STANDARD — MANDATORY
All code you create or modify MUST follow these rules:

1. Guard Clauses / Early Return
   - Use guard clauses as the default style.
   - Prefer:
       if (!user) return;
       if (!isValid(input)) return error("Invalid input");
       if (signal.aborted) throw new AbortError();
       doWork();
   - Avoid nested if/else when early return is possible.

2. Avoid nested if/else
   - If a branch returns/throws/continues, do not use an else.
   - Prefer:
       if (!result.success) {
         return handleFailure(result);
       }
       return handleSuccess(result);
   - Avoid:
       if (!result.success) {
         return handleFailure(result);
       } else {
         return handleSuccess(result);
       }

3. Clean, structured code
   - Each function does one clear thing.
   - Avoid overly long functions.
   - Avoid duplicate logic.
   - Split modules when responsibilities differ.
   - Do not create meaningless abstractions.
   - Do not rewrite an entire file for a small localized change.

4. Meaningful names
   - Prefer:
       resolveWorkspacePath()
       validateToolArguments()
       executeToolCall()
       verifyFileMutation()
       activeModelCapabilities
   - Avoid:
       doIt(), handle2(), data1, tmp, x, foo
     except for very short local scope variables.

5. Comments explain WHY, not WHAT
   - Do not restate the code in comments.
   - Comment only when explaining:
       * architectural decisions
       * edge cases
       * protocol behavior
       * compatibility workarounds
       * security constraints

6. Follow existing project conventions
   - Before editing, inspect surrounding code.
   - Match naming, imports, error patterns, and test patterns.
   - Do not impose personal style that breaks project consistency.

7. Mandatory error handling
   - Do not swallow errors silently.
   - Return typed errors, throw meaningful errors, or propagate correctly.
   - Never log secrets, API keys, or tokens.

8. Structured logging
   - Prefer:
       logger.debug("tool execution started", {
         tool: toolCall.name,
         callId: toolCall.id,
       });
   - Avoid random console.log statements in production code.

9. Tests for important logic changes
   - Required for:
       * bug fixes
       * parsers
       * state machines
       * tool execution
       * permission logic
       * filesystem mutations
       * abort lifecycle
       * model adapters
       * prior regressions

10. Side effects must be verified
    - Do not assume success just because a function did not throw.
    - Example:
        const result = await writeFile(...);
        if (!result.success) return result;
        const exists = await fileExists(path);
        if (!exists) return failure(\`File was not created: \${path}\`);
        return result;

11. Clear async lifecycle
    - Long-running operations must use:
        * AbortSignal
        * timeouts when appropriate
        * cleanup
        * no orphan processes
        * no leaked timers/listeners

12. Do not destroy user code
    - Before editing:
        * inspect git status
        * read related files
        * preserve unrelated changes
        * do not reset/revert/overwrite outside the requested scope

13. Verify after changes
    - Use the appropriate level:
        focused test
        → typecheck
        → lint
        → build
        → broader tests
    - Do not say "done" if verification was skipped when it was feasible.

14. Prefer maintainability over brevity
    - Do not write hard-to-read one-liners just to save lines.

15. When multiple implementations are possible, prefer in this order:
    Correctness → Safety → Maintainability → Readability → Testability → Performance → Brevity`;

export function getCodingStandardBlock(): string {
  return CODING_STANDARD;
}
