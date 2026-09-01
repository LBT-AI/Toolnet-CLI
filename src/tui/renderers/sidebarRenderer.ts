import { A } from "../../term";
import { truncate } from "../layout";
import { getGlobalTracker, getBudgetConfig } from "../../lib/usage";
import { activeSchedulers } from "../../teamwork/dynamicScheduler";
import { backgroundTasks } from "../../lib/backgroundTasks";

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "openai/gpt-4o": 128000,
  "openai/gpt-4o-mini": 128000,
  "anthropic/claude-3-5-sonnet": 200000,
  "anthropic/claude-3-opus": 200000,
  "google/gemini-2.0-flash": 1000000,
  "google/gemini-1.5-pro": 2000000,
  "deepseek/deepseek-chat": 64000,
};

export function renderSidebar(currentModel: string, startTime: number, panelWidth = 40): string[] {
  const panelLines: string[] = [];
  const pad = (str: string) => {
    const stripped = str.replace(/\x1b\[[^m]*m/g, "");
    return str + " ".repeat(Math.max(0, panelWidth - stripped.length));
  };

  // 1. Usage & Token Accounting
  const tracker = getGlobalTracker();
  const usage = tracker.getSessionUsage();
  const budget = getBudgetConfig();

  panelLines.push(A.bgSurface + A.fgCyan + A.bold + pad(" Token & Usage Metrics") + A.reset);
  panelLines.push(A.bgSurface + pad("─".repeat(panelWidth)) + A.reset);

  const isModelValid = Boolean(currentModel && currentModel !== "default" && currentModel !== "none" && currentModel !== "Not selected");
  const modelShort = truncate(isModelValid ? currentModel : "Not selected", panelWidth - 8);
  const modelColor = isModelValid ? A.fgText : A.fgYellow;
  panelLines.push(A.bgSurface + pad(` Model: ${modelColor}${modelShort}${A.reset}`) + A.reset);

  const totalTokens = usage.totalTokens || 0;
  const inTokens = usage.inputTokens || 0;
  const outTokens = usage.outputTokens || 0;
  panelLines.push(A.bgSurface + pad(` Tokens: ${A.fgYellow}${totalTokens.toLocaleString()}${A.reset} (${inTokens} in / ${outTokens} out)`) + A.reset);

  // Context %
  const modelLimit = MODEL_CONTEXT_LIMITS[currentModel] || 128000;
  const contextPct = ((totalTokens / modelLimit) * 100).toFixed(1);
  panelLines.push(A.bgSurface + pad(` Context: ${A.fgBlue}${contextPct}%${A.reset} of ${(modelLimit / 1000).toFixed(0)}k`) + A.reset);

  // Cost & Budget %
  if (usage.estimatedCostUsd !== null) {
    const costStr = `$${usage.estimatedCostUsd.toFixed(4)}`;
    if (budget.budgetUsd !== null && budget.budgetUsd > 0) {
      const budgetPct = ((usage.estimatedCostUsd / budget.budgetUsd) * 100).toFixed(1);
      panelLines.push(A.bgSurface + pad(` Cost: ${A.fgGreen}${costStr}${A.reset} (${budgetPct}% of $${budget.budgetUsd})`) + A.reset);
    } else {
      panelLines.push(A.bgSurface + pad(` Cost: ${A.fgGreen}${costStr}${A.reset}`) + A.reset);
    }
  }

  // Session Duration
  if (startTime > 0) {
    const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsedSec / 60);
    const secs = elapsedSec % 60;
    const durStr = `${mins}m ${secs}s`;
    panelLines.push(A.bgSurface + pad(` Duration: ${A.fgSubtext}${durStr}${A.reset}`) + A.reset);
  }

  panelLines.push(A.bgSurface + pad(" ") + A.reset);

  // 2. Teamwork & Subagents
  const scheds = Array.from(activeSchedulers);
  if (scheds.length > 0) {
    panelLines.push(A.bgSurface + A.fgYellow + A.bold + pad(" Active Subagents") + A.reset);
    for (const s of scheds) {
      const state = s.getState();
      const activeCount = state.activeWorkers || 0;
      const maxCount = state.maxWorkers || 1;
      const line = `  [${state.status}] W:${activeCount}/${maxCount} T:${state.completedTaskIds.length}/${state.graph?.nodes?.length || 0}`;
      panelLines.push(A.bgSurface + A.fgText + pad(line) + A.reset);

      for (const tid of (state.runningTaskIds || [])) {
        const node = s.getReadyNodes().find((n) => n.id === tid) || (Array.isArray(state.graph?.nodes) ? (state.graph!.nodes as any[]).find((n: any) => n.id === tid) : undefined);
        if (node) {
          const nLine = `   - ${node.role || "Agent"}: ${node.title}`;
          panelLines.push(A.bgSurface + A.fgSubtext + pad(truncate(nLine, panelWidth - 2)) + A.reset);
        }
      }
    }
    panelLines.push(A.bgSurface + pad(" ") + A.reset);
  }

  // 3. Background Tasks
  const tasks = backgroundTasks.getActiveTasks();
  if (tasks.length > 0) {
    panelLines.push(A.bgSurface + A.fgCyan + A.bold + pad(" Background Tasks") + A.reset);
    for (const t of tasks) {
      const line = `  [${t.status}] ${t.name}`;
      panelLines.push(A.bgSurface + A.fgText + pad(truncate(line, panelWidth - 2)) + A.reset);
    }
    panelLines.push(A.bgSurface + pad(" ") + A.reset);
  }

  return panelLines;
}
