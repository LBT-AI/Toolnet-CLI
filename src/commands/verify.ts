import { repositoryIntelligence } from "../core/repo";
import { currentCwd } from "../lib/codingAgent";
import { execSync } from "node:child_process";

export async function runVerifyCommand(args: string[]) {
  const cwd = currentCwd || process.cwd();
  const ctx = await repositoryIntelligence.getCompactContext(cwd);
  
  console.log(`Verifying workspace at ${ctx.profile.root}`);
  const commands = [...ctx.profile.buildSystems.map(b => b === "cargo" ? "cargo check" : ""), "typecheck", "lint"].filter(Boolean);
  
  // Very simple fallback verification runner for CLI
  for (const cmd of commands) {
    if (cmd) {
       try {
         console.log(`Running verification: ${cmd}`);
         // Just an example for the CLI command
         if (cmd === "typecheck" && ctx.profile.packageManagers.includes("bun")) {
           execSync("bun run typecheck", { cwd: ctx.profile.root, stdio: "inherit" });
         } else if (cmd === "lint" && ctx.profile.packageManagers.includes("bun")) {
           execSync("bun run lint", { cwd: ctx.profile.root, stdio: "inherit" });
         } else if (cmd === "cargo check") {
           execSync(cmd, { cwd: ctx.profile.root, stdio: "inherit" });
         }
       } catch (e) {
         console.error(`Verification failed: ${cmd}`);
         process.exit(1);
       }
    }
  }
  console.log("Verification passed.");
}
