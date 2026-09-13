import { repositoryIntelligence } from "../core/repo";
import { currentCwd } from "../lib/codingAgent";

export async function runRepoCommand(args: string[]) {
  const subCmd = args[0] || "status";
  const cwd = currentCwd || process.cwd();
  
  if (subCmd === "status") {
    const ctx = await repositoryIntelligence.getCompactContext(cwd);
    console.log(JSON.stringify(ctx.profile, null, 2));
  } else if (subCmd === "map") {
    const ctx = await repositoryIntelligence.getCompactContext(cwd);
    console.log(JSON.stringify(ctx.mapNodes, null, 2));
  } else if (subCmd === "explain") {
    const prompt = args.slice(1).join(" ");
    if (!prompt) {
      console.error("Please provide a prompt to explain");
      process.exit(1);
    }
    const impact = await repositoryIntelligence.determineChangeImpact(prompt, cwd);
    console.log(JSON.stringify(impact, null, 2));
  } else if (subCmd === "instructions") {
    const ctx = await repositoryIntelligence.getCompactContext(cwd);
    console.log(JSON.stringify(ctx.instructions, null, 2));
  } else {
    console.error(`Unknown repo command: ${subCmd}`);
    console.log(`Available commands: status, map, explain, instructions`);
    process.exit(1);
  }
}
