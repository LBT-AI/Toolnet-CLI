/**
 * Canonical async mutation helper for the TUI.
 *
 * Every consequential UI action (rename, delete, fork, permission reply,
 * compact, provider/model selection) flows through this state machine:
 *
 *   idle → pending → success | error
 *
 * The helper owns three guarantees the UI depends on:
 *   1. Double-submit lock: a second `execute` while pending is rejected, so a
 *      double-pressed Enter can never dispatch a mutation twice.
 *   2. Error capture: the failure is stored on the mutation (`error`) and
 *      surfaced through `onError`, so callers can keep the dialog open and
 *      render the message instead of closing on a failed action.
 *   3. Settled notification: `onSettled` fires exactly once per attempt after
 *      either outcome, which is where the UI flips its spinner off.
 *
 * The UI layer remains presentation-only: business logic stays in the core
 * services the mutation callbacks invoke.
 */

export type MutationState = "idle" | "pending" | "success" | "error";

export interface AsyncMutation<TInput, TOutput> {
  readonly state: MutationState;
  readonly error: Error | null;
  execute(input: TInput): Promise<TOutput>;
  reset(): void;
}

export interface AsyncMutationOptions<TOutput> {
  onSuccess?: (result: TOutput) => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
}

export class MutationAlreadyPendingError extends Error {
  constructor() {
    super("Mutation is already pending; duplicate execution blocked");
    this.name = "MutationAlreadyPendingError";
  }
}

export function createAsyncMutation<TInput, TOutput>(
  mutationFn: (input: TInput) => Promise<TOutput>,
  options?: AsyncMutationOptions<TOutput>,
): AsyncMutation<TInput, TOutput> {
  let state: MutationState = "idle";
  let error: Error | null = null;
  let activePromise: Promise<TOutput> | null = null;

  return {
    get state() {
      return state;
    },
    get error() {
      return error;
    },
    execute(input: TInput): Promise<TOutput> {
      if (state === "pending" && activePromise) {
        return Promise.reject(new MutationAlreadyPendingError());
      }

      state = "pending";
      error = null;

      activePromise = (async () => {
        try {
          const result = await mutationFn(input);
          state = "success";
          options?.onSuccess?.(result);
          return result;
        } catch (err) {
          const errObj = err instanceof Error ? err : new Error(String(err));
          state = "error";
          error = errObj;
          options?.onError?.(errObj);
          throw errObj;
        } finally {
          activePromise = null;
          options?.onSettled?.();
        }
      })();

      return activePromise;
    },
    reset() {
      state = "idle";
      error = null;
      activePromise = null;
    },
  };
}
