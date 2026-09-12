/** Eval fixture verification script — already passing before the run. */
import { double } from "./math";

if (double(21) !== 42) {
  console.error("double(21) should be 42");
  process.exit(1);
}

console.log("ok");
