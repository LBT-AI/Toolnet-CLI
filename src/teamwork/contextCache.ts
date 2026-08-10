import { Database } from "bun:sqlite";
import path from "path";

export interface ContextCacheData {
  astHash?: string;
  dependencyGraph?: string;
  fileMaps?: string;
  timestamp: number;
}

export class ContextCache {
  private db: Database;

  constructor(dbPath: string = 'session.db') {
    this.db = new Database(path.resolve(process.cwd(), dbPath), { create: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS context_cache (
        id TEXT PRIMARY KEY,
        astHash TEXT,
        dependencyGraph TEXT,
        fileMaps TEXT,
        timestamp INTEGER
      )
    `);
  }

  set(id: string, data: Omit<ContextCacheData, 'timestamp'>) {
    const query = this.db.query(`
      INSERT INTO context_cache (id, astHash, dependencyGraph, fileMaps, timestamp) 
      VALUES ($id, $astHash, $dependencyGraph, $fileMaps, $timestamp)
      ON CONFLICT(id) DO UPDATE SET 
        astHash=excluded.astHash, 
        dependencyGraph=excluded.dependencyGraph, 
        fileMaps=excluded.fileMaps, 
        timestamp=excluded.timestamp
    `);
    query.run({
      $id: id,
      $astHash: data.astHash || '',
      $dependencyGraph: data.dependencyGraph || '',
      $fileMaps: data.fileMaps || '',
      $timestamp: Date.now()
    });
  }

  get(id: string): ContextCacheData | null {
    const row = this.db.query('SELECT * FROM context_cache WHERE id = $id').get({ $id: id }) as any;
    if (!row) return null;
    return {
      astHash: row.astHash,
      dependencyGraph: row.dependencyGraph,
      fileMaps: row.fileMaps,
      timestamp: row.timestamp
    };
  }
}
