/**
 * Eval fixture verification script.
 *
 * Deliberately named `*.check.ts` rather than `*.test.ts`: fixture trees live
 * under `src/`, and the project's own `bun test` run must not execute a script
 * that is SUPPOSED to fail before the agent fixes the bug. The eval case runs
 * it explicitly with `bun run` and grades the real exit code.
 */
import { add } from "./sum";

const cases: Array<[number, number, number]> = [
  [2, 3, 5],
  [0, 0, 0],
  [-4, 1, -3],
];

for (const [a, b, expected] of cases) {
  const actual = add(a, b);
  if (actual !== expected) {
    console.error(`add(${a}, ${b}) = ${actual}, expected ${expected}`);
    process.exit(1);
  }
}

console.log("ok");
