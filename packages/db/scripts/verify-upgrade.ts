import { deepStrictEqual, rejects } from "node:assert";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as f from "../../contracts/src/fixtures";

// Isolated local D1 only. No production config, remote flags or credentials needed.
const root = resolve(import.meta.dir, "../../..");
const cache = join(root, "node_modules/.cache");
mkdirSync(cache, { recursive: true });
const runDir = mkdtempSync(join(cache, "contracts-d1-upgrade-"));
const legacyDir = join(runDir, "legacy-migrations");
mkdirSync(legacyDir);
const migrationsDir = resolve(import.meta.dir, "../migrations");
const configPath = join(runDir, "wrangler.json");
const persistPath = join(runDir, "state");
const configure = (migrations: string) => writeFileSync(configPath, JSON.stringify({
  name: "teamplanet-contracts-local-test", compatibility_date: "2026-10-24",
  d1_databases: [{ binding: "DB", database_name: "contracts-local-only", database_id: "00000000-0000-4000-8000-000000000000", migrations_dir: migrations }],
}));

async function wrangler(args: string[]) {
  const child = Bun.spawn(["node", join(root, "node_modules/wrangler/bin/wrangler.js"), ...args,
    "--config", configPath, "--local", "--persist-to", persistPath], {
    cwd: runDir, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(runDir, "wrangler.log") },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`Local Wrangler failed (${code}): ${stdout}\n${stderr}`);
  return stdout;
}
const apply = () => wrangler(["d1", "migrations", "apply", "DB"]);
async function query(sql: string) {
  const results = JSON.parse(await wrangler(["d1", "execute", "DB", "--command", sql, "--json"])) as { results: Record<string, unknown>[] }[];
  return results.map(result => result.results);
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

console.log(`Local D1 verification directory: ${runDir}`);
configure(legacyDir);
copyFileSync(join(migrationsDir, "0000_amused_angel.sql"), join(legacyDir, "0000_amused_angel.sql"));
await apply();
await wrangler(["d1", "execute", "DB", "--file", resolve(import.meta.dir, "../fixtures/legacy-upgrade.sql"), "--json"]);
copyFileSync(join(migrationsDir, "0001_consent_audit.sql"), join(legacyDir, "0001_consent_audit.sql"));
await apply();
await query("UPDATE consents SET status = 'withdrawn', recorded_at = 2000;");
const preserved = ["assessments", "analysis_runs", "evidence_events", "messages", "consents", "consent_history", "workspaces"];
const snapshotSql = preserved.map(table => `SELECT * FROM ${table};`).join("\n");
const before = await query(snapshotSql);
configure(migrationsDir);
await apply();
deepStrictEqual(await query(snapshotSql), before);
deepStrictEqual(await query("SELECT course_id FROM teams;"), [[{ course_id: null }]]);
deepStrictEqual(await query("SELECT t.id FROM teams t JOIN courses c ON c.id = t.course_id;"), [[]]);
await query("UPDATE consents SET status = 'granted', version = 'v2', recorded_at = 3000;");
await query("INSERT INTO consents VALUES ('legacy-team', 'another-synthetic-student', 'declined', 'v2', 4000);");
deepStrictEqual(await query("SELECT id, status FROM consent_history ORDER BY recorded_at, id;"), [[
  { id: 1, status: "granted" }, { id: 2, status: "withdrawn" }, { id: 3, status: "granted" }, { id: 4, status: "declined" },
]]);

// Use the preserved workspace; adding a second one must fail.
await rejects(
  query(`INSERT INTO workspaces VALUES (${quote(f.workspace.id)}, ${quote(f.workspace.slackTeamId)}, 5000);`),
  /UNIQUE constraint failed/,
);
const sql: string[] = [];
for (const p of f.professors) sql.push(`INSERT INTO professors VALUES (${quote(p.id)}, ${quote(p.email)}, 5000);`);
for (const c of f.courses) sql.push(`INSERT INTO courses VALUES (${quote(c.id)}, ${quote(c.professorId)}, ${quote(c.name)}, 5000);`);
for (const t of f.teams) sql.push(`INSERT INTO teams (id, workspace_id, channel_id, name, collection_status, course_id) VALUES (${quote(t.id)}, 'legacy-workspace', ${quote(t.channelId)}, ${quote(t.name)}, 'inactive', ${quote(t.courseId)});`);
for (const s of f.students) sql.push(`INSERT INTO students VALUES (${quote(s.id)}, ${quote(s.courseId)}, ${quote(s.displayName)}, 5000);`);
for (const m of f.members) {
  sql.push(`INSERT INTO slack_users VALUES ('legacy-workspace', ${quote(m.slackUserId)});`);
  sql.push(`INSERT INTO student_slack_mappings VALUES (${quote(m.studentId)}, ${quote(m.courseId)}, 'legacy-workspace', ${quote(m.slackUserId)});`);
  sql.push(`INSERT INTO team_members VALUES (${quote(m.teamId)}, ${quote(m.studentId)}, ${quote(m.courseId)}, 'legacy-workspace');`);
}
const ownershipSeed = join(runDir, "ownership-seed.sql");
writeFileSync(ownershipSeed, sql.join("\n"));
await wrangler(["d1", "execute", "DB", "--file", ownershipSeed, "--json"]);
for (const [index, p] of f.professors.entries()) {
  deepStrictEqual(await query(`SELECT t.id AS team_id, tm.student_id FROM teams t JOIN courses c ON c.id = t.course_id JOIN team_members tm ON tm.team_id = t.id WHERE c.professor_id = ${quote(p.id)};`), [[
    { team_id: f.teams[index]!.id, student_id: f.students[index]!.id },
  ]]);
}
deepStrictEqual(await query("PRAGMA foreign_key_check;"), [[]]);
await apply(); // Idempotent migration tracking must not duplicate audit triggers/history.
deepStrictEqual(await query("SELECT count(*) AS count FROM consent_history;"), [[{ count: 4 }]]);
console.log("PASS: local D1 legacy upgrade, all evaluation fields, audit history/triggers, two-professor ownership, single workspace, FK check and repeated migration.");
