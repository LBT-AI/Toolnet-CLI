import { Database } from "bun:sqlite";
import path from "path";

export type EventType = 'TaskCreated' | 'TaskStarted' | 'NeedApproval' | 'ArtifactCreated' | 'TaskCompleted' | 'MergeCompleted';

export class EventBus {
  private db: Database;

  constructor(dbPath: string = 'events.db') {
    this.db = new Database(path.resolve(process.cwd(), dbPath), { create: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        eventType TEXT NOT NULL,
        sessionId TEXT,
        payload TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  emit(eventType: EventType | string, payload: any = {}) {
    const query = this.db.query('INSERT INTO events (eventType, sessionId, payload) VALUES ($eventType, $sessionId, $payload)');
    query.run({
      $eventType: eventType,
      $sessionId: payload.sessionId || 'default',
      $payload: JSON.stringify(payload)
    });
  }

  getEventsBySession(sessionId: string) {
    return this.db.query('SELECT * FROM events WHERE sessionId = $sessionId ORDER BY createdAt ASC').all({ $sessionId: sessionId });
  }
}
