
export interface CommandExecution {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  cwd: string;
}

export interface TestExecution {
  command: string;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  testCount?: number;
  failureCount?: number;
}

export interface AgentChangeSet {
  createdFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  commandsRun: CommandExecution[];
  testsRun: TestExecution[];
}

export class ChangeTracker {
  private changes: AgentChangeSet = {
    createdFiles: [],
    modifiedFiles: [],
    deletedFiles: [],
    commandsRun: [],
    testsRun: [],
  };

  trackCreated(filePath: string): void {
    if (!this.changes.createdFiles.includes(filePath)) {
      this.changes.createdFiles.push(filePath);
    }
  }

  trackModified(filePath: string): void {
    if (!this.changes.modifiedFiles.includes(filePath)) {
      this.changes.modifiedFiles.push(filePath);
    }
  }

  trackDeleted(filePath: string): void {
    if (!this.changes.deletedFiles.includes(filePath)) {
      this.changes.deletedFiles.push(filePath);
    }
  }

  trackCommand(execution: CommandExecution): void {
    this.changes.commandsRun.push(execution);
  }

  trackTest(execution: TestExecution): void {
    this.changes.testsRun.push(execution);
  }

  getChangeSet(): AgentChangeSet {
    return {
      createdFiles: [...this.changes.createdFiles],
      modifiedFiles: [...this.changes.modifiedFiles],
      deletedFiles: [...this.changes.deletedFiles],
      commandsRun: [...this.changes.commandsRun],
      testsRun: [...this.changes.testsRun],
    };
  }

  reset(): void {
    this.changes = {
      createdFiles: [],
      modifiedFiles: [],
      deletedFiles: [],
      commandsRun: [],
      testsRun: [],
    };
  }

  getSummary(): string {
    const parts: string[] = [];
    if (this.changes.createdFiles.length > 0) {
      parts.push(`Created: ${this.changes.createdFiles.join(", ")}`);
    }
    if (this.changes.modifiedFiles.length > 0) {
      parts.push(`Modified: ${this.changes.modifiedFiles.join(", ")}`);
    }
    if (this.changes.deletedFiles.length > 0) {
      parts.push(`Deleted: ${this.changes.deletedFiles.join(", ")}`);
    }
    if (this.changes.commandsRun.length > 0) {
      parts.push(`Commands: ${this.changes.commandsRun.length} run`);
    }
    if (this.changes.testsRun.length > 0) {
      const passed = this.changes.testsRun.filter((t) => t.passed).length;
      parts.push(`Tests: ${passed}/${this.changes.testsRun.length} passed`);
    }
    return parts.join("\n") || "No changes made";
  }
}
