import { z } from "zod";
import { competencyKeys } from "./keys";
import { competencyAssessmentSchema } from "./validation";

export const rubricVersion = "communication-v1" as const;
export const competencyLabels = {
  clarity: "정보 전달의 명료성",
  information_sharing: "정보 공유·협업 지원",
  feedback_alignment: "피드백 수용·상호 조율",
  decision_execution: "의사결정·실행 연결",
} as const satisfies Record<(typeof competencyKeys)[number], string>;

// No implicit all-four default. Persist this selection in #3/#9 and snapshot it in #16.
export const rubricSelectionSchema = z.strictObject({
  rubricVersion: z.literal(rubricVersion),
  selectedCompetencies: z.array(z.enum(competencyKeys)).min(1).max(4)
    .refine(keys => new Set(keys).size === keys.length, "Duplicate competency"),
});
export type RubricSelection = z.infer<typeof rubricSelectionSchema>;

/** Semantic guard after JSON parsing; primary-source authorization remains a server check. */
export function assessmentSetSchema(
  selection: RubricSelection,
  studentIds: readonly string[],
  evidenceIds: readonly string[],
) {
  const config = rubricSelectionSchema.parse(selection);
  const students = new Set(studentIds);
  const knownEvidence = new Set(evidenceIds);
  return z.array(competencyAssessmentSchema).superRefine((rows, ctx) => {
    const seen = new Set<string>();
    for (const [index, row] of rows.entries()) {
      const pair = `${row.studentId}:${row.key}`;
      if (!students.has(row.studentId) || !config.selectedCompetencies.includes(row.key)) {
        ctx.addIssue({ code: "custom", path: [index], message: "Unexpected student or unselected competency" });
      }
      if (seen.has(pair)) ctx.addIssue({ code: "custom", path: [index], message: "Duplicate assessment" });
      seen.add(pair);
      for (const id of [...row.evidenceIds, ...row.counterEvidenceIds]) {
        if (!knownEvidence.has(id)) ctx.addIssue({ code: "custom", path: [index], message: "Unknown evidence ID" });
      }
      if (row.judgement !== "insufficient_evidence" && row.evidenceIds.length === 0) {
        ctx.addIssue({ code: "custom", path: [index], message: "Judgement requires evidence" });
      }
      if (row.judgement === "insufficient_evidence"
        && (row.limitations.length === 0 || !row.requiresHumanReview)) {
        ctx.addIssue({ code: "custom", path: [index], message: "Insufficient evidence requires limitations and human review" });
      }
    }
    for (const student of students) for (const key of config.selectedCompetencies) {
      if (!seen.has(`${student}:${key}`)) ctx.addIssue({ code: "custom", message: `Missing assessment: ${student}:${key}` });
    }
  });
}
