import { z } from "zod";
import { courseIdSchema, dateTimeSchema, teamSchema } from "./api";
import { analysisRunResponseSchema, createAnalysisRunSchema } from "./analysis";
import { rubricSelectionSchema } from "./rubric";
export const analysisPreviewRequestSchema = z.strictObject({ teamId: createAnalysisRunSchema.shape.teamId, from: createAnalysisRunSchema.shape.from,
  to: createAnalysisRunSchema.shape.to, timezone: createAnalysisRunSchema.shape.timezone }).refine(v => Date.parse(v.from) < Date.parse(v.to), { path: ["to"], message: "to must follow from" });
export const analysisBlockSchema = z.enum(["SETTINGS_REQUIRED", "PERIOD_OUTSIDE_COURSE", "FUTURE_PERIOD", "DATA_USE_BLOCKED", "COVERAGE_INCOMPLETE", "NO_DATA"]);
export const analysisDashboardSchema = z.strictObject({ teams: z.array(z.strictObject({ team: teamSchema,
  courseName: z.string(), startsAt: dateTimeSchema.nullable(), endsAt: dateTimeSchema.nullable(), selection: rubricSelectionSchema.nullable(),
  members: z.number().int().nonnegative(), confirmed: z.number().int().nonnegative(), unmapped: z.number().int().nonnegative(),
})) });
export const analysisPreviewSchema = z.strictObject({ teamId: teamSchema.shape.id, courseId: courseIdSchema,
  from: dateTimeSchema, to: dateTimeSchema, timezone: z.string(), checkedAt: dateTimeSchema,
  allowed: z.boolean(), reasons: z.array(analysisBlockSchema), selection: rubricSelectionSchema.nullable(),
  startsAt: dateTimeSchema.nullable(), endsAt: dateTimeSchema.nullable(),
  coverage: z.strictObject({ status: z.enum(["complete", "partial", "running", "failed", "missing"]), asOf: dateTimeSchema.nullable(),
    from: dateTimeSchema.nullable(), to: dateTimeSchema.nullable(), sources: z.number().int().nonnegative(), unverifiedSources: z.number().int().nonnegative(),
    imageReferences: z.number().int().nonnegative(), imageLimitations: z.number().int().nonnegative(),
    threadRootsOutsidePeriod: z.number().int().nonnegative(), excluded: z.number().int().nonnegative(), limitations: z.array(z.string()),
  }),
}).refine(p => p.allowed === (p.reasons.length === 0), "Inconsistent eligibility");
export const analysisRunListSchema = z.strictObject({ teamId: teamSchema.shape.id, runs: z.array(analysisRunResponseSchema), nextBefore: z.number().int().positive().nullable() });
export type AnalysisDashboard = z.infer<typeof analysisDashboardSchema>;
export type AnalysisPreview = z.infer<typeof analysisPreviewSchema>;
export type AnalysisRun = z.infer<typeof analysisRunResponseSchema>;
export const analysisHistoryRequestSchema = analysisPreviewRequestSchema.safeExtend({ requestId: z.uuidv4() });
export const analysisHistoryResponseSchema = z.strictObject({ requestId: z.uuidv4(), teamId: teamSchema.shape.id,
  from: dateTimeSchema, to: dateTimeSchema, status: z.enum(["pending", "running", "retry", "completed", "dead"]),
  coverage: z.enum(["missing", "running", "complete", "partial", "failed"]), errorCode: z.string().nullable() });
export type AnalysisHistory = z.infer<typeof analysisHistoryResponseSchema>;
