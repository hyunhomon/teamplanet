import { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { D1Database } from "@cloudflare/workers-types";

// Real SQLite statements and transactional batches, exposed through the D1 methods used by jobs.
export function sqliteD1() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  for (const migration of readMigrationFiles({ migrationsFolder: `${import.meta.dir}/../../packages/db/migrations` })) {
    sqlite.transaction(() => { for (const statement of migration.sql) sqlite.run(statement.trim()); })();
  }
  class Statement {
    constructor(readonly sql: string, readonly values: (string | number | null)[] = []) {}
    bind(...values: (string | number | null)[]) { return new Statement(this.sql, values); }
    async first<T>(column?: string): Promise<T | null> {
      const row = sqlite.query(this.sql).get(...this.values) as Record<string, unknown> | null;
      return (column ? row?.[column] ?? null : row) as T | null;
    }
    execute() {
      const results = sqlite.query(this.sql).all(...this.values);
      const changes = (sqlite.query("SELECT changes() AS changes").get() as { changes: number }).changes;
      return { results, success: true, meta: { changes } };
    }
    async run() { return this.execute(); }
    async all() { return this.execute(); }
  }
  const db = {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => sqlite.transaction(() => statements.map(statement => statement.execute()))(),
  } as unknown as D1Database;
  return { db, sqlite };
}
