import type {
  ApiError, ApiErrorCode, Consent, Course, OtpRequest, OtpRequestResponse, OtpVerify,
  Professor, SessionResponse, Student, Team, TeamMember, Workspace,
} from "./api";
import { apiErrorStatus } from "./api";
import type { CompetencyAssessment } from "./index";

// Entirely invented identities; .invalid domains can never deliver email.
const at = "2026-10-26T00:00:00.000Z";
export const professors = [
  { id: "prof_00000000-0000-4000-8000-000000000001", email: "professor-a@example.invalid", createdAt: at },
  { id: "prof_00000000-0000-4000-8000-000000000002", email: "professor-b@example.invalid", createdAt: at },
] satisfies Professor[];
export const courses = [
  { id: "course_00000000-0000-4000-8000-000000000001", professorId: professors[0]!.id, name: "합성 수업 A", createdAt: at },
  { id: "course_00000000-0000-4000-8000-000000000002", professorId: professors[1]!.id, name: "합성 수업 B", createdAt: at },
] satisfies Course[];
export const workspace = {
  id: "workspace_00000000-0000-4000-8000-000000000001", slackTeamId: "TSYNTH001", createdAt: at,
} satisfies Workspace;
export const teams = courses.map((course, index) => ({
  id: `team_00000000-0000-4000-8000-00000000000${index + 1}`,
  courseId: course.id, workspaceId: workspace.id, channelId: `CSYNTH00${index + 1}`,
  name: `합성 팀 ${index + 1}`, collectionStatus: "inactive" as const,
})) satisfies Team[];
export const students = courses.map((course, index) => ({
  id: `student_00000000-0000-4000-8000-00000000000${index + 1}`,
  courseId: course.id, displayName: `합성 학생 ${index + 1}`, createdAt: at,
})) satisfies Student[];
export const members = teams.map((team, index) => ({
  teamId: team.id, studentId: students[index]!.id, courseId: team.courseId,
  workspaceId: workspace.id, slackUserId: `USYNTH00${index + 1}`,
})) satisfies TeamMember[];
export const auth = {
  request: { email: professors[0]!.email } satisfies OtpRequest,
  accepted: {
    challengeId: "challenge_00000000-0000-4000-8000-000000000001",
    expiresAt: "2026-10-26T00:05:00.000Z", resendAvailableAt: "2026-10-26T00:01:00.000Z",
  } satisfies OtpRequestResponse,
  verify: { challengeId: "challenge_00000000-0000-4000-8000-000000000001", code: "123456" } satisfies OtpVerify,
  session: { professor: professors[0]!, expiresAt: "2026-10-26T08:00:00.000Z" } satisfies SessionResponse,
  logout: { loggedOut: true as const },
};
export const team = {
  create: { courseId: courses[0]!.id, workspaceId: workspace.id, channelId: teams[0]!.channelId, name: teams[0]!.name },
  response: teams[0]!, list: { teams: [teams[0]!] },
  setMember: { workspaceId: workspace.id, slackUserId: members[0]!.slackUserId },
  member: members[0]!, members: { members: [members[0]!] },
  invite: { studentId: students[0]!.id },
  invited: { teamId: teams[0]!.id, studentId: students[0]!.id, status: "invited" as const },
  manualInvite: { teamId: teams[0]!.id, studentId: students[0]!.id, status: "manual_invite_required" as const },
  activate: {}, activated: { teamId: teams[0]!.id, collectionStatus: "active" as const, activatedAt: at },
};
export const course = {
  create: { name: courses[0]!.name }, response: courses[0]!, list: { courses: [courses[0]!] },
};
export const student = {
  create: { displayName: students[0]!.displayName }, response: students[0]!, list: { students: [students[0]!] },
};
export const consent = {
  grant: { status: "granted" as const, version: "synthetic-policy-v1" },
  decline: { status: "declined" as const, version: "synthetic-policy-v1" },
  withdraw: { status: "withdrawn" as const, version: "synthetic-policy-v1" },
  response: {
    teamId: teams[0]!.id, studentId: students[0]!.id, status: "granted", version: "synthetic-policy-v1", recordedAt: at,
  } satisfies Consent,
};
// Mock each failure by status/body; these are contracts, not running auth or gate logic.
const failure = (code: ApiErrorCode, message: string, retryable = false): { status: number; body: ApiError } => ({
  status: apiErrorStatus[code],
  body: { error: { code, message, requestId: "request_00000000-0000-4000-8000-000000000001", retryable } },
});
export const failures = {
  validation: failure("VALIDATION_ERROR", "요청 형식을 확인하세요."),
  signedOut: failure("UNAUTHENTICATED", "로그인이 필요합니다."),
  forbidden: failure("FORBIDDEN", "이 작업에 대한 권한이 없습니다."),
  otherProfessorTeam: failure("NOT_FOUND", "리소스를 찾을 수 없습니다."),
  duplicateChannel: failure("CONFLICT", "이미 지정된 팀 또는 채널입니다."),
  invalidOtp: failure("OTP_INVALID", "인증 코드가 유효하지 않습니다."),
  expiredOtp: failure("OTP_EXPIRED", "인증 코드가 만료되었습니다."),
  rateLimited: failure("RATE_LIMITED", "잠시 후 다시 시도하세요.", true),
  missingConsent: failure("CONSENT_REQUIRED", "참가자 동의 확인이 필요합니다."),
  missingMembership: failure("CHANNEL_MEMBERSHIP_REQUIRED", "채널 멤버십 확인이 필요합니다."),
  policyPending: failure("POLICY_NOT_APPROVED", "운영 정책 승인이 필요합니다."),
  emailUnavailable: failure("EMAIL_DELIVERY_UNAVAILABLE", "인증 메일을 발송하지 못했습니다.", true),
  slackUnavailable: failure("SLACK_UNAVAILABLE", "Slack 연결을 확인할 수 없습니다.", true),
  internal: failure("INTERNAL_SERVER_ERROR", "요청을 처리하지 못했습니다."),
};
failures.rateLimited.body.error.retryAfterSeconds = 60;
failures.validation.body.error.issues = [{ path: ["email"], message: "유효한 이메일을 입력하세요." }];

export const analysisRequest = { teamId: teams[0]!.id, from: at, to: "2026-10-27T00:00:00.000Z" };
export const assessment = {
  studentId: students[0]!.id, key: "clarity", judgement: "insufficient_evidence", narrative: "합성 근거가 부족하여 교수 검토가 필요합니다.",
  evidenceIds: [], counterEvidenceIds: [], confidence: "low", limitations: ["합성 fixture이며 평가 결과가 아닙니다."], requiresHumanReview: true,
} satisfies CompetencyAssessment;

export const invalid = {
  missingEmail: {}, unknownOwner: { ...team.create, professorId: professors[1]!.id },
  numericOtp: { ...auth.verify, code: 123456 }, wrongResourceId: { ...team.create, courseId: teams[0]!.id },
  badSlackId: { ...team.create, channelId: "DPRIVATE1" },
  unknownCompetency: { ...assessment, key: "productivity" }, missingReviewFlag: { ...assessment, requiresHumanReview: undefined },
  reversedPeriod: { ...analysisRequest, from: analysisRequest.to, to: analysisRequest.from },
  emptyPeriod: { ...analysisRequest, to: analysisRequest.from },
  invalidDate: { ...analysisRequest, to: "2026-02-30T00:00:00.000Z" },
  nonUtcDate: { ...analysisRequest, to: "2026-10-27T09:00:00.000+09:00" },
  forgedConsentTime: { ...consent.grant, recordedAt: at },
};
