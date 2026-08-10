import { For, Show } from "solid-js";
import { isDashboardActive, dashboardNodes, dashboardState } from "./dashboardState";

export function TeamworkDashboard() {
  const progress = () => {
    const nodes = dashboardNodes();
    if (!nodes || nodes.length === 0) return 0;
    const completed = nodes.filter(n => n.status === 'COMPLETED' || n.status === 'SKIPPED').length;
    return Math.floor((completed / nodes.length) * 100);
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'COMPLETED': return 'green';
      case 'RUNNING': return 'yellow';
      case 'FAILED': return 'red';
      case 'SKIPPED': return 'magenta';
      case 'READY': return 'cyan';
      default: return 'gray';
    }
  };

  return (
    <Show when={isDashboardActive()}>
      <box flexDirection="column" padding={1} borderStyle="rounded" borderColor="cyan">
        <text fg="green">ToolNet Teamwork v2 Live Dashboard</text>
        
        <box marginY={1}>
          <text>Project Progress: </text>
          <text fg="cyan">{`[${'#'.repeat(Math.floor(progress() / 10))}${' '.repeat(10 - Math.floor(progress() / 10))}] ${progress()}%`}</text>
        </box>

        <box flexDirection="column" borderStyle="single" padding={1}>
          <text>Task Graph (DAG):</text>
          <For each={dashboardNodes()}>{node => (
            <text>
               {node.id} ({node.role}): <text fg={getStatusColor(node.status)}>{node.status}</text> {node.title}
            </text>
          )}</For>
        </box>

        <box marginTop={1} justifyContent="space-between">
          <text>Active Workers: <text fg="yellow">{dashboardState()?.activeWorkers || 0}/{dashboardState()?.maxWorkers || 0}</text></text>
          <text>Status: <text fg="magenta">{dashboardState()?.status || 'INITIALIZING'}</text></text>
        </box>
      </box>
    </Show>
  );
}
