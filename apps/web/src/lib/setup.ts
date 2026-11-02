import {
  apiErrorSchema, courseIdSchema, teamIdSchema, slackInstallOutcomeSchema,
  slackConnectionSchema, courseListResponseSchema, teamListResponseSchema,
  studentListResponseSchema, teamMemberListResponseSchema, consentListResponseSchema,
  coursePilotResponseSchema, teamMembershipSchema, collectionStatusResponseSchema, courseRubricResponseSchema,
  type SlackConnection, type Course, type Team, type Student, type TeamMember,
  type Consent, type CoursePilotResponse, type TeamMembership, type CollectionStatusResponse, type CourseRubricResponse,
} from "@teamplanet/contracts";

export type Schema<T> = { safeParse(data: unknown): { success: true; data: T } | { success: false } };
export function setupLocation(search: string) {
  const params = new URLSearchParams(search);
  const course = courseIdSchema.safeParse(params.get("course"));
  const team = teamIdSchema.safeParse(params.get("team"));
  const outcome = slackInstallOutcomeSchema.safeParse(params.get("slack"));
  const safe = new URLSearchParams();
  if (course.success) safe.set("course", course.data);
  if (team.success) safe.set("team", team.data);
  if (outcome.success) safe.set("slack", outcome.data);
  return { courseId: course.success ? course.data : "", teamId: team.success ? team.data : "",
    outcome: outcome.success ? outcome.data : null, search: safe.size ? `?${safe}` : "" };
}

export const oauthMessages = {
  installed: "Slack 설치 응답을 받았습니다. 아래에서 실제 연결 상태를 확인하세요.",
  reinstalled: "Slack 재설치 응답을 받았습니다. 아래에서 권한과 연결 상태를 확인하세요.",
  cancelled: "Slack 연결을 취소했습니다. 준비되면 다시 연결하세요.",
  insufficient_scope: "Slack 권한이 부족합니다. 필요한 권한을 허용해 다시 설치하세요.",
  invalid_state: "연결 요청이 만료되었거나 확인되지 않았습니다. 연결을 다시 시작하세요.",
  workspace_mismatch: "다른 Slack 워크스페이스가 이미 연결돼 있습니다. 운영자에게 확인하세요.",
  failed: "Slack 연결을 완료하지 못했습니다. 연결 상태를 확인하고 다시 시도하세요.",
} as const;

export type SetupState = {
  busy: boolean; error: string; notice: string; retryAt: number;
  connection: SlackConnection | null; courses: Course[]; teams: Team[];
  courseId: string; teamId: string; students: Student[]; members: TeamMember[];
  consents: Consent[]; pilot: CoursePilotResponse | null;
  rubric: CourseRubricResponse | null;
  membership: TeamMembership | null; collection: CollectionStatusResponse | null;
};
const detail = { students: [] as Student[], members: [] as TeamMember[], consents: [] as Consent[],
  pilot: null, membership: null, collection: null, rubric: null };
const errorMessages: Record<string, string> = {
  UNAUTHENTICATED: "세션이 만료되었습니다. 다시 로그인해 주세요.",
  FORBIDDEN: "요청을 허용할 수 없습니다. 페이지를 새로고침하고 다시 시도하세요.",
  NOT_FOUND: "설정 기능이 준비되지 않았거나 접근할 수 없는 수업·팀입니다. 다시 조회하세요.",
  VALIDATION_ERROR: "입력 형식을 확인하세요. 수업 종료일은 미래 시각이어야 합니다.",
  CONFLICT: "이미 등록된 이름·채널·매핑입니다. 기존 항목을 다시 조회하세요.",
  RATE_LIMITED: "요청이 많습니다. 대기 시간이 지난 뒤 다시 시도하세요.",
  POLICY_NOT_APPROVED: "운영자가 승인한 동의서 버전과 수업 종료일을 확인하세요.",
  CONSENT_REQUIRED: "참가자 전원의 오프라인 동의와 학생 재확인을 확인하세요.",
  CHANNEL_MEMBERSHIP_REQUIRED: "봇·학생의 공식 채널 참여와 미매핑 참가자를 확인하세요.",
  SLACK_UNAVAILABLE: "Slack 상태를 확인하지 못했습니다. 연결과 권한을 확인한 후 다시 조회하세요.",
};
export class SetupFailure extends Error {
  constructor(readonly code: string, readonly retryAt = 0) {
    super(errorMessages[code] ?? "설정 상태를 확인하지 못했습니다. 다시 조회하세요.");
  }
}

export class SetupController {
  private state: SetupState;
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private revision = 0;
  constructor(private signedOut: () => void, private fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = fetch,
    selection = { courseId: "", teamId: "" }, private clock = Date.now) {
    this.state = { busy: false, error: "", notice: "", retryAt: 0, connection: null, courses: [], teams: [], ...selection, ...detail };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<SetupState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  dispose() { this.revision++; this.abort?.abort(); }

  private async request<T>(path: string, schema: Schema<T>, signal: AbortSignal, method = "GET", body?: unknown): Promise<T> {
    const fetcher = this.fetcher;
    const response = await fetcher(`/v1/${path}`, { method, signal, credentials: "same-origin", cache: "no-store",
      headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = apiErrorSchema.safeParse(data);
      const retry = response.headers.get("Retry-After");
      const headerAt = retry && /^\d+$/.test(retry) ? this.clock() + Number(retry) * 1000 : Date.parse(retry ?? "") || 0;
      throw new SetupFailure(parsed.success ? parsed.data.error.code : response.status === 401 ? "UNAUTHENTICATED" : "UNAVAILABLE",
        Math.max(headerAt, this.clock() + (parsed.success ? parsed.data.error.retryAfterSeconds ?? 0 : 0) * 1000));
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new SetupFailure("INVALID_RESPONSE");
    return parsed.data;
  }

  private async read(signal: AbortSignal): Promise<Partial<SetupState>> {
    const [connection, courseList, teamList] = await Promise.all([
      this.request("slack/connection", slackConnectionSchema, signal),
      this.request("courses", courseListResponseSchema, signal), this.request("teams", teamListResponseSchema, signal),
    ]);
    const courseId = courseList.courses.some(c => c.id === this.state.courseId) ? this.state.courseId : courseList.courses[0]?.id ?? "";
    const teams = teamList.teams.filter(t => t.courseId === courseId);
    const teamId = teams.some(t => t.id === this.state.teamId) ? this.state.teamId : teams[0]?.id ?? "";
    const common = { ...detail, connection, courses: courseList.courses, teams, courseId, teamId };
    if (!courseId) return common;
    const [students, pilot, rubric] = await Promise.all([
      this.request(`courses/${courseId}/students`, studentListResponseSchema, signal),
      this.request(`courses/${courseId}/pilot`, coursePilotResponseSchema, signal),
      this.request(`courses/${courseId}/rubric`, courseRubricResponseSchema, signal),
    ]);
    if (pilot.courseId !== courseId || rubric.courseId !== courseId || students.students.some(s => s.courseId !== courseId)) throw new SetupFailure("INVALID_RESPONSE");
    if (!teamId) return { ...common, students: students.students, pilot, rubric };
    const [members, consents, membership, collection] = await Promise.all([
      this.request(`teams/${teamId}/members`, teamMemberListResponseSchema, signal),
      this.request(`teams/${teamId}/consents`, consentListResponseSchema, signal),
      this.request(`teams/${teamId}/membership`, teamMembershipSchema, signal),
      this.request(`teams/${teamId}/collection`, collectionStatusResponseSchema, signal),
    ]);
    // A schema-valid response for a different resource must never enable this team's controls.
    if (pilot.courseId !== courseId || membership.teamId !== teamId || collection.teamId !== teamId
      || students.students.some(s => s.courseId !== courseId)
      || members.members.some(m => m.teamId !== teamId || m.courseId !== courseId)
      || consents.consents.some(c => c.teamId !== teamId)) throw new SetupFailure("INVALID_RESPONSE");
    return { ...common, students: students.students, pilot, rubric, members: members.members, consents: consents.consents, membership, collection };
  }

  private async perform(action?: (signal: AbortSignal) => Promise<string>) {
    if (this.state.busy || this.clock() < this.state.retryAt) return;
    this.dispose();
    const revision = this.revision;
    const controller = this.abort = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    this.update({ busy: true, error: "", notice: "", ...detail });
    try {
      const notice = action ? await action(controller.signal) : "";
      if (revision !== this.revision) return;
      const loaded = await this.read(controller.signal);
      if (revision === this.revision) this.update({ ...loaded, busy: false, notice });
    } catch (error) {
      if (revision !== this.revision) return;
      const failure = error instanceof SetupFailure ? error : new SetupFailure("UNAVAILABLE");
      this.update({ ...detail, busy: false, error: failure.message, retryAt: failure.retryAt });
      if (failure.code === "UNAUTHENTICATED") {
        this.update({ connection: null, courses: [], teams: [] }); this.signedOut();
      }
    } finally { clearTimeout(timeout); }
  }
  refresh = () => this.perform();
  select(courseId: string, teamId = "") {
    if (this.state.busy || this.clock() < this.state.retryAt) return;
    this.update({ courseId, teamId, ...detail });
    return this.refresh();
  }
  mutate<T>(path: string, response: Schema<T>, body: unknown, method = "POST", notice: string | ((value: T) => string) = "저장했습니다. 최신 서버 상태를 확인하세요.") {
    return this.perform(async signal => { const result = await this.request(path, response, signal, method, body); return typeof notice === "function" ? notice(result) : notice; });
  }
}

export function activationReasons(state: SetupState, now = Date.now()) {
  const reasons: string[] = [];
  if (state.busy || state.error || !state.collection) reasons.push("최신 설정 상태를 다시 조회하세요.");
  if (state.connection?.status !== "connected") reasons.push("Slack 연결과 권한을 확인하세요.");
  if (!state.pilot?.policyApproved || !state.pilot.endsAt || Date.parse(state.pilot.endsAt) <= now) reasons.push("승인된 동의서와 미래의 수업 종료일이 필요합니다.");
  if (!state.membership?.complete) reasons.push("봇·학생 참여 또는 미매핑 계정을 확인하세요.");
  if (!state.members.length || state.members.some(m => !state.consents.some(c => c.studentId === m.studentId
    && c.status === "granted" && c.version === state.pilot?.consentVersion && c.studentConfirmedAt))) reasons.push("참가자 전원의 오프라인 동의와 학생 재확인이 필요합니다.");
  return reasons;
}
