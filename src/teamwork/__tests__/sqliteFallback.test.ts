import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonFileDatabase } from "../sqliteMock";

const temporaryDirectories: string[] = [];

function createDatabasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-sqlite-fallback-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "session.db");
}

function createCheckpointTable(db: JsonFileDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      sessionId TEXT,
      milestoneTag TEXT,
      timestamp INTEGER,
      data TEXT
    )
  `);
}

function createContextCacheTable(db: JsonFileDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_cache (
      id TEXT PRIMARY KEY,
      astHash TEXT,
      dependencyGraph TEXT,
      fileMaps TEXT,
      timestamp INTEGER
    )
  `);
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (!directory) continue;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("JsonFileDatabase durable fallback", () => {
  test("persists checkpoint rows across database instances", () => {
    const dbPath = createDatabasePath();
    const db = new JsonFileDatabase(dbPath);
    createCheckpointTable(db);

    db.query(`
      INSERT INTO checkpoints (id, sessionId, milestoneTag, timestamp, data)
      VALUES ($id, $sessionId, $milestoneTag, $timestamp, $data)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, timestamp=excluded.timestamp
    `).run({
      $id: "cp-1",
      $sessionId: "session-a",
      $milestoneTag: "initial",
      $timestamp: 100,
      $data: "first",
    });

    const reopened = new JsonFileDatabase(dbPath);
    createCheckpointTable(reopened);
    const row = reopened.query("SELECT data FROM checkpoints WHERE id = $id").get({ $id: "cp-1" }) as {
      data?: string;
    } | null;

    expect(row?.data).toBe("first");
    expect(fs.existsSync(`${dbPath}.json`)).toBe(true);
  });

  test("upserts rows and returns the latest checkpoint", () => {
    const dbPath = createDatabasePath();
    const db = new JsonFileDatabase(dbPath);
    createCheckpointTable(db);

    const insert = db.query(`
      INSERT INTO checkpoints (id, sessionId, milestoneTag, timestamp, data)
      VALUES ($id, $sessionId, $milestoneTag, $timestamp, $data)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, timestamp=excluded.timestamp
    `);

    insert.run({
      $id: "cp-old",
      $sessionId: "session-a",
      $milestoneTag: "old",
      $timestamp: 100,
      $data: "old",
    });
    insert.run({
      $id: "cp-new",
      $sessionId: "session-a",
      $milestoneTag: "new",
      $timestamp: 200,
      $data: "new",
    });
    insert.run({
      $id: "cp-new",
      $sessionId: "session-a",
      $milestoneTag: "new",
      $timestamp: 300,
      $data: "updated",
    });

    const latest = db
      .query("SELECT data FROM checkpoints WHERE sessionId = $sessionId ORDER BY timestamp DESC LIMIT 1")
      .get({ $sessionId: "session-a" }) as { data?: string } | null;

    expect(latest?.data).toBe("updated");
  });

  test("does not clobber tables when multiple adapters share one database path", () => {
    const dbPath = createDatabasePath();
    const checkpointDb = new JsonFileDatabase(dbPath);
    const cacheDb = new JsonFileDatabase(dbPath);

    createCheckpointTable(checkpointDb);
    createContextCacheTable(cacheDb);

    checkpointDb.query(`
      INSERT INTO checkpoints (id, sessionId, milestoneTag, timestamp, data)
      VALUES ($id, $sessionId, $milestoneTag, $timestamp, $data)
      ON CONFLICT(id) DO UPDATE SET data=excluded.data, timestamp=excluded.timestamp
    `).run({
      $id: "cp-1",
      $sessionId: "session-a",
      $milestoneTag: "checkpoint",
      $timestamp: 100,
      $data: "checkpoint-data",
    });

    cacheDb.query(`
      INSERT INTO context_cache (id, astHash, dependencyGraph, fileMaps, timestamp)
      VALUES ($id, $astHash, $dependencyGraph, $fileMaps, $timestamp)
      ON CONFLICT(id) DO UPDATE SET
        astHash=excluded.astHash,
        dependencyGraph=excluded.dependencyGraph,
        fileMaps=excluded.fileMaps,
        timestamp=excluded.timestamp
    `).run({
      $id: "cache-1",
      $astHash: "abc123",
      $dependencyGraph: "graph",
      $fileMaps: "files",
      $timestamp: 200,
    });

    const reopened = new JsonFileDatabase(dbPath);
    const checkpoint = reopened.query("SELECT data FROM checkpoints WHERE id = $id").get({ $id: "cp-1" }) as {
      data?: string;
    } | null;
    const cache = reopened.query("SELECT * FROM context_cache WHERE id = $id").get({ $id: "cache-1" }) as {
      astHash?: string;
    } | null;

    expect(checkpoint?.data).toBe("checkpoint-data");
    expect(cache?.astHash).toBe("abc123");
  });

  test("fails loudly for unsupported SQL instead of silently discarding data", () => {
    const dbPath = createDatabasePath();
    const db = new JsonFileDatabase(dbPath);

    expect(() => db.exec("DROP TABLE checkpoints")).toThrow("Unsupported JSON database exec statement");
    expect(() => db.query("DELETE FROM checkpoints").run()).toThrow("Unsupported JSON database write statement");
  });
});
