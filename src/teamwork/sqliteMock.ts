import { createRequire } from "module";

let Database: any = null;

try {
  if (typeof process !== "undefined" && process.versions && (process.versions as any).bun) {
    const require = createRequire(import.meta.url);
    Database = require("bun:sqlite").Database;
  }
} catch (e) {
  // Ignore
}

if (!Database) {
  Database = class MockDatabase {
    constructor(path: string, options: any) {}
    exec(query: string) {}
    query(query: string) {
      return {
        run: (params?: any) => {},
        get: (params?: any) => null,
        all: (params?: any) => []
      };
    }
  };
}

export { Database };
