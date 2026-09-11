/**
 * Phase 76A.4 / 76A.6 — Session Inbox
 *
 * The notification channel that replaces polling. When background work settles,
 * a synthetic message is pushed into the owning session's inbox. The agent loop
 * drains it before the next model turn, so the parent learns about the result
 * through its own conversation instead of sleeping and re-checking status.
 *
 * Deliberately tiny and synchronous: no timers, no subscriptions to leak.
 */

export interface InboxMessage {
  id: string;
  sessionId: string;
  /** Job that produced this message, when applicable. */
  jobId?: string;
  createdAt: number;
  /** Synthetic content injected as a user-role message. */
  content: string;
  /** Marks the message as runtime-generated (never user-authored). */
  synthetic: true;
  metadata?: Record<string, unknown>;
}

export class SessionInbox {
  private readonly bySession = new Map<string, InboxMessage[]>();
  private sequence = 0;

  push(
    sessionId: string,
    content: string,
    options: { jobId?: string; metadata?: Record<string, unknown> } = {}
  ): InboxMessage | undefined {
    const session = sessionId?.trim();
    const body = content?.trim();
    if (!session || !body) return undefined;

    this.sequence++;
    const message: InboxMessage = {
      id: `inbox_${Date.now().toString(36)}_${this.sequence}`,
      sessionId: session,
      createdAt: Date.now(),
      content: body,
      synthetic: true,
      ...(options.jobId ? { jobId: options.jobId } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    };

    const bucket = this.bySession.get(session);
    if (bucket) bucket.push(message);
    else this.bySession.set(session, [message]);

    return message;
  }

  /** Take everything pending for a session (empties the inbox). */
  drain(sessionId: string): InboxMessage[] {
    const bucket = this.bySession.get(sessionId);
    if (!bucket || bucket.length === 0) return [];
    this.bySession.delete(sessionId);
    return bucket;
  }

  peek(sessionId: string): InboxMessage[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  count(sessionId?: string): number {
    if (sessionId) return this.bySession.get(sessionId)?.length ?? 0;
    let total = 0;
    for (const bucket of this.bySession.values()) total += bucket.length;
    return total;
  }

  clear(sessionId?: string): void {
    if (sessionId) this.bySession.delete(sessionId);
    else this.bySession.clear();
  }
}

/** Process-wide inbox; tests construct isolated instances. */
export const sessionInbox = new SessionInbox();

/**
 * Wrap a settled background job as a synthetic turn for its parent session.
 * Kept pure and shared so the envelope has exactly one author.
 */
export function renderBackgroundNotification(input: {
  jobId: string;
  title: string;
  status: "completed" | "error" | "cancelled";
  summary: string;
  output?: string;
}): string {
  const body = input.output?.trim();
  const lines = [
    `<task id="${input.jobId}" state="${input.status}">`,
    `  <summary>${input.title}</summary>`,
    `  <subagent_output>`,
    body || input.summary,
    `  </subagent_output>`,
    `</task>`,
    "",
    "This result arrived from a background task while you were working. Continue with your own task — do not re-run this work, and do not poll for other background jobs.",
  ];
  return lines.join("\n");
}
