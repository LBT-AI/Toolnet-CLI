import type { EvalSuite, EvalCase } from "./types";

const cases: EvalCase[] = [];
for (let i = 1; i <= 20; i++) {
  cases.push({
    id: `phase87-case-${i}`,
 name: ` Evaluation Case ${i}`,
    type: "CODE",
    dimension: "coding",
    prompt: `Analyze the workspace, plan a change for bug ${i}, and verify the fix.`,
    grader: { kind: "file-mutation", path: `src/fix${i}.ts`, expectAbsent: false },
    requiredCapabilities: { tools: true },
  });
}

export const phase87Suite: EvalSuite = {
  id: "phase87",
  version: "1.0.0",
 name: " Verified Coding",
  description: "Suite with 20 specific coding fixtures for edit-verify-test-repair loop.",
  cases,
};
