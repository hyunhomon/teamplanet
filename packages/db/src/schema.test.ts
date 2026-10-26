import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { and, eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { readFileSync } from "node:fs";
import {
  assessments, consentHistory, consents, courses, professors, slackUsers,
  students, studentSlackMappings, teamMembers, teams, workspaces,
} from "./schema";
import * as fixtures from "../../contracts/src/fixtures";

let sqlite: Database;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
});

function seedOwners() {
  db.insert(professors).values(fixtures.professors.map(row => ({ ...row, createdAt: new Date(row.createdAt) }))).run();
  db.insert(courses).values(fixtures.courses.map(row => ({ ...row, createdAt: new Date(row.createdAt) }))).run();
  db.insert(workspaces).values({ ...fixtures.workspace, createdAt: new Date(fixtures.workspace.createdAt) }).run();
  db.insert(teams).values(fixtures.teams).run();
  db.insert(students).values(fixtures.students.map(row => ({ ...row, createdAt: new Date(row.createdAt) }))).run();
  for (const member of fixtures.members) {
    db.insert(slackUsers).values({ workspaceId: member.workspaceId, slackUserId: member.slackUserId }).run();
    db.insert(studentSlackMappings).values({
      studentId: member.studentId, courseId: member.courseId, workspaceId: member.workspaceId, slackUserId: member.slackUserId,
    }).run();
    db.insert(teamMembers).values(member).run();
  }
}

test("two professors see only their course, team and mapped students through ownership joins", () => {
  seedOwners();
  for (const [index, professor] of fixtures.professors.entries()) {
    const owned = db.select({ courseId: courses.id, teamId: teams.id, studentId: students.id, slackUserId: studentSlackMappings.slackUserId })
      .from(courses).innerJoin(teams, eq(teams.courseId, courses.id))
      .innerJoin(teamMembers, eq(teamMembers.teamId, teams.id))
      .innerJoin(students, eq(students.id, teamMembers.studentId))
      .innerJoin(studentSlackMappings, eq(studentSlackMappings.studentId, students.id))
      .where(eq(courses.professorId, professor.id)).all();
    expect(owned).toEqual([{
      courseId: fixtures.courses[index]!.id, teamId: fixtures.teams[index]!.id,
      studentId: fixtures.students[index]!.id, slackUserId: fixtures.members[index]!.slackUserId,
    }]);
    const foreignTeam = fixtures.teams[1 - index]!;
    expect(db.select().from(teams).innerJoin(courses, eq(courses.id, teams.courseId))
      .where(and(eq(courses.professorId, professor.id), eq(teams.id, foreignTeam.id))).all()).toEqual([]);
  }
});

test("DB rejects cross-course students, mismatched mappings, duplicate teams/channels and a second workspace", () => {
  seedOwners();
  const a = fixtures.members[0]!;
  const b = fixtures.members[1]!;
  expect(() => db.insert(teamMembers).values({ ...a, studentId: b.studentId }).run()).toThrow();
  expect(() => db.update(studentSlackMappings).set({ courseId: b.courseId }).where(eq(studentSlackMappings.studentId, a.studentId)).run()).toThrow();
  expect(() => db.insert(teams).values({ ...fixtures.teams[0]!, id: "duplicate-channel", name: "different" }).run()).toThrow();
  expect(() => db.insert(teams).values({ ...fixtures.teams[0]!, id: "duplicate-name", channelId: "COTHER001" }).run()).toThrow();
  expect(() => db.insert(workspaces).values({ id: "other", slackTeamId: "TOTHER001", createdAt: new Date() }).run()).toThrow();
  expect(() => db.insert(teams).values({ ...fixtures.teams[0]!, id: "unowned", courseId: null, channelId: "COTHER001", name: "other" }).run()).toThrow();
  expect(() => db.insert(teams).values({ ...fixtures.teams[0]!, id: "orphan", courseId: "missing", channelId: "COTHER001", name: "other" }).run()).toThrow();
  expect(() => db.insert(teams).values({ ...fixtures.teams[0]!, id: "orphan-workspace", workspaceId: "missing", channelId: "COTHER001", name: "other" }).run()).toThrow();
  expect(() => db.update(teams).set({ courseId: null }).where(eq(teams.id, a.teamId)).run()).toThrow();
  expect(() => db.delete(workspaces).run()).toThrow();
  expect(() => db.update(workspaces).set({ id: "changed" }).run()).toThrow();
  expect(sqlite.query("PRAGMA foreign_key_check").all()).toEqual([]);
});

test("a Slack identity may map to students in different courses, but only once per course", () => {
  seedOwners();
  const a = fixtures.members[0]!;
  const b = fixtures.members[1]!;
  db.update(studentSlackMappings).set({ slackUserId: a.slackUserId }).where(eq(studentSlackMappings.studentId, b.studentId)).run();
  db.insert(students).values({ id: "another-student", courseId: a.courseId, displayName: "합성 학생", createdAt: new Date() }).run();
  expect(() => db.insert(studentSlackMappings).values({
    studentId: "another-student", courseId: a.courseId, workspaceId: a.workspaceId, slackUserId: a.slackUserId,
  }).run()).toThrow();
});

test("existing DB upgrade preserves all evaluation data, history IDs and active audit triggers", () => {
  const legacy = new Database(":memory:");
  legacy.exec("PRAGMA foreign_keys = ON");
  const migrations = readMigrationFiles({ migrationsFolder: `${import.meta.dir}/../migrations` });
  const apply = (index: number) => legacy.transaction(() => {
    for (const statement of migrations[index]!.sql) legacy.run(statement.trim());
  })();
  try {
    apply(0);
    legacy.exec(readFileSync(`${import.meta.dir}/../fixtures/legacy-upgrade.sql`, "utf8"));
    apply(1); // Existing snapshot backfill and audit triggers.
    legacy.exec("UPDATE consents SET status = 'withdrawn', recorded_at = 2000");
    const preservedTables = ["assessments", "analysis_runs", "evidence_events", "messages", "consents", "consent_history", "workspaces"];
    const before = preservedTables.map(table => legacy.query(`SELECT * FROM ${table}`).all());
    const beforeTeams = legacy.query("SELECT * FROM teams").all();
    for (let index = 2; index < migrations.length; index++) apply(index);
    expect(preservedTables.map(table => legacy.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(legacy.query("SELECT id, workspace_id, channel_id, name, collection_status FROM teams").all()).toEqual(beforeTeams);
    expect(legacy.query("SELECT course_id FROM teams").get()).toEqual({ course_id: null });
    expect(legacy.query("SELECT teams.id FROM teams JOIN courses ON courses.id = teams.course_id").all()).toEqual([]);
    legacy.exec("UPDATE consents SET status = 'granted', version = 'v2', recorded_at = 3000");
    legacy.exec("INSERT INTO consents VALUES ('legacy-team', 'another-synthetic-student', 'declined', 'v2', 4000)");
    expect(legacy.query("SELECT id, status FROM consent_history ORDER BY recorded_at, id").all()).toEqual([
      { id: 1, status: "granted" }, { id: 2, status: "withdrawn" }, { id: 3, status: "granted" }, { id: 4, status: "declined" },
    ]);
    expect(legacy.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { legacy.close(); }
});

test("conflicting legacy workspaces cause a transactional upgrade failure without discarding data", () => {
  const legacy = new Database(":memory:");
  const migrations = readMigrationFiles({ migrationsFolder: `${import.meta.dir}/../migrations` });
  try {
    for (const migration of migrations.slice(0, 2)) for (const statement of migration.sql) legacy.run(statement.trim());
    legacy.exec("INSERT INTO workspaces VALUES ('one', 'TFIRST001', 1000), ('two', 'TSECOND01', 2000)");
    expect(() => legacy.transaction(() => {
      for (const statement of migrations[2]!.sql) legacy.run(statement.trim());
    })()).toThrow();
    expect(legacy.query("SELECT id FROM workspaces ORDER BY id").all()).toEqual([{ id: "one" }, { id: "two" }]);
    expect(legacy.query("SELECT name FROM sqlite_master WHERE name = 'professors'").all()).toEqual([]);
  } finally { legacy.close(); }
});

afterEach(() => sqlite.close());

test("assessment limitations and review flag survive persistence", () => {
  db.insert(assessments).values({
    id: "assessment-1",
    runId: "run-1",
    studentId: "student-1",
    competencyKey: "clarity",
    judgement: "mixed",
    narrative: "Thread context needs a professor's review.",
    evidenceIdsJson: JSON.stringify(["evidence-1"]),
    counterEvidenceIdsJson: "[]",
    confidence: "low",
    limitationsJson: JSON.stringify(["Offline collaboration is not observable."]),
    requiresHumanReview: true,
  }).run();

  const stored = db.select().from(assessments).all()[0]!;
  expect(JSON.parse(stored.limitationsJson)).toEqual(["Offline collaboration is not observable."]);
  expect(stored.requiresHumanReview).toBe(true);

  db.update(assessments).set({ requiresHumanReview: false }).run();
  expect(db.select().from(assessments).all()[0]!.requiresHumanReview).toBe(false);
});

test("consent upserts preserve grant, withdrawal, and renewed consent", () => {
  for (const [index, status] of ["granted", "withdrawn", "granted"].entries()) {
    const change = {
      teamId: "team-1", studentId: "student-1", status,
      version: index === 2 ? "v2" : "v1",
      recordedAt: new Date((index + 1) * 1000),
    };
    db.insert(consents).values(change).onConflictDoUpdate({
      target: [consents.teamId, consents.studentId],
      set: { status: change.status, version: change.version, recordedAt: change.recordedAt },
    }).run();
  }

  const history = db.select().from(consentHistory).orderBy(consentHistory.id).all();
  expect(history.map(({ status, version, recordedAt }) => ({ status, version, recordedAt }))).toEqual([
    { status: "granted", version: "v1", recordedAt: new Date(1000) },
    { status: "withdrawn", version: "v1", recordedAt: new Date(2000) },
    { status: "granted", version: "v2", recordedAt: new Date(3000) },
  ]);
  expect(db.select().from(consents).all()).toHaveLength(1);
  expect(db.select().from(consents).all()[0]).toMatchObject({ status: "granted", version: "v2" });
});
