import { z } from "zod";

// Public IDs are opaque, resource-prefixed UUIDv4 values, never Slack IDs or emails.
const id = (prefix: string) => z.string().regex(new RegExp(
  `^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
));
export const professorIdSchema = id("prof");
export const courseIdSchema = id("course");
export const teamIdSchema = id("team");
export const studentIdSchema = id("student");
export const workspaceIdSchema = id("workspace");
export const challengeIdSchema = id("challenge");
export const requestIdSchema = id("request");
export const slackTeamIdSchema = z.string().regex(/^T[A-Z0-9]{8,}$/);
export const slackUserIdSchema = z.string().regex(/^[UW][A-Z0-9]{8,}$/);
export const slackChannelIdSchema = z.string().regex(/^C[A-Z0-9]{8,}$/);
// Exactly UTC with milliseconds. SQLite timestamps are epoch milliseconds.
export const dateTimeSchema = z.iso.datetime({ precision: 3 });
const nameSchema = z.string().trim().min(1).max(200);
const versionSchema = z.string().trim().min(1).max(100);
export const emailSchema = z.email().max(254).transform(value => value.toLowerCase());

export const professorSchema = z.strictObject({
  id: professorIdSchema, email: emailSchema, createdAt: dateTimeSchema,
});
export const courseSchema = z.strictObject({
  id: courseIdSchema, professorId: professorIdSchema, name: nameSchema, createdAt: dateTimeSchema,
});
export const workspaceSchema = z.strictObject({
  id: workspaceIdSchema, slackTeamId: slackTeamIdSchema, createdAt: dateTimeSchema,
});
export const collectionStatusSchema = z.enum(["inactive", "active", "paused"]);
export const teamSchema = z.strictObject({
  id: teamIdSchema, courseId: courseIdSchema, workspaceId: workspaceIdSchema,
  channelId: slackChannelIdSchema, name: nameSchema, collectionStatus: collectionStatusSchema,
});
export const studentSchema = z.strictObject({
  id: studentIdSchema, courseId: courseIdSchema, displayName: nameSchema, createdAt: dateTimeSchema,
});
export const teamMemberSchema = z.strictObject({
  teamId: teamIdSchema, studentId: studentIdSchema, courseId: courseIdSchema,
  workspaceId: workspaceIdSchema, slackUserId: slackUserIdSchema,
});

export const otpRequestSchema = z.strictObject({ email: emailSchema });
export const otpRequestResponseSchema = z.strictObject({
  challengeId: challengeIdSchema, expiresAt: dateTimeSchema, resendAvailableAt: dateTimeSchema,
});
export const otpVerifySchema = z.strictObject({
  challengeId: challengeIdSchema, code: z.string().regex(/^\d{6}$/),
});
export const sessionResponseSchema = z.strictObject({ professor: professorSchema, expiresAt: dateTimeSchema });
export const logoutResponseSchema = z.strictObject({ loggedOut: z.literal(true) });
export const createCourseSchema = z.strictObject({ name: nameSchema });
export const createStudentSchema = z.strictObject({ displayName: nameSchema });
export const createTeamSchema = z.strictObject({
  courseId: courseIdSchema, workspaceId: workspaceIdSchema, channelId: slackChannelIdSchema, name: nameSchema,
});
export const setTeamMemberSchema = z.strictObject({
  workspaceId: workspaceIdSchema, slackUserId: slackUserIdSchema,
});
export const inviteTeamSchema = z.strictObject({ studentId: studentIdSchema });
export const inviteTeamResponseSchema = z.strictObject({
  teamId: teamIdSchema, studentId: studentIdSchema,
  status: z.enum(["invited", "already_member", "manual_invite_required"]),
});
export const consentStatusSchema = z.enum(["pending", "granted", "declined", "withdrawn"]);
export const setConsentSchema = z.strictObject({
  status: z.enum(["granted", "declined", "withdrawn"]), version: versionSchema,
});
export const consentSchema = z.strictObject({
  teamId: teamIdSchema, studentId: studentIdSchema, status: consentStatusSchema,
  version: versionSchema, recordedAt: dateTimeSchema,
});
export const activateTeamSchema = z.strictObject({});
export const activateTeamResponseSchema = z.strictObject({
  teamId: teamIdSchema, collectionStatus: z.literal("active"), activatedAt: dateTimeSchema,
});
export const courseListResponseSchema = z.strictObject({ courses: z.array(courseSchema) });
export const teamListResponseSchema = z.strictObject({ teams: z.array(teamSchema) });
export const studentListResponseSchema = z.strictObject({ students: z.array(studentSchema) });
export const teamMemberListResponseSchema = z.strictObject({ members: z.array(teamMemberSchema) });
export const consentListResponseSchema = z.strictObject({ consents: z.array(consentSchema) });
// #6: what a professor needs to see about the pilot workspace. Never carries tokens or Slack secrets.
export const slackConnectionSchema = z.strictObject({
  status: z.enum(["not_connected", "connected", "insufficient_scope", "revoked"]),
  workspace: z.strictObject({
    id: workspaceIdSchema, slackTeamId: slackTeamIdSchema, name: nameSchema, installedAt: dateTimeSchema,
  }).nullable(),
  missingScopes: z.array(z.string()),
});
// Result the OAuth callback appends to its redirect back to the web app: `/workspace?slack=<outcome>`.
export const slackInstallOutcomeSchema = z.enum([
  "installed", "reinstalled", "insufficient_scope", "cancelled", "invalid_state", "workspace_mismatch", "failed",
]);
export const teamParamsSchema = z.strictObject({ teamId: teamIdSchema });
export const courseParamsSchema = z.strictObject({ courseId: courseIdSchema });
export const teamStudentParamsSchema = z.strictObject({ teamId: teamIdSchema, studentId: studentIdSchema });

export const apiErrorCodes = [
  "VALIDATION_ERROR", "UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND", "CONFLICT",
  "OTP_INVALID", "OTP_EXPIRED", "RATE_LIMITED", "CONSENT_REQUIRED",
  "CHANNEL_MEMBERSHIP_REQUIRED", "POLICY_NOT_APPROVED", "EMAIL_DELIVERY_UNAVAILABLE", "SLACK_UNAVAILABLE", "INTERNAL_SERVER_ERROR",
] as const;
export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(apiErrorCodes), message: z.string().min(1), requestId: requestIdSchema,
    retryable: z.boolean(),
    issues: z.array(z.strictObject({ path: z.array(z.union([z.string(), z.number()])), message: z.string() })).optional(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  }),
});

export type Professor = z.infer<typeof professorSchema>;
export type Course = z.infer<typeof courseSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
export type Team = z.infer<typeof teamSchema>;
export type Student = z.infer<typeof studentSchema>;
export type TeamMember = z.infer<typeof teamMemberSchema>;
export type OtpRequest = z.infer<typeof otpRequestSchema>;
export type OtpRequestResponse = z.infer<typeof otpRequestResponseSchema>;
export type OtpVerify = z.infer<typeof otpVerifySchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
export type CreateCourse = z.infer<typeof createCourseSchema>;
export type CreateStudent = z.infer<typeof createStudentSchema>;
export type CreateTeam = z.infer<typeof createTeamSchema>;
export type SetTeamMember = z.infer<typeof setTeamMemberSchema>;
export type InviteTeam = z.infer<typeof inviteTeamSchema>;
export type InviteTeamResponse = z.infer<typeof inviteTeamResponseSchema>;
export type SetConsent = z.infer<typeof setConsentSchema>;
export type Consent = z.infer<typeof consentSchema>;
export type ActivateTeam = z.infer<typeof activateTeamSchema>;
export type ActivateTeamResponse = z.infer<typeof activateTeamResponseSchema>;
export type CourseListResponse = z.infer<typeof courseListResponseSchema>;
export type TeamListResponse = z.infer<typeof teamListResponseSchema>;
export type StudentListResponse = z.infer<typeof studentListResponseSchema>;
export type TeamMemberListResponse = z.infer<typeof teamMemberListResponseSchema>;
export type ConsentListResponse = z.infer<typeof consentListResponseSchema>;
export type SlackConnection = z.infer<typeof slackConnectionSchema>;
export type SlackInstallOutcome = z.infer<typeof slackInstallOutcomeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorCode = ApiError["error"]["code"];

export const apiErrorStatus = {
  VALIDATION_ERROR: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409,
  OTP_INVALID: 401, OTP_EXPIRED: 401, RATE_LIMITED: 429, CONSENT_REQUIRED: 409,
  CHANNEL_MEMBERSHIP_REQUIRED: 409, POLICY_NOT_APPROVED: 409, EMAIL_DELIVERY_UNAVAILABLE: 503, SLACK_UNAVAILABLE: 503, INTERNAL_SERVER_ERROR: 500,
} as const satisfies Record<ApiErrorCode, number>;
