import { expect, test } from "bun:test";
import { assessmentSetSchema, rubricSelectionSchema, rubricVersion } from "./rubric";
import { evaluationCases, evaluationStudentId, invalidEvaluationOutputs, validEvaluationOutput } from "./evaluation-fixtures";

const selection = { rubricVersion, selectedCompetencies: ["clarity"] };
const schema = assessmentSetSchema(rubricSelectionSchema.parse(selection), [evaluationStudentId], evaluationCases[0]!.evidence.map(e => e.id));
test("one selected competency does not require the other three", () => {
  expect(schema.parse(validEvaluationOutput)).toEqual(validEvaluationOutput);
});
test("selection must be explicit, unique, nonempty and versioned", () => {
  for (const selectedCompetencies of [[], ["clarity", "clarity"], ["invented"]]) {
    expect(rubricSelectionSchema.safeParse({ rubricVersion, selectedCompetencies }).success).toBe(false);
  }
  expect(rubricSelectionSchema.safeParse({ rubricVersion }).success).toBe(false);
  expect(rubricSelectionSchema.safeParse({ ...selection, rubricVersion: "future" }).success).toBe(false);
});
test("rejects fabricated references, unselected results, duplicates, omissions and unsupported negatives", () => {
  for (const rows of Object.values(invalidEvaluationOutputs)) expect(schema.safeParse(rows).success).toBe(false);
  expect(schema.safeParse([{ ...validEvaluationOutput[0], studentId: "student_00000000-0000-4000-8000-000000000999" }]).success).toBe(false);
});
test("multiple selected competencies are complete and insufficient evidence cannot hide its limitations", () => {
  const scoped = assessmentSetSchema({ rubricVersion, selectedCompetencies: ["clarity", "decision_execution"] }, [evaluationStudentId], evaluationCases[0]!.evidence.map(e => e.id));
  const insufficient = { ...validEvaluationOutput[0]!, key: "decision_execution", judgement: "insufficient_evidence", evidenceIds: [], requiresHumanReview: true };
  expect(scoped.safeParse([...validEvaluationOutput, insufficient]).success).toBe(true);
  expect(scoped.safeParse(validEvaluationOutput).success).toBe(false);
  expect(scoped.safeParse([...validEvaluationOutput, { ...insufficient, requiresHumanReview: false }]).success).toBe(false);
  expect(scoped.safeParse([...validEvaluationOutput, { ...insufficient, limitations: [] }]).success).toBe(false);
});
test("synthetic expected outcomes cite only their own source messages", () => {
  for (const fixture of evaluationCases) {
    const messages = new Set(fixture.messages.map(m => m.id));
    for (const event of fixture.evidence) for (const id of event.messageIds) expect(messages.has(id)).toBe(true);
    const row = {
      ...validEvaluationOutput[0]!, key: fixture.key, judgement: fixture.expected.judgement,
      evidenceIds: fixture.expected.evidenceIds, counterEvidenceIds: fixture.expected.counterEvidenceIds,
      limitations: [fixture.expected.reason], requiresHumanReview: fixture.expected.humanReview,
    };
    const scoped = assessmentSetSchema({ rubricVersion, selectedCompetencies: [fixture.key] }, [evaluationStudentId], fixture.evidence.map(e => e.id));
    expect(scoped.safeParse([row]).success).toBe(true);
  }
});
