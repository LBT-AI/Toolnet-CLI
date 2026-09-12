/**
 * Phase 80 §15 — Eval store schema version. Bumped whenever `EvalRunRecord`
 * changes shape; the store refuses to read a record written by a newer schema
 * and skips (never throws on) an invalid line.
 */
export const EVAL_RUN_SCHEMA_VERSION = 1;
