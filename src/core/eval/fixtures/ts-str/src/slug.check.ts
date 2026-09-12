/** Eval fixture verification script (see ts-bug/src/sum.check.ts for the rationale). */
import { slug } from "./slug";

const cases: Array<[string, string]> = [
  ["  Hello-World  ", "hello-world"],
  ["Already-Lower", "already-lower"],
];

for (const [input, expected] of cases) {
  const actual = slug(input);
  if (actual !== expected) {
    console.error(`slug(${JSON.stringify(input)}) = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    process.exit(1);
  }
}

console.log("ok");
