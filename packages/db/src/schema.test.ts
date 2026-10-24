import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { assessments, consentHistory, consents } from "./schema";

let sqlite: Database;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
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
