import { createSignal } from "solid-js";
import type { TaskNode, SchedulerState } from "./types";

export const [isDashboardActive, setIsDashboardActive] = createSignal(false);
export const [dashboardNodes, setDashboardNodes] = createSignal<TaskNode[]>([]);
export const [dashboardState, setDashboardState] = createSignal<SchedulerState | null>(null);
