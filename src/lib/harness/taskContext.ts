/**
 * ActiveTaskContext — §3 + §12
 *
 * Tracks the current task's goal, files, URLs, plan, constraints, and requirements
 * across multiple turns so follow-up messages like "tiếp", "sửa cái đó" are resolved
 * against the active context instead of being treated as fresh standalone prompts.
 */

import type { ActiveTaskContext, Requirement } from "./types";

const EMPTY: ActiveTaskContext = {
  currentFiles: [],
  currentUrls: [],
  currentPlan: [],
  completedSteps: [],
  pendingSteps: [],
  constraints: [],
  requirements: [],
};

function clone(ctx: ActiveTaskContext): ActiveTaskContext {
  return {
    currentGoal: ctx.currentGoal,
    currentFiles: [...ctx.currentFiles],
    currentUrls: [...ctx.currentUrls],
    currentPlan: [...ctx.currentPlan],
    completedSteps: [...ctx.completedSteps],
    pendingSteps: [...ctx.pendingSteps],
    constraints: [...ctx.constraints],
    requirements: ctx.requirements.map((r) => ({ ...r })),
  };
}

export class TaskContextManager {
  private ctx: ActiveTaskContext;

  constructor() {
    this.ctx = {
      currentGoal: undefined,
      currentFiles: [],
      currentUrls: [],
      currentPlan: [],
      completedSteps: [],
      pendingSteps: [],
      constraints: [],
      requirements: [],
    };
  }

  getContext(): ActiveTaskContext {
    return clone(this.ctx);
  }

  setGoal(goal: string): void {
    this.ctx.currentGoal = goal;
  }

  addFiles(files: string[]): void {
    for (const f of files) {
      if (!this.ctx.currentFiles.includes(f)) this.ctx.currentFiles.push(f);
    }
  }

  addUrls(urls: string[]): void {
    for (const u of urls) {
      if (!this.ctx.currentUrls.includes(u)) this.ctx.currentUrls.push(u);
    }
  }

  setPlan(plan: string[]): void {
    this.ctx.currentPlan = [...plan];
    this.ctx.pendingSteps = [...plan];
    this.ctx.completedSteps = [];
  }

  completeStep(step: string): void {
    this.ctx.completedSteps.push(step);
    this.ctx.pendingSteps = this.ctx.pendingSteps.filter((s) => s !== step);
  }

  addConstraint(constraint: string): void {
    if (!this.ctx.constraints.includes(constraint)) this.ctx.constraints.push(constraint);
  }

  setRequirements(reqs: Requirement[]): void {
    this.ctx.requirements = reqs.map((r) => ({ ...r }));
  }

  satisfyRequirement(id: string): void {
    const r = this.ctx.requirements.find((x) => x.id === id);
    if (r) r.status = "satisfied";
  }

  blockRequirement(id: string): void {
    const r = this.ctx.requirements.find((x) => x.id === id);
    if (r) r.status = "blocked";
  }

  reset(): void {
    this.ctx = {
      currentGoal: undefined,
      currentFiles: [],
      currentUrls: [],
      currentPlan: [],
      completedSteps: [],
      pendingSteps: [],
      constraints: [],
      requirements: [],
    };
  }
}
