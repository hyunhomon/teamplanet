import type { D1Database } from "@cloudflare/workers-types";
import { sealToken } from "../../packages/collection/src/slack";
import { snapshot } from "../../packages/analysis/src/runs";

// Simulator only. This fetch handler never forwards requests to a real provider.
const now = Date.now(), start = now - 600000;
const professor = "prof_00000000-0000-4000-8000-000000000020", course = "course_00000000-0000-4000-8000-000000000020";
const workspace = "workspace_00000000-0000-4000-8000-000000000020", team = "team_00000000-0000-4000-8000-000000000020";
const student = "student_00000000-0000-4000-8000-000000000020";
export const localRunId = "run_00000000-0000-4000-8000-000000000020";
const text = "합성 큐 모델 통합 자료", ts = `${Math.floor((now - 300000) / 1000)}.000000`, channel = "CSYNTHQUEUE", user = "USYNTHQUEUE";
const model = "qwen/qwen3.5-9b", tokenKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
export const localModelBindings = { SLACK_TOKEN_KEY: tokenKey, OPENROUTER_API_KEY: "synthetic-only-key",
  OPENROUTER_MODEL_EVIDENCE: model, OPENROUTER_MODEL_ASSESSOR: model, OPENROUTER_MODEL_REVIEWER: model };
export const localPaidCalls: string[] = [];
export const localReceiptCalls: string[] = [];
export const localEgress: string[] = [];
let missingReceipt = true;
export async function localProviderFetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  localEgress.push(`${request.method} ${url.hostname}${url.pathname}`);
  if (url.hostname === "slack.com") return Response.json({ ok: true, messages: [{ ts, user, text }], has_more: false });
  if (url.hostname !== "openrouter.ai") throw Error("Unexpected simulator egress");
  if (url.pathname.endsWith("/generation")) {
    const id = url.searchParams.get("id")!; localReceiptCalls.push(id);
    if (missingReceipt) { missingReceipt = false; return Response.json({ error: "synthetic metadata delay" }, { status: 503 }); }
    return Response.json({ data: { id, model, provider_name: "DeepInfra" } });
  }
  let body: any;
  try { body = await request.json(); }
  catch { throw Error("Simulator model request JSON is unreadable"); }
  if (!body?.response_format?.json_schema?.name) throw Error("Simulator model request has no structured schema");
  const name: string = body.response_format.json_schema.name;
  localPaidCalls.push(name);
  const content = body.messages[1].content, input = JSON.parse(typeof content === "string" ? content : content[0].text);
  let output: unknown;
  if (name === "teamplanet_evidence_v1") {
    const p = input.parts[0];
    output = { version: input.version, processedPartIds: input.primaryPartIds, limitations: [], events: [{ messageIds: [p.messageId], actorIds: [p.studentId],
      summary: "관찰된 설명 사례가 있다.", behaviorTags: ["clarity"], modality: "text", citations: [{ partId: p.id, start: p.start, end: p.end, quote: p.text }],
      imageCitations: [], limitations: [], requiresHumanReview: true }] };
  } else if (name === "teamplanet_assessment_v1") output = { version: input.version, runId: input.runId,
    overviews: [{ studentId: student, summary: "관찰된 설명 사례의 요약이다.", limitations: [], requiresHumanReview: false }],
    assessments: [{ studentId: student, key: "clarity", judgement: "observed_strength", narrative: "설명하는 발화가 관찰된다.", evidenceIds: [input.evidence[0].id], counterEvidenceIds: [],
      confidence: "medium", limitations: ["합성 환경"], requiresHumanReview: false }] };
  else if (name === "teamplanet_review_v1") output = { version: input.version, runId: input.runId, iteration: 0, decision: "accept", issues: [], limitations: [], requiresHumanReview: false };
  else throw Error("Unexpected simulator model stage");
  return Response.json({ id: `gen-local-${localPaidCalls.length}`, model, choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }] });
}
export async function seedLocalAnalysis(db: D1Database) {
  await db.batch([
    db.prepare("INSERT INTO professors VALUES (?, 'synthetic@example.invalid', 0)").bind(professor),
    db.prepare("INSERT INTO consent_policies VALUES ('queue-local-form', 0, 'synthetic')"),
    db.prepare("INSERT INTO courses (id,professor_id,name,created_at,consent_version,starts_at,ends_at) VALUES (?,?,'synthetic',0,'queue-local-form',?,?)").bind(course, professor, start - 600000, now + 86400000),
    db.prepare("INSERT INTO workspaces VALUES (?, 'TSYNTHQUEUE', 0)").bind(workspace),
    db.prepare("INSERT INTO slack_installations (workspace_id,team_name,app_id,bot_user_id,scopes,token_ciphertext,installed_by_slack_user_id,installed_by_professor_id,installed_at) VALUES (?,'synthetic','ASYNTHQUEUE','UBOTSYNTH','files:read',?,'UPROFSYNTH',?,0)").bind(workspace, await sealToken(tokenKey, workspace, "xoxb-local-synthetic"), professor),
    db.prepare("INSERT INTO teams (id,course_id,workspace_id,channel_id,name,collection_status) VALUES (?,?,?,?,'synthetic','active')").bind(team, course, workspace, channel),
    db.prepare("INSERT INTO students VALUES (?,?,'synthetic student',0)").bind(student, course),
    db.prepare("INSERT INTO slack_users VALUES (?,?)").bind(workspace, user),
    db.prepare("INSERT INTO student_slack_mappings VALUES (?,?,?,?)").bind(student, course, workspace, user),
    db.prepare("INSERT INTO team_members VALUES (?,?,?,?)").bind(team, student, course, workspace),
    db.prepare("INSERT INTO consents VALUES (?,?,'granted','queue-local-form',1)").bind(team, student),
    db.prepare("INSERT INTO consent_confirmations VALUES ('queue-confirm',?,?,'queue-local-form',?,2,99999999999999,3,(SELECT MAX(id) FROM consent_history))").bind(team, student, professor),
    db.prepare("INSERT INTO collection_windows (team_id,started_at) VALUES (?,?)").bind(team, start - 600000),
    db.prepare("INSERT INTO analysis_runs VALUES (?,?,?,?,'queued',NULL,?)").bind(localRunId, team, new Date(start).toISOString(), new Date(now - 60000).toISOString(), professor),
    db.prepare("INSERT INTO analysis_specs (run_id,team_id,professor_id,idempotency_key,request_hash,version,timezone,created_at,snapshot_json,students_json) VALUES (?,?,?,?,'synthetic',1,'Asia/Seoul',?,?,?)")
      .bind(localRunId, team, professor, crypto.randomUUID(), now, JSON.stringify(snapshot({ rubricVersion: "communication-v1", selectedCompetencies: ["clarity"] })), JSON.stringify([{ id: student, displayName: "synthetic student" }])),
  ]);
}
