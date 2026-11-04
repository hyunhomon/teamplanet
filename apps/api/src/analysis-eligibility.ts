import type { Context } from "hono";
import { analysisPreviewSchema, rubricSelectionSchema, type AnalysisPreview } from "@teamplanet/contracts";
import { processingWriteGuard } from "@teamplanet/collection";
import { owned, type ProtectedEnv } from "./guard";
import { apiError } from "./errors";
const iso = (value: number | null) => value === null ? null : new Date(value).toISOString();
export async function analysisEligibility(c: Context<ProtectedEnv>, input: { teamId: string; from: string; to: string; timezone: string }, at: number) {
  const { teamId, from, to } = input, db = c.env.DB;
  const team = await owned<{ course_id: string }>(c, "team", teamId);
  if (!team) return null;
  const config = await db.prepare(`SELECT c.*, r.rubric_version, r.selected_competencies_json, r.updated_at AS rubric_updated FROM courses c
    LEFT JOIN course_rubric_settings r ON r.course_id = c.id WHERE c.id = ?`).bind(team.course_id).first<any>();
  let selected: unknown; try { selected = JSON.parse(config.selected_competencies_json ?? "null"); } catch { selected = null; }
  const parsed = rubricSelectionSchema.safeParse({ rubricVersion: config.rubric_version, selectedCompetencies: selected });
  const selection = parsed.success ? parsed.data : null;
  const reasons: AnalysisPreview["reasons"] = [], a = Date.parse(from), b = Date.parse(to);
  if (!selection || config.starts_at === null || config.ends_at === null) reasons.push("SETTINGS_REQUIRED");
  if (config.starts_at !== null && a < config.starts_at || config.ends_at !== null && b > config.ends_at) reasons.push("PERIOD_OUTSIDE_COURSE");
  if (b > at) reasons.push("FUTURE_PERIOD");
  try { await processingWriteGuard(db, { teamId, from: a, to: b, now: at }).run(); } catch { reasons.push("DATA_USE_BLOCKED"); }
  // Use the same containing complete row as creation, not a sum of overlapping partial intervals.
  const coverage = await db.prepare(`SELECT * FROM collection_coverage WHERE team_id = ? AND from_ms <= ? AND to_ms >= ?
    ORDER BY (status = 'complete') DESC, updated_at DESC LIMIT 1`).bind(teamId, a, b).first<any>();
  if (coverage?.status !== "complete") reasons.push("COVERAGE_INCOMPLETE");
  const sources = await db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(content_hash IS NULL),0) AS unverified FROM message_refs WHERE team_id = ? AND deleted_at IS NULL
    AND CAST(slack_ts AS REAL) * 1000 >= ? AND CAST(slack_ts AS REAL) * 1000 < ?`).bind(teamId, a, b).first<{ count: number; unverified: number }>();
  if (coverage?.status === "complete" && !sources!.count) reasons.push("NO_DATA");
  const images = await db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(i.limitation IS NOT NULL OR i.content_hash IS NULL),0) AS limited FROM image_refs i
    JOIN message_refs m ON m.channel_id = i.channel_id AND m.slack_ts = i.slack_ts WHERE m.team_id = ? AND m.deleted_at IS NULL AND m.content_hash IS NOT NULL
    AND CAST(m.slack_ts AS REAL) * 1000 >= ? AND CAST(m.slack_ts AS REAL) * 1000 < ?`).bind(teamId, a, b).first<{ count: number; limited: number }>();
  let limits: string[] = []; try { const raw = JSON.parse(coverage?.limitations_json ?? "[]"); if (Array.isArray(raw)) limits = raw.filter((v): v is string => typeof v === "string"); } catch {}
  const preview = analysisPreviewSchema.parse({ ...input, courseId: team.course_id, checkedAt: iso(at), allowed: !reasons.length, reasons, selection,
    startsAt: iso(config.starts_at), endsAt: iso(config.ends_at), coverage: { status: coverage?.status ?? "missing", asOf: iso(coverage?.updated_at ?? null),
      from: iso(coverage?.from_ms ?? null), to: iso(coverage?.to_ms ?? null), sources: sources!.count, unverifiedSources: sources!.unverified, imageReferences: images!.count, imageLimitations: images!.limited,
      threadRootsOutsidePeriod: coverage?.old_thread_roots ?? 0, excluded: coverage?.excluded ?? 0,
      limitations: [...new Set([...limits, "source_metadata_preview_requires_live_revalidation", "image_metadata_is_not_complete_image_coverage", "older_thread_replies_from_events_only"])],
    } });
  return { config, selection, preview };
}
export function eligibilityError(c: Context, reasons: AnalysisPreview["reasons"]) {
  if (reasons.some(r => ["SETTINGS_REQUIRED", "PERIOD_OUTSIDE_COURSE", "FUTURE_PERIOD"].includes(r))) return apiError(c, "CONFLICT", "수업 기간·선택 역량·분석 기간 설정을 확인하세요.");
  if (reasons.includes("DATA_USE_BLOCKED")) return apiError(c, "CONSENT_REQUIRED", "동의·수집 구간·보관 상태를 확인하세요.");
  return apiError(c, "CONFLICT", reasons.includes("COVERAGE_INCOMPLETE") ? "전체 기간의 수집 coverage를 먼저 완료하세요." : "이 기간에 관찰할 수 있는 대화가 없습니다.");
}
