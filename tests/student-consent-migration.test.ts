import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";

test("grant-history upgrade preserves legacy confirmation and consent rows without guessing a binding", () => {
  const db = new Database(":memory:"); db.run("PRAGMA foreign_keys = ON");
  try {
    const migrations = readMigrationFiles({ migrationsFolder: `${import.meta.dir}/../packages/db/migrations` });
    const boundary = migrations.findIndex(m => m.sql.some(sql => sql.includes("ADD `consent_history_id`")));
    expect(boundary).toBeGreaterThan(0);
    const apply = (sql: string[]) => db.transaction(() => { for (const statement of sql) db.run(statement.trim()); })();
    for (const migration of migrations.slice(0, boundary)) apply(migration.sql);
    db.run("INSERT INTO professors VALUES ('legacy-prof', 'legacy@example.invalid', 0)");
    db.run("INSERT INTO consents VALUES ('legacy-team', 'legacy-student', 'granted', 'synthetic-policy', 0)");
    db.run(`INSERT INTO consent_confirmations (token_hash, team_id, student_id, version, issued_by_professor_id, created_at, expires_at, confirmed_at)
      VALUES ('synthetic-hash', 'legacy-team', 'legacy-student', 'synthetic-policy', 'legacy-prof', 1, 100, 2)`);
    const before = db.query("SELECT * FROM consent_history").all();
    for (const migration of migrations.slice(boundary)) apply(migration.sql);
    expect(db.query("SELECT token_hash, confirmed_at, consent_history_id FROM consent_confirmations").get())
      .toEqual({ token_hash: "synthetic-hash", confirmed_at: 2, consent_history_id: null });
    expect(db.query("SELECT * FROM consent_history").all()).toEqual(before);
    db.run("UPDATE consents SET status = 'withdrawn', recorded_at = 3");
    expect(db.query("SELECT status FROM consent_history ORDER BY id").all()).toEqual([{ status: "granted" }, { status: "withdrawn" }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});
