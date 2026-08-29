import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export type DatabaseParams = Record<string, unknown>;

export interface DatabaseQuery {
  run(params?: DatabaseParams): unknown;
  get(params?: DatabaseParams): unknown;
  all(params?: DatabaseParams): unknown[];
}

export interface DatabaseLike {
  exec(query: string): unknown;
  query(query: string): DatabaseQuery;
}

type DatabaseConstructor = new (dbPath: string, options?: unknown) => DatabaseLike;

type NativeStatement = {
  run(params?: DatabaseParams): unknown;
  get(params?: DatabaseParams): unknown;
  all(params?: DatabaseParams): unknown[];
};

type NodeDatabaseSync = {
  exec(query: string): unknown;
  prepare(query: string): NativeStatement;
};

type NodeDatabaseSyncConstructor = new (dbPath: string, options?: unknown) => NodeDatabaseSync;

type JsonRow = Record<string, unknown>;

interface JsonDatabaseState {
  version: 1;
  tables: Record<string, JsonRow[]>;
}

const require = createRequire(import.meta.url);
const EMPTY_STATE: JsonDatabaseState = { version: 1, tables: {} };

function isBunRuntime(): boolean {
  if (typeof process === "undefined") return false;
  if (!process.versions) return false;
  return Boolean((process.versions as Record<string, string | undefined>).bun);
}

function loadBunDatabase(): DatabaseConstructor | undefined {
  if (!isBunRuntime()) return undefined;

  try {
    return require("bun:sqlite").Database as DatabaseConstructor;
  } catch {
    return undefined;
  }
}

function loadNodeDatabase(): DatabaseConstructor | undefined {
  if (isBunRuntime()) return undefined;

  try {
    const sqlite = require("node:sqlite") as { DatabaseSync?: NodeDatabaseSyncConstructor };
    if (!sqlite.DatabaseSync) return undefined;

    const DatabaseSync = sqlite.DatabaseSync;

    return class NodeSqliteDatabase implements DatabaseLike {
      private readonly db: NodeDatabaseSync;

      constructor(dbPath: string, options?: unknown) {
        this.db = new DatabaseSync(dbPath, options);
      }

      exec(query: string): unknown {
        return this.db.exec(query);
      }

      query(query: string): DatabaseQuery {
        const statement = this.db.prepare(query);

        return {
          run: (params?: DatabaseParams) => {
            if (params === undefined) return statement.run();
            return statement.run(params);
          },
          get: (params?: DatabaseParams) => {
            if (params === undefined) return statement.get();
            return statement.get(params);
          },
          all: (params?: DatabaseParams) => {
            if (params === undefined) return statement.all();
            return statement.all(params);
          },
        };
      }
    };
  } catch {
    return undefined;
  }
}

function cloneEmptyState(): JsonDatabaseState {
  return { version: EMPTY_STATE.version, tables: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, " ").trim().replace(/;$/, "");
}

function readParam(token: string, params: DatabaseParams): unknown {
  const trimmed = token.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("$") || trimmed.startsWith(":") || trimmed.startsWith("@")) {
    if (Object.prototype.hasOwnProperty.call(params, trimmed)) return params[trimmed];

    const bareName = trimmed.slice(1);
    if (Object.prototype.hasOwnProperty.call(params, bareName)) return params[bareName];
    return undefined;
  }

  if (trimmed.toUpperCase() === "NULL") return null;
  if (trimmed === "true" || trimmed.toUpperCase() === "TRUE") return true;
  if (trimmed === "false" || trimmed.toUpperCase() === "FALSE") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);

  const stringMatch = trimmed.match(/^'(.*)'$/s);
  if (stringMatch) return stringMatch[1].replace(/''/g, "'");

  throw new Error(`Unsupported JSON database value token: ${trimmed}`);
}

/**
 * Durable fallback for runtimes without a native SQLite implementation.
 *
 * It intentionally supports only the small SQL subset used by Teamwork's
 * checkpoint and context-cache stores. Unsupported SQL throws instead of
 * silently pretending it succeeded.
 *
 * Data is stored next to the requested SQLite path as `<path>.json`, so a
 * future switch back to native SQLite can never corrupt or overwrite the
 * SQLite database file.
 */
export class JsonFileDatabase implements DatabaseLike {
  private readonly filePath: string;
  private readonly memoryOnly: boolean;
  private state: JsonDatabaseState = cloneEmptyState();

  constructor(dbPath: string) {
    this.memoryOnly = dbPath === ":memory:";
    this.filePath = this.memoryOnly ? "" : `${dbPath}.json`;
    this.refreshFromDisk();
  }

  exec(query: string): void {
    const sql = normalizeSql(query);
    if (!sql) return;

    this.refreshFromDisk();

    const tablePattern = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_][A-Za-z0-9_]*)/gi;
    const tableNames = [...sql.matchAll(tablePattern)].map((match) => match[1]);
    if (tableNames.length === 0) {
      throw new Error(`Unsupported JSON database exec statement: ${sql}`);
    }

    let changed = false;
    for (const tableName of tableNames) {
      if (this.state.tables[tableName]) continue;
      this.state.tables[tableName] = [];
      changed = true;
    }

    if (!changed) return;
    this.persist();
  }

  query(query: string): DatabaseQuery {
    const sql = normalizeSql(query);
    if (!sql) throw new Error("Database query must not be empty");

    return {
      run: (params?: DatabaseParams) => this.runStatement(sql, params ?? {}),
      get: (params?: DatabaseParams) => this.selectRows(sql, params ?? {})[0] ?? null,
      all: (params?: DatabaseParams) => this.selectRows(sql, params ?? {}),
    };
  }

  private runStatement(sql: string, params: DatabaseParams): unknown {
    if (!/^INSERT\s+INTO\s+/i.test(sql)) {
      throw new Error(`Unsupported JSON database write statement: ${sql}`);
    }

    this.refreshFromDisk();

    const insertMatch = sql.match(
      /^INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
    );
    if (!insertMatch) throw new Error(`Unable to parse JSON database INSERT: ${sql}`);

    const [, tableName, columnList, valueList] = insertMatch;
    const columns = columnList.split(",").map((column) => column.trim());
    const values = valueList.split(",").map((value) => value.trim());
    if (columns.length !== values.length) {
      throw new Error(`INSERT column/value count mismatch for table '${tableName}'`);
    }

    const rows = this.getTable(tableName);
    const row: JsonRow = {};
    for (let index = 0; index < columns.length; index += 1) {
      row[columns[index]] = readParam(values[index], params);
    }

    const conflictMatch = sql.match(/ON\s+CONFLICT\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/i);
    const conflictColumn = conflictMatch?.[1];
    if (!conflictColumn) {
      rows.push(row);
      this.persist();
      return { changes: 1 };
    }

    const conflictValue = row[conflictColumn];
    const existingIndex = rows.findIndex((candidate) => candidate[conflictColumn] === conflictValue);
    if (existingIndex < 0) {
      rows.push(row);
      this.persist();
      return { changes: 1 };
    }

    rows[existingIndex] = { ...rows[existingIndex], ...row };
    this.persist();
    return { changes: 1 };
  }

  private selectRows(sql: string, params: DatabaseParams): JsonRow[] {
    if (!/^SELECT\s+/i.test(sql)) {
      throw new Error(`Unsupported JSON database read statement: ${sql}`);
    }

    this.refreshFromDisk();

    const selectMatch = sql.match(
      /^SELECT\s+(.+?)\s+FROM\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+([A-Za-z_][A-Za-z0-9_]*)\s+(ASC|DESC))?(?:\s+LIMIT\s+(\d+))?$/i,
    );
    if (!selectMatch) throw new Error(`Unable to parse JSON database SELECT: ${sql}`);

    const [, projection, tableName, whereClause, orderColumn, orderDirection, limitText] = selectMatch;
    let rows = this.getTable(tableName).map((row) => ({ ...row }));

    if (whereClause) {
      const whereMatch = whereClause.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/i);
      if (!whereMatch) throw new Error(`Unsupported JSON database WHERE clause: ${whereClause}`);

      const [, column, token] = whereMatch;
      const expectedValue = readParam(token, params);
      rows = rows.filter((row) => row[column] === expectedValue);
    }

    if (orderColumn) {
      const direction = orderDirection?.toUpperCase() === "DESC" ? -1 : 1;
      rows.sort((left, right) => {
        const a = left[orderColumn];
        const b = right[orderColumn];
        if (a === b) return 0;
        if (a === undefined || a === null) return -1 * direction;
        if (b === undefined || b === null) return 1 * direction;
        return (a < b ? -1 : 1) * direction;
      });
    }

    if (limitText) rows = rows.slice(0, Number(limitText));
    if (projection.trim() === "*") return rows;

    const projectedColumns = projection.split(",").map((column) => column.trim());
    return rows.map((row) => {
      const projected: JsonRow = {};
      for (const column of projectedColumns) {
        projected[column] = row[column];
      }
      return projected;
    });
  }

  private getTable(tableName: string): JsonRow[] {
    const table = this.state.tables[tableName];
    if (table) return table;
    throw new Error(`JSON database table does not exist: ${tableName}`);
  }

  private refreshFromDisk(): void {
    if (this.memoryOnly) return;
    if (!fs.existsSync(this.filePath)) {
      this.state = cloneEmptyState();
      return;
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error(`Invalid JSON database file: ${this.filePath}`);
    if (parsed.version !== 1) throw new Error(`Unsupported JSON database version in: ${this.filePath}`);
    if (!isRecord(parsed.tables)) throw new Error(`Invalid JSON database tables in: ${this.filePath}`);

    const tables: Record<string, JsonRow[]> = {};
    for (const [tableName, tableRows] of Object.entries(parsed.tables)) {
      if (!Array.isArray(tableRows)) throw new Error(`Invalid table '${tableName}' in: ${this.filePath}`);
      tables[tableName] = tableRows.map((row) => {
        if (!isRecord(row)) throw new Error(`Invalid row in table '${tableName}' in: ${this.filePath}`);
        return { ...row };
      });
    }

    this.state = { version: 1, tables };
  }

  private persist(): void {
    if (this.memoryOnly) return;

    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });

    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");

    try {
      fs.renameSync(temporaryPath, this.filePath);
      return;
    } catch {
      fs.copyFileSync(temporaryPath, this.filePath);
      fs.unlinkSync(temporaryPath);
    }
  }
}

function resolveDatabaseImplementation(): DatabaseConstructor {
  const bunDatabase = loadBunDatabase();
  if (bunDatabase) return bunDatabase;

  const nodeDatabase = loadNodeDatabase();
  if (nodeDatabase) return nodeDatabase;

  return JsonFileDatabase;
}

const Database: DatabaseConstructor = resolveDatabaseImplementation();

export { Database };
