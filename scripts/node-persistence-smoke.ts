import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "../src/teamwork/sqliteMock";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "toolnet-node-persistence-"));
const dbPath = path.join(directory, "session.db");

function cleanup(): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

try {
  const db = new Database(dbPath, { create: true });
  db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      sessionId TEXT,
      milestoneTag TEXT,
      timestamp INTEGER,
      data TEXT
    )
  `);

  db.query(`
    INSERT INTO checkpoints (id, sessionId, milestoneTag, timestamp, data)
    VALUES ($id, $sessionId, $milestoneTag, $timestamp, $data)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data, timestamp=excluded.timestamp
  `).run({
    $id: "node-smoke",
    $sessionId: "ci",
    $milestoneTag: "persistence",
    $timestamp: Date.now(),
    $data: "durable",
  });

  const reopened = new Database(dbPath, { create: true });
  const row = reopened.query("SELECT data FROM checkpoints WHERE id = $id").get({ $id: "node-smoke" }) as {
    data?: string;
  } | null;

  if (row?.data !== "durable") {
    throw new Error("Node persistence smoke test failed: checkpoint was not recovered");
  }

  process.stdout.write("Node persistence smoke test passed\n");
} finally {
  cleanup();
}
