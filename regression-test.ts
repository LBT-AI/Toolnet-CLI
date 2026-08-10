import { toolBash } from "./src/lib/codingAgent.js";
import { executeTool } from "./src/lib/agentTools.js";

async function main() {
  console.log("=== REGRESSION TEST: executeTool run_command ===");

  console.log("\n1. Test 'ls /root' (Should have output, exitCode 0)");
  const res1 = await executeTool("run_command", { command: "ls /root" });
  console.log(res1);
  if (!res1.includes("miniconda") || !res1.includes("exitCode")) {
    console.error("FAILED TEST 1");
    process.exit(1);
  }

  console.log("\n2. Test 'find /root -name web-hub' (Should have output, exitCode 0)");
  const res2 = await executeTool("run_command", { command: "find /root -name web-hub" });
  console.log(res2);
  
  console.log("\n3. Test 'echo hello > /dev/null' (No output, exitCode 0)");
  const res3 = await executeTool("run_command", { command: "echo hello > /dev/null" });
  console.log(res3);
  if (!res3.includes('"stdout":""') || !res3.includes('"exitCode":0')) {
    console.error("FAILED TEST 3");
    process.exit(1);
  }

  console.log("\n4. Test 'cat /nonexistent_file' (Should have stderr, exitCode > 0)");
  const res4 = await executeTool("run_command", { command: "cat /nonexistent_file" });
  console.log(res4);
  if (!res4.includes("No such file or directory") || res4.includes('"exitCode":0')) {
    console.error("FAILED TEST 4");
    process.exit(1);
  }

  console.log("\n=== ALL REGRESSION TESTS PASSED ===");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
