import { createRequire } from "module";

export interface DatabaseQuery {
  run(params?: any): any;
  get(params?: any): any;
  all(params?: any): any[];
}

export interface DatabaseLike {
  exec(query: string): any;
  query(query: string): DatabaseQuery;
}

type DatabaseConstructor = new (path: string, options?: any) => DatabaseLike;

let Database: DatabaseConstructor | null = null;

try {
  if (typeof process !== "undefined" && process.versions && (process.versions as any).bun) {
    const require = createRequire(import.meta.url);
    Database = require("bun:sqlite").Database as DatabaseConstructor;
  }
} catch {
  // Bun SQLite is optional; Node.js falls back to the lightweight adapter below.
}

if (!Database) {
  Database = class MockDatabase implements DatabaseLike {
    constructor(_path: string, _options?: any) {}

    exec(_query: string) {}

    query(_query: string): DatabaseQuery {
      return {
        run: (_params?: any) => {},
        get: (_params?: any) => null,
        all: (_params?: any) => []
      };
    }
  };
}

export { Database };
