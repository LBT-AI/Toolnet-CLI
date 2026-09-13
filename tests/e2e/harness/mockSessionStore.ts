export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  model: string;
  forkedFrom?: string;
}

export class MockSessionStore {
  private sessions = new Map<string, SessionSummary>();

  constructor() {
    this.seedDefaults();
  }

  private seedDefaults() {
    this.createSession({
      id: "session-alpha",
      title: "Initial development session",
      updatedAt: Date.now() - 3600_000,
      messageCount: 12,
      model: "toolnet/gpt-4o",
    });
    this.createSession({
      id: "session-beta",
      title: "Refactoring layout and styles",
      updatedAt: Date.now() - 7200_000,
      messageCount: 34,
      model: "toolnet/claude-3-5-sonnet",
    });
  }

  public createSession(summary: SessionSummary): SessionSummary {
    this.sessions.set(summary.id, { ...summary });
    return summary;
  }

  public listSummaries(): SessionSummary[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  public getSession(id: string): SessionSummary | null {
    return this.sessions.get(id) || null;
  }

  public renameSession(id: string, newTitle: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.title = newTitle;
    s.updatedAt = Date.now();
    return true;
  }

  public forkSession(sourceId: string, newId: string, newTitle?: string): SessionSummary | null {
    const s = this.sessions.get(sourceId);
    if (!s) return null;
    const forked: SessionSummary = {
      id: newId,
      title: newTitle || `Fork of ${s.title}`,
      updatedAt: Date.now(),
      messageCount: s.messageCount,
      model: s.model,
      forkedFrom: sourceId,
    };
    this.sessions.set(newId, forked);
    return forked;
  }

  public deleteSession(id: string): boolean {
    return this.sessions.delete(id);
  }
}
