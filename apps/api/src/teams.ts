import { Hono, type Context } from "hono";
import {
  createTeamSchema, inviteTeamSchema, setTeamMemberSchema, slackChannelIdSchema, slackUserIdSchema, teamParamsSchema,
  teamStudentParamsSchema, type InviteTeamResponse, type Team, type TeamMember, type TeamMembership,
} from "@teamplanet/contracts";
import { iso } from "./auth";
import { apiError, parseBody } from "./errors";
import { audit, owned } from "./guard";
import { callSlack, slackBot, slackFailure, slackNotConnected, type SlackEnv, type SlackFetch } from "./slack";

type TeamRow = { id: string; course_id: string; workspace_id: string; channel_id: string; name: string; collection_status: Team["collectionStatus"] };
const toTeam = (team: TeamRow): Team => ({
  id: team.id, courseId: team.course_id, workspaceId: team.workspace_id,
  channelId: team.channel_id, name: team.name, collectionStatus: team.collection_status,
});
type MemberRow = { team_id: string; student_id: string; course_id: string; workspace_id: string; slack_user_id: string };
const toMember = (row: MemberRow): TeamMember => ({
  teamId: row.team_id, studentId: row.student_id, courseId: row.course_id, workspaceId: row.workspace_id, slackUserId: row.slack_user_id,
});
const MEMBERS_SQL = `SELECT m.team_id, m.student_id, m.course_id, m.workspace_id, s.slack_user_id FROM team_members m
  JOIN student_slack_mappings s ON s.student_id = m.student_id WHERE m.team_id = ? ORDER BY m.student_id`;

/** `teamplanet-{course}-{team}` within Slack's rules: lowercase, no spaces or punctuation except - and _, at most 80 chars. */
export function channelName(courseName: string, teamName: string) {
  const slug = (value: string) => value.normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  return `teamplanet-${slug(courseName) || "course"}-${slug(teamName) || "team"}`.slice(0, 80).replace(/-+$/, "");
}

/** Current channel membership from Slack, or the error Response to return. Shared by the membership API and activation (#8). */
export async function liveMembership(
  context: Context<SlackEnv>, team: Pick<TeamRow, "id" | "workspace_id" | "channel_id">, send: SlackFetch, now: () => number,
): Promise<TeamMembership | Response> {
  const bot = await slackBot(context);
  if (!bot || bot.workspaceId !== team.workspace_id) return slackNotConnected(context);
  const channelMembers = new Set<string>();
  let botInChannel: boolean;
  try {
    const info = await callSlack(send, bot.token, "conversations.info", { channel: team.channel_id });
    if (!info.ok) return slackFailure(context, "conversations.info", info);
    botInChannel = info.body.channel?.is_member === true && info.body.channel?.is_archived !== true;
    let cursor = "";
    do {
      const page = await callSlack(send, bot.token, "conversations.members", { channel: team.channel_id, limit: "200", ...(cursor ? { cursor } : {}) });
      if (!page.ok) return slackFailure(context, "conversations.members", page);
      for (const id of page.body.members ?? []) if (slackUserIdSchema.safeParse(id).success) channelMembers.add(id);
      cursor = typeof page.body.response_metadata?.next_cursor === "string" ? page.body.response_metadata.next_cursor : "";
    } while (cursor);
  } catch {
    return slackFailure(context, "conversations.members", { error: "network" });
  }
  const { results } = await context.env.DB.prepare(MEMBERS_SQL).bind(team.id).all<MemberRow>();
  const members = results.map(row => ({ studentId: row.student_id, slackUserId: row.slack_user_id, inChannel: channelMembers.has(row.slack_user_id) }));
  const known = new Set([bot.botUserId, ...members.map(member => member.slackUserId)]);
  // ponytail: any unmapped account (also other apps' bots) blocks completeness; add a per-user bot lookup if pilots need other apps.
  const unmappedChannelMembers = [...channelMembers].filter(id => !known.has(id)).sort();
  const complete = botInChannel && members.length > 0 && members.every(member => member.inChannel) && unmappedChannelMembers.length === 0;
  return { teamId: team.id, checkedAt: iso(now()), botInChannel, members, unmappedChannelMembers, complete };
}

const notFound = (context: Context) => apiError(context, "NOT_FOUND", "리소스를 찾을 수 없습니다.");
const invalid = (context: Context, path: string, message: string) =>
  apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.", { issues: [{ path: [path], message }] });
const isUniqueViolation = (error: unknown) => error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
// Invite failures where only a Slack admin can help; never reported as success.
const manualInviteErrors = new Set(["cant_invite", "user_is_restricted", "ura_max_channels", "no_permission", "user_not_found", "org_user_not_in_team"]);

export function teamRoutes(now: () => number, send: SlackFetch) {
  const routes = new Hono<SlackEnv>();
  const params = (context: Context<SlackEnv>) => teamParamsSchema.safeParse({ teamId: context.req.param("teamId") });

  routes.get("/teams", async context => {
    const { results } = await context.env.DB.prepare(`SELECT t.* FROM teams t JOIN courses c ON c.id = t.course_id
      WHERE c.professor_id = ? ORDER BY t.name, t.id`).bind(context.get("professor").id).all<TeamRow>();
    return context.json({ teams: results.map(toTeam) }, 200);
  });

  routes.post("/teams", async context => {
    const input = await parseBody(context, createTeamSchema);
    if (input.error) return input.error;
    const { courseId, workspaceId, name } = input.data;
    const db = context.env.DB;
    const course = await owned<{ name: string }>(context, "course", courseId);
    if (!course) return notFound(context);
    const bot = await slackBot(context);
    if (!bot) return slackNotConnected(context);
    if (workspaceId !== bot.workspaceId) return invalid(context, "workspaceId", "연결된 파일럿 workspace가 아닙니다.");
    // Check our own registry before touching Slack, so a retry never creates or joins a second channel.
    const taken = await db.prepare("SELECT 1 FROM teams WHERE workspace_id = ? AND (name = ? OR channel_id = ?)")
      .bind(workspaceId, name, input.data.channelId ?? "").first();
    if (taken) return apiError(context, "CONFLICT", "이미 등록된 팀 이름이나 채널입니다.");

    let channelId: string;
    try {
      if (input.data.channelId) {
        channelId = input.data.channelId;
        const info = await callSlack(send, bot.token, "conversations.info", { channel: channelId });
        if (!info.ok) return info.error === "channel_not_found" ? invalid(context, "channelId", "Slack 채널을 찾을 수 없습니다.") : slackFailure(context, "conversations.info", info);
        const channel = info.body.channel ?? {};
        // Only an official public channel of this workspace: no DM, group DM, private, archived or shared channel.
        if (channel.is_channel !== true || channel.is_private !== false || channel.is_archived === true || channel.is_im || channel.is_mpim
          || channel.is_ext_shared || channel.is_shared) {
          return invalid(context, "channelId", "공개된 공식 채널만 지정할 수 있습니다.");
        }
        if (channel.is_member !== true) {
          const joined = await callSlack(send, bot.token, "conversations.join", { channel: channelId });
          if (!joined.ok) return slackFailure(context, "conversations.join", joined);
        }
      } else {
        const created = await callSlack(send, bot.token, "conversations.create", { name: channelName(course.name, name), is_private: "false" });
        if (!created.ok) {
          if (created.error === "name_taken") return apiError(context, "CONFLICT", "같은 이름의 Slack 채널이 있습니다. 기존 채널로 지정하세요.");
          if (created.error.startsWith("invalid_name")) return invalid(context, "name", "Slack 채널 이름으로 만들 수 없습니다. 기존 채널로 지정하세요.");
          return slackFailure(context, "conversations.create", created);
        }
        const id = slackChannelIdSchema.safeParse(created.body.channel?.id);
        if (!id.success) return slackFailure(context, "conversations.create", { error: "unexpected_response" });
        channelId = id.data;
      }
    } catch {
      return slackFailure(context, "conversations", { error: "network" });
    }

    const team: TeamRow = { id: `team_${crypto.randomUUID()}`, course_id: courseId, workspace_id: workspaceId, channel_id: channelId, name, collection_status: "inactive" };
    try {
      await db.batch([
        db.prepare("INSERT INTO teams (id, course_id, workspace_id, channel_id, name, collection_status) VALUES (?, ?, ?, ?, ?, 'inactive')")
          .bind(team.id, team.course_id, team.workspace_id, team.channel_id, team.name),
        audit(context, { action: "team.create", targetType: "team", targetId: team.id, result: "succeeded" }, now),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(context, "CONFLICT", "이미 등록된 팀 이름이나 채널입니다.");
      throw error;
    }
    return context.json(toTeam(team), 201);
  });

  routes.get("/teams/:teamId", async context => {
    const parsed = params(context);
    if (!parsed.success) return apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
    const { teamId } = parsed.data;
    const team = await owned<TeamRow>(context, "team", teamId);
    await audit(context, { action: "team.read", targetType: "team", targetId: teamId, result: team ? "succeeded" : "denied" }, now).run();
    if (!team) return notFound(context);
    return context.json(toTeam(team), 200);
  });

  routes.put("/teams/:teamId/members/:studentId", async context => {
    const path = teamStudentParamsSchema.safeParse({ teamId: context.req.param("teamId"), studentId: context.req.param("studentId") });
    if (!path.success) return apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
    const input = await parseBody(context, setTeamMemberSchema);
    if (input.error) return input.error;
    const { teamId, studentId } = path.data;
    const { workspaceId, slackUserId } = input.data;
    const db = context.env.DB;
    const team = await owned<TeamRow>(context, "team", teamId);
    const student = await owned<{ course_id: string }>(context, "student", studentId);
    if (!team || !student || student.course_id !== team.course_id) {
      await audit(context, { action: "team.member_set", targetType: "student", targetId: studentId, result: "denied" }, now).run();
      return notFound(context);
    }
    if (workspaceId !== team.workspace_id) return invalid(context, "workspaceId", "팀의 workspace와 다릅니다.");

    const mapped = await db.prepare("SELECT slack_user_id FROM student_slack_mappings WHERE student_id = ?").bind(studentId).first<{ slack_user_id: string }>();
    if (mapped && mapped.slack_user_id !== slackUserId) return apiError(context, "CONFLICT", "이미 다른 Slack 계정에 연결된 학생입니다.");
    if (!mapped) {
      const other = await db.prepare("SELECT 1 FROM student_slack_mappings WHERE course_id = ? AND workspace_id = ? AND slack_user_id = ?")
        .bind(team.course_id, workspaceId, slackUserId).first();
      if (other) return apiError(context, "CONFLICT", "이 Slack 계정은 수업의 다른 학생에 연결되어 있습니다.");
      const bot = await slackBot(context);
      if (!bot || bot.workspaceId !== workspaceId) return slackNotConnected(context);
      let user;
      try {
        user = await callSlack(send, bot.token, "users.info", { user: slackUserId });
      } catch {
        return slackFailure(context, "users.info", { error: "network" });
      }
      if (!user.ok) return user.error === "user_not_found" ? invalid(context, "slackUserId", "Slack 사용자를 찾을 수 없습니다.") : slackFailure(context, "users.info", user);
      const profile = user.body.user ?? {};
      if (profile.deleted === true || profile.is_bot === true || profile.team_id !== bot.slackTeamId) {
        return invalid(context, "slackUserId", "이 workspace의 활성 사용자만 연결할 수 있습니다.");
      }
    }
    try {
      await db.batch([
        db.prepare("INSERT INTO slack_users (workspace_id, slack_user_id) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(workspaceId, slackUserId),
        db.prepare(`INSERT INTO student_slack_mappings (student_id, course_id, workspace_id, slack_user_id) VALUES (?, ?, ?, ?)
          ON CONFLICT (student_id) DO NOTHING`).bind(studentId, team.course_id, workspaceId, slackUserId),
        db.prepare("INSERT INTO team_members (team_id, student_id, course_id, workspace_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
          .bind(teamId, studentId, team.course_id, workspaceId),
        audit(context, { action: "team.member_set", targetType: "student", targetId: studentId, result: "succeeded" }, now),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) return apiError(context, "CONFLICT", "이 Slack 계정은 수업의 다른 학생에 연결되어 있습니다.");
      throw error;
    }
    return context.json({ teamId, studentId, courseId: team.course_id, workspaceId, slackUserId } satisfies TeamMember, 200);
  });

  routes.get("/teams/:teamId/members", async context => {
    const parsed = params(context);
    if (!parsed.success) return apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
    if (!await owned(context, "team", parsed.data.teamId)) return notFound(context);
    const { results } = await context.env.DB.prepare(MEMBERS_SQL).bind(parsed.data.teamId).all<MemberRow>();
    return context.json({ members: results.map(toMember) }, 200);
  });

  // Live Slack check so #8 sees new members, leavers and lost bot access. Reads membership only, never messages.
  routes.get("/teams/:teamId/membership", async context => {
    const parsed = params(context);
    if (!parsed.success) return apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
    const team = await owned<TeamRow>(context, "team", parsed.data.teamId);
    if (!team) return notFound(context);
    const membership = await liveMembership(context, team, send, now);
    return membership instanceof Response ? membership : context.json(membership, 200);
  });

  routes.post("/teams/:teamId/invite", async context => {
    const parsed = params(context);
    if (!parsed.success) return apiError(context, "VALIDATION_ERROR", "요청 형식을 확인하세요.");
    const input = await parseBody(context, inviteTeamSchema);
    if (input.error) return input.error;
    const { teamId } = parsed.data;
    const { studentId } = input.data;
    const team = await owned<TeamRow>(context, "team", teamId);
    const student = await owned<{ course_id: string }>(context, "student", studentId);
    if (!team || !student || student.course_id !== team.course_id) return notFound(context);
    const answer = async (status: InviteTeamResponse["status"]) => {
      await audit(context, { action: "team.invite", targetType: "student", targetId: studentId, result: "succeeded" }, now).run();
      return context.json({ teamId, studentId, status } satisfies InviteTeamResponse, 200);
    };
    const mapping = await context.env.DB.prepare(`SELECT s.slack_user_id, m.team_id FROM student_slack_mappings s
      LEFT JOIN team_members m ON m.student_id = s.student_id AND m.team_id = ? WHERE s.student_id = ?`)
      .bind(teamId, studentId).first<{ slack_user_id: string; team_id: string | null }>();
    // No Slack account mapped yet: workspace invites need a Slack admin, so the professor invites by hand.
    if (!mapping) return answer("manual_invite_required");
    if (!mapping.team_id) return apiError(context, "CONFLICT", "먼저 팀 멤버로 등록하세요.");
    const bot = await slackBot(context);
    if (!bot || bot.workspaceId !== team.workspace_id) return slackNotConnected(context);
    let invited;
    try {
      invited = await callSlack(send, bot.token, "conversations.invite", { channel: team.channel_id, users: mapping.slack_user_id });
    } catch {
      return slackFailure(context, "conversations.invite", { error: "network" });
    }
    if (invited.ok) return answer("invited");
    if (invited.error === "already_in_channel") return answer("already_member");
    if (manualInviteErrors.has(invited.error)) return answer("manual_invite_required");
    if (invited.error === "not_in_channel") return apiError(context, "CHANNEL_MEMBERSHIP_REQUIRED", "봇이 채널에 없습니다. 봇을 채널에 다시 초대하세요.");
    return slackFailure(context, "conversations.invite", invited);
  });

  return routes;
}
