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
// #7: with channelId the server adopts that existing public channel; without it, it creates `teamplanet-{course}-{team}`.
export const createTeamSchema = z.strictObject({
  courseId: courseIdSchema, workspaceId: workspaceIdSchema, channelId: slackChannelIdSchema.optional(), name: nameSchema,
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
// #8: evidenceRef is an opaque paper-form reference (no personal data), required by the server for `granted`.
export const setConsentSchema = z.strictObject({
  status: z.enum(["granted", "declined", "withdrawn"]), version: versionSchema,
  evidenceRef: z.string().trim().min(1).max(100).optional(),
});
export const consentSchema = z.strictObject({
  teamId: teamIdSchema, studentId: studentIdSchema, status: consentStatusSchema,
  version: versionSchema, recordedAt: dateTimeSchema,
  // #8: when the student re-confirmed this grant through their QR link; null until then.
  studentConfirmedAt: dateTimeSchema.nullable().optional(),
});
// #8 course pilot settings. The version must be operator-approved (consent_policies) before consents or activation.
export const coursePilotSchema = z.strictObject({ consentVersion: versionSchema, endsAt: dateTimeSchema });
export const coursePilotResponseSchema = z.strictObject({
  courseId: courseIdSchema, consentVersion: versionSchema.nullable(), endsAt: dateTimeSchema.nullable(), policyApproved: z.boolean(),
});
// #8 student QR re-confirmation (#29 builds the page). The token travels in the URL fragment and request bodies only.
export const consentTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const consentConfirmationIssueResponseSchema = z.strictObject({ confirmationUrl: z.url(), expiresAt: dateTimeSchema });
export const consentConfirmationLookupSchema = z.strictObject({ token: consentTokenSchema });
export const consentConfirmationLookupResponseSchema = z.strictObject({
  courseName: nameSchema, teamName: nameSchema, studentDisplayName: nameSchema, version: versionSchema,
  expiresAt: dateTimeSchema, confirmedAt: dateTimeSchema.nullable(),
});
export const consentConfirmSchema = z.strictObject({ token: consentTokenSchema, confirmed: z.literal(true) });
export const consentConfirmResponseSchema = z.strictObject({ confirmedAt: dateTimeSchema });
export const activateTeamSchema = z.strictObject({});
export const activateTeamResponseSchema = z.strictObject({
  teamId: teamIdSchema, collectionStatus: z.literal("active"), activatedAt: dateTimeSchema,
});
export const deactivateTeamSchema = z.strictObject({});
export const collectionEndReasonSchema = z.enum([
  "professor", "consent_changed", "policy_changed", "unknown_participant", "member_left", "bot_removed", "slack_revoked", "course_ended",
]);
export const collectionStatusResponseSchema = z.strictObject({
  teamId: teamIdSchema, collectionStatus: collectionStatusSchema,
  windows: z.array(z.strictObject({ startedAt: dateTimeSchema, endedAt: dateTimeSchema.nullable(), endReason: collectionEndReasonSchema.nullable() })),
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
// #7: live channel membership. `complete` is necessary, not sufficient, for activation (#8 adds consent/policy checks).
export const teamMembershipSchema = z.strictObject({
  teamId: teamIdSchema, checkedAt: dateTimeSchema, botInChannel: z.boolean(),
  members: z.array(z.strictObject({ studentId: studentIdSchema, slackUserId: slackUserIdSchema, inChannel: z.boolean() })),
  unmappedChannelMembers: z.array(slackUserIdSchema),
  complete: z.boolean(),
});
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
export type TeamMembership = z.infer<typeof teamMembershipSchema>;
export type CoursePilot = z.infer<typeof coursePilotSchema>;
export type CoursePilotResponse = z.infer<typeof coursePilotResponseSchema>;
export type ConsentConfirmationLookupResponse = z.infer<typeof consentConfirmationLookupResponseSchema>;
export type CollectionStatusResponse = z.infer<typeof collectionStatusResponseSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorCode = ApiError["error"]["code"];

export const apiErrorStatus = {
  VALIDATION_ERROR: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409,
  OTP_INVALID: 401, OTP_EXPIRED: 401, RATE_LIMITED: 429, CONSENT_REQUIRED: 409,
  CHANNEL_MEMBERSHIP_REQUIRED: 409, POLICY_NOT_APPROVED: 409, EMAIL_DELIVERY_UNAVAILABLE: 503, SLACK_UNAVAILABLE: 503, INTERNAL_SERVER_ERROR: 500,
} as const satisfies Record<ApiErrorCode, number>;
