import { expect, test } from "bun:test";
import {
  activateTeamResponseSchema, activateTeamSchema, analysisRunRequestSchema, apiErrorCodes, apiErrorSchema, apiErrorStatus,
  competencyAssessmentSchema, consentListResponseSchema, consentSchema, courseListResponseSchema, courseSchema,
  createCourseSchema, createStudentSchema, createTeamSchema, dateTimeSchema, logoutResponseSchema,
  otpRequestResponseSchema, otpRequestSchema, otpVerifySchema, professorSchema, sessionResponseSchema,
  setConsentSchema, setTeamMemberSchema, studentListResponseSchema, studentSchema, teamMemberListResponseSchema,
  teamMemberSchema, teamSchema, teamListResponseSchema, workspaceSchema, teamParamsSchema, courseParamsSchema, teamStudentParamsSchema,
  inviteTeamSchema, inviteTeamResponseSchema,
} from "./index";
import * as f from "./fixtures";

test("synthetic auth, team, consent and assessment fixtures satisfy the public schemas", () => {
  for (const professor of f.professors) professorSchema.parse(professor);
  for (const course of f.courses) courseSchema.parse(course);
  for (const team of f.teams) teamSchema.parse(team);
  for (const student of f.students) studentSchema.parse(student);
  for (const member of f.members) teamMemberSchema.parse(member);
  workspaceSchema.parse(f.workspace);
  otpRequestSchema.parse(f.auth.request);
  otpRequestResponseSchema.parse(f.auth.accepted);
  otpVerifySchema.parse(f.auth.verify);
  sessionResponseSchema.parse(f.auth.session);
  logoutResponseSchema.parse(f.auth.logout);
  createCourseSchema.parse(f.course.create);
  createStudentSchema.parse(f.student.create);
  createTeamSchema.parse(f.team.create);
  setTeamMemberSchema.parse(f.team.setMember);
  inviteTeamSchema.parse(f.team.invite);
  inviteTeamResponseSchema.parse(f.team.invited);
  inviteTeamResponseSchema.parse(f.team.manualInvite);
  activateTeamSchema.parse(f.team.activate);
  activateTeamResponseSchema.parse(f.team.activated);
  for (const change of [f.consent.grant, f.consent.decline, f.consent.withdraw]) setConsentSchema.parse(change);
  consentSchema.parse(f.consent.response);
  courseListResponseSchema.parse(f.course.list);
  teamListResponseSchema.parse(f.team.list);
  studentListResponseSchema.parse(f.student.list);
  teamMemberListResponseSchema.parse(f.team.members);
  consentListResponseSchema.parse({ consents: [f.consent.response] });
  teamParamsSchema.parse({ teamId: f.team.response.id });
  courseParamsSchema.parse({ courseId: f.courses[0]!.id });
  teamStudentParamsSchema.parse({ teamId: f.team.response.id, studentId: f.students[0]!.id });
  analysisRunRequestSchema.parse(f.analysisRequest);
  competencyAssessmentSchema.parse(f.assessment);
});

test("failure examples cover the error codes and their HTTP statuses without private details", () => {
  expect(Object.values(f.failures).map(value => value.body.error.code).sort()).toEqual([...apiErrorCodes].sort());
  for (const { status, body } of Object.values(f.failures)) {
    apiErrorSchema.parse(body);
    expect(status).toBe(apiErrorStatus[body.error.code]);
  }
});

const cases = [
  ["missing required email", otpRequestSchema, f.invalid.missingEmail],
  ["client-supplied owner", createTeamSchema, f.invalid.unknownOwner],
  ["numeric OTP loses leading zeros", otpVerifySchema, f.invalid.numericOtp],
  ["wrong resource ID", createTeamSchema, f.invalid.wrongResourceId],
  ["DM channel ID", createTeamSchema, f.invalid.badSlackId],
  ["unknown competency", competencyAssessmentSchema, f.invalid.unknownCompetency],
  ["missing human review flag", competencyAssessmentSchema, f.invalid.missingReviewFlag],
  ["reversed period", analysisRunRequestSchema, f.invalid.reversedPeriod],
  ["empty period", analysisRunRequestSchema, f.invalid.emptyPeriod],
  ["invalid calendar date", analysisRunRequestSchema, f.invalid.invalidDate],
  ["non-UTC date", analysisRunRequestSchema, f.invalid.nonUtcDate],
  ["client-supplied consent time", setConsentSchema, f.invalid.forgedConsentTime],
] as const;
for (const [label, schema, value] of cases) {
  test(`rejects ${label}`, () => expect(schema.safeParse(value).success).toBe(false));
}

test("external JSON boundaries reject null, arrays and extra fields", () => {
  for (const value of [null, [], "{}", { email: "bad" }, { email: f.auth.request.email, admin: true }]) {
    expect(otpRequestSchema.safeParse(value).success).toBe(false);
  }
  expect(otpRequestSchema.parse({ email: "PROFESSOR-A@example.invalid" }).email).toBe(f.auth.request.email);
  expect(otpVerifySchema.parse({ ...f.auth.verify, code: "000001" }).code).toBe("000001");
  expect(dateTimeSchema.safeParse("2026-10-26").success).toBe(false);
  expect(dateTimeSchema.safeParse("2026-10-26T00:00:00Z").success).toBe(false);
  expect(setConsentSchema.safeParse({ status: "pending", version: "v1" }).success).toBe(false);
  expect(createTeamSchema.safeParse({ ...f.team.create, name: "  " }).success).toBe(false);
});
