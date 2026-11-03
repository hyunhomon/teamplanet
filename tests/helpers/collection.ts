import { sealToken, sha256Hex } from "@teamplanet/collection";
import * as fixtures from "@teamplanet/contracts/fixtures";
import { sqliteD1 } from "./d1";

/** Entirely synthetic active course/member/message, on the actual migrations. */
export async function collectionFixture() {
  const database = sqliteD1(), sql = database.sqlite;
  const professor = fixtures.professors[0]!, course = fixtures.courses[0]!, workspace = fixtures.workspace;
  const teamId = fixtures.teams[0]!.id, studentId = fixtures.students[0]!.id, channelId = "CSYNTHIMG1", userId = "USYNTHSTU1";
  const start = Date.parse("2026-11-01T00:00:00.000Z"), now = () => start + 86_400_000;
  const slackTs = `${Math.floor(start / 1000) + 100}.000000`, text = "합성 프로젝트 도식";
  const tokenKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  sql.run("INSERT INTO professors VALUES (?, ?, 0)", [professor.id, professor.email]);
  sql.run("INSERT INTO consent_policies VALUES ('pilot-form-v1', 0, 'synthetic-operator')");
  sql.run("INSERT INTO courses (id, professor_id, name, created_at, consent_version, starts_at, ends_at) VALUES (?, ?, '합성 수업', 0, 'pilot-form-v1', ?, ?)", [course.id, professor.id, start, start + 60 * 86_400_000]);
  sql.run("INSERT INTO workspaces VALUES (?, ?, 0)", [workspace.id, workspace.slackTeamId]);
  sql.run(`INSERT INTO slack_installations (workspace_id, team_name, app_id, bot_user_id, scopes, token_ciphertext, installed_by_slack_user_id, installed_by_professor_id, installed_at)
    VALUES (?, 'synthetic', 'ASYNTH0001', 'USYNTHBOT1', 'files:read', ?, 'USYNTHPROF', ?, 0)`, [workspace.id, await sealToken(tokenKey, workspace.id, "xoxb-synthetic"), professor.id]);
  sql.run("INSERT INTO teams (id, course_id, workspace_id, channel_id, name, collection_status) VALUES (?, ?, ?, ?, '합성 팀', 'active')", [teamId, course.id, workspace.id, channelId]);
  sql.run("INSERT INTO students VALUES (?, ?, '합성 학생', 0)", [studentId, course.id]);
  sql.run("INSERT INTO slack_users VALUES (?, ?)", [workspace.id, userId]);
  sql.run("INSERT INTO student_slack_mappings VALUES (?, ?, ?, ?)", [studentId, course.id, workspace.id, userId]);
  sql.run("INSERT INTO team_members VALUES (?, ?, ?, ?)", [teamId, studentId, course.id, workspace.id]);
  sql.run("INSERT INTO consents VALUES (?, ?, 'granted', 'pilot-form-v1', 1)", [teamId, studentId]);
  sql.run("INSERT INTO consent_confirmations VALUES ('synthetic-confirm', ?, ?, 'pilot-form-v1', ?, 2, 99999999999999, 3, (SELECT MAX(id) FROM consent_history))", [teamId, studentId, professor.id]);
  sql.run("INSERT INTO collection_windows (team_id, started_at) VALUES (?, ?)", [teamId, start]);
  sql.run(`INSERT INTO message_refs (channel_id, slack_ts, team_id, user_id, revision, content_hash, source, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'history', ?, ?)`, [channelId, slackTs, teamId, userId, slackTs, await sha256Hex(text), start, start]);
  return { ...database, professor, course, workspace, teamId, studentId, channelId, userId, start, now, slackTs, text, tokenKey, target: { teamId, channelId, slackTs } };
}
