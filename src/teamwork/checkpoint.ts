import { Database } from "bun:sqlite";
import path from "path";
import type { CheckpointSnapshot } from "./types";

export class CheckpointManager {
  private db: Database;

  constructor(dbPath: string = 'session.db') {
    this.db = new Database(path.resolve(process.cwd(), dbPath), { create: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        sessionId TEXT,
        milestoneTag TEXT,
        timestamp INTEGER,
        data TEXT
      )
    `);
  }

  saveCheckpoint(snapshot: CheckpointSnapshot) {
    const query = this.db.query(`
      INSERT INTO checkpoints (id, sessionId, milestoneTag, timestamp, data) 
      VALUES ($id, $sessionId, $milestoneTag, $timestamp, $data)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, timestamp=excluded.timestamp
    `);
    query.run({
      $id: snapshot.id,
      $sessionId: snapshot.sessionId,
      $milestoneTag: snapshot.milestoneTag,
      $timestamp: snapshot.timestamp,
      $data: JSON.stringify(snapshot)
    });
  }

  resumeFromCheckpoint(checkpointId: string): CheckpointSnapshot | null {
    const row = this.db.query('SELECT data FROM checkpoints WHERE id = $id').get({ $id: checkpointId }) as any;
    if (!row) return null;
    return JSON.parse(row.data) as CheckpointSnapshot;
  }
  
  getLatestCheckpoint(sessionId: string): CheckpointSnapshot | null {
    const row = this.db.query('SELECT data FROM checkpoints WHERE sessionId = $sessionId ORDER BY timestamp DESC LIMIT 1').get({ $sessionId: sessionId }) as any;
    if (!row) return null;
    return JSON.parse(row.data) as CheckpointSnapshot;
  }
}
