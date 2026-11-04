import { analysisDashboardSchema, analysisPreviewSchema } from "./dashboard";
import { analysisRunResponseSchema, analysisStatuses } from "./analysis";
import { teams } from "./fixtures";
export const dashboardFixture = analysisDashboardSchema.parse({ teams: [{ team: { ...teams[0]!, collectionStatus: "active" }, courseName: "합성 수업",
  startsAt: "2026-11-01T00:00:00.000Z", endsAt: "2026-12-01T00:00:00.000Z", selection: { rubricVersion: "communication-v1", selectedCompetencies: ["clarity"] },
  members: 1, confirmed: 1, unmapped: 0 }] });
export const dashboardPreviewFixture = analysisPreviewSchema.parse({ teamId: teams[0]!.id, courseId: teams[0]!.courseId,
  from: "2026-11-01T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z", timezone: "Asia/Seoul", checkedAt: "2026-11-04T00:00:00.000Z",
  allowed: true, reasons: [], selection: dashboardFixture.teams[0]!.selection, startsAt: dashboardFixture.teams[0]!.startsAt, endsAt: dashboardFixture.teams[0]!.endsAt,
  coverage: { status: "complete", asOf: "2026-11-04T00:00:00.000Z", from: "2026-11-01T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z",
    sources: 5, unverifiedSources: 1, imageReferences: 2, imageLimitations: 1, threadRootsOutsidePeriod: 1, excluded: 1,
    limitations: ["source_metadata_preview_requires_live_revalidation", "older_thread_replies_from_events_only", "image_metadata_is_not_complete_image_coverage"] } });
export const dashboardRunFixture = analysisRunResponseSchema.parse({ id: "run_00000000-0000-4000-8000-000000000021", teamId: teams[0]!.id,
  from: dashboardPreviewFixture.from, to: dashboardPreviewFixture.to, timezone: "Asia/Seoul", status: "queued", valid: false, manifest: null,
  snapshot: { contractVersion: "analysis-stages-v1", rubric: dashboardFixture.teams[0]!.selection, modelProfileVersion: "qwen-pilot-v1", promptVersion: "communication-prompts-v1",
    configuredModel: "qwen/qwen3.5-9b", configuredProvider: "deepinfra/bf16", contextPlanVersion: "qwen-chunks-v1", contextLength: 262144, maxTextBytes: 48000, maxImagesPerChunk: 1 },
  progress: { sources: 0, chunks: 0, completedChunks: 0 }, errors: [], version: 1 });
export const dashboardStatusFixtures = analysisStatuses.map(status => ({ ...dashboardRunFixture, status }));
export const dashboardEmptyFixtures = {
  noTeams: { teams: [] }, noRuns: { teamId: teams[0]!.id, runs: [], nextBefore: null },
  noData: { ...dashboardPreviewFixture, allowed: false, reasons: ["NO_DATA"], coverage: { ...dashboardPreviewFixture.coverage, sources: 0, unverifiedSources: 0 } },
  partial: { ...dashboardPreviewFixture, allowed: false, reasons: ["COVERAGE_INCOMPLETE"], coverage: { ...dashboardPreviewFixture.coverage, status: "partial" } },
};
