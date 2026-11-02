import { useEffect, useState, useSyncExternalStore, type SubmitEvent } from "react";
import {
  courseSchema, createCourseSchema, createStudentSchema, studentSchema, createTeamSchema, teamSchema,
  coursePilotSchema, coursePilotResponseSchema, setTeamMemberSchema, teamMemberSchema,
  setConsentSchema, consentSchema, inviteTeamResponseSchema, activateTeamResponseSchema,
  collectionStatusResponseSchema, competencyLabels, competencyKeys, rubricSelectionSchema, courseRubricResponseSchema,
} from "@teamplanet/contracts";
import { SetupController, setupLocation, activationReasons, oauthMessages, type Schema } from "../lib/setup";

const competencyDescriptions = {
  clarity: "목표·요청·제약을 상대가 이해하도록 전달하는지 살펴봅니다.",
  information_sharing: "필요한 정보를 공유하고 다른 팀원의 협업을 돕는지 살펴봅니다.",
  feedback_alignment: "피드백을 이해하고 의견 차이를 조율하는지 살펴봅니다.",
  decision_execution: "논의를 결정과 후속 실행으로 연결하는지 살펴봅니다.",
};

// Forms are ephemeral. Authoritative progress is reloaded from the API on every visit.
function SetupForm<T>({ title, fields, schema, submit, disabled }: {
  title: string; fields: { name: string; label: string; type?: string; optional?: boolean }[];
  schema: Schema<T>; submit(data: T): Promise<unknown>; disabled: boolean;
}) {
  const [error, setError] = useState("");
  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    for (const field of fields) if (field.optional && !values[field.name]) delete values[field.name];
    const parsed = schema.safeParse(values);
    if (!parsed.success) { setError("입력 형식을 확인하세요. 날짜는 UTC 시각(예: 2027-02-28T09:00:00.000Z)을 입력하세요."); return; }
    setError(""); void submit(parsed.data);
  };
  return <form className="setup-form" onSubmit={onSubmit} aria-label={title}>
    <fieldset disabled={disabled}><legend>{title}</legend>
      {fields.map(field => <label key={field.name}>{field.label}<input name={field.name} type={field.type ?? "text"} required={!field.optional} maxLength={254} /></label>)}
      <button className="button secondary" type="submit">{title}</button>
    </fieldset>{error && <p role="alert" className="form-error">{error}</p>}
  </form>;
}

export default function SetupWizard({ onSignedOut }: { onSignedOut: () => void }) {
  const [location] = useState(() => setupLocation(window.location.search));
  const [controller] = useState(() => new SetupController(onSignedOut, fetch, location));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<string[]>([]);
  const [selectionMessage, setSelectionMessage] = useState("");
  useEffect(() => {
    setSelected(state.rubric?.selection?.selectedCompetencies ?? []);
  }, [state.rubric]);
  useEffect(() => {
    void controller.refresh();
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); controller.dispose(); };
  }, [controller]);
  useEffect(() => {
    const params = new URLSearchParams();
    if (state.courseId) params.set("course", state.courseId);
    if (state.teamId) params.set("team", state.teamId);
    if (location.outcome) params.set("slack", location.outcome);
    window.history.replaceState(null, "", `/workspace${params.size ? `?${params}` : ""}`);
    setSelectionMessage("");
  }, [state.courseId, state.teamId, location.outcome]);
  const waiting = Math.max(0, Math.ceil((state.retryAt - now) / 1000));
  const disabled = state.busy || waiting > 0;
  const reasons = activationReasons(state, now);
  const team = state.teams.find(t => t.id === state.teamId);
  const stateLabel = { active: "수집 중", inactive: "수집 비활성", paused: "수집 중지" };
  const consentLabel = { pending: "미동의", granted: "오프라인 동의 확보", declined: "동의 거절", withdrawn: "동의 철회" };
  const connectionLabel = { not_connected: "미연결", connected: "연결됨", insufficient_scope: "권한 부족", revoked: "연결 철회" };
  return <div className="setup-wizard" aria-label="수업 설정 마법사">
    {location.outcome && <p className="form-notice" role="status">{oauthMessages[location.outcome]}</p>}
    <p className="setup-policy">성인 내부 파일럿의 동의된 공식 공개 채널만 수집합니다. DM·사적 채널은 제외합니다. 실제 표시명·동의된 프로젝트 이미지 원본은 Qwen/DeepInfra ZDR로 실행 중 전송되며, 원문·이미지를 서비스에 영구 복제하지 않습니다. 교수의 최종 검토를 유지하고 요약·리포트는 수업 종료 후 3개월에 삭제합니다.</p>
    <nav className="setup-toolbar" aria-label="설정 단계"><a href="#slack-setup-title">Slack 연결</a><a href="#course-setup-title">수업·채널</a>{state.courseId && <><a href="#rubric-title">분석 역량</a><a href="#participants-title">참가자·동의</a></>}{team && <a href="#activate-title">수집 상태</a>}</nav>
    <div className="setup-toolbar"><button className="button secondary" disabled={disabled} onClick={() => void controller.refresh()}>{state.busy ? "서버 상태 확인 중…" : waiting ? `${waiting}초 후 다시 조회` : "최신 상태 다시 조회"}</button><span role="status">{state.busy ? "변경을 처리하고 최신 상태를 확인하고 있습니다." : state.notice}</span></div>
    {state.error && <p role="alert" className="form-error">{state.error} 변경 요청 중 오류가 났다면 다시 조회해 저장 여부를 확인하세요.</p>}

    <section className="setup-section" aria-labelledby="slack-setup-title"><h2 id="slack-setup-title">1. Slack 워크스페이스 연결</h2>
      <p>담당자가 준비한 파일럿 워크스페이스에 앱을 설치하세요. 이 단계에서는 대화를 수집하지 않습니다.</p>
      <p>{state.connection ? `${connectionLabel[state.connection.status]} · ${state.connection.workspace?.name ?? "연결된 워크스페이스 없음"}` : "연결 상태 미확인"}</p>
      {!!state.connection?.missingScopes.length && <p className="form-error">필요한 권한: {state.connection.missingScopes.join(", ")}</p>}
      <a className="button primary" href="/v1/slack/install">Slack 연결·권한 다시 설정</a>
    </section>

    <section className="setup-section" aria-labelledby="course-setup-title"><h2 id="course-setup-title">2. 수업과 공식 채널</h2>
      <label>설정할 수업<select disabled={disabled || !state.courses.length} value={state.courseId} onChange={e => void controller.select(e.target.value)}><option value="">수업 선택</option>{state.courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      {!state.busy && !state.error && !state.courses.length && <p>등록된 수업이 없습니다. 수업을 먼저 만드세요.</p>}
      <SetupForm title="수업 만들기" fields={[{ name: "name", label: "수업 이름" }]} schema={createCourseSchema} disabled={disabled}
        submit={data => controller.mutate("courses", courseSchema, data)} />
      {state.courseId && <>
        <p>운영자가 승인한 고정 동의서 버전을 입력하세요. 전송 고지와 오프라인 서류의 버전이 같아야 합니다.</p>
        <p>현재 동의서: {state.pilot?.consentVersion ?? "미설정"} · 종료일: {state.pilot?.endsAt ?? "미설정"} · {state.pilot?.policyApproved ? "운영자 승인 버전" : "정책 미확인"}</p>
        <SetupForm key={`pilot-${state.courseId}`} title="동의서·종료일 저장" fields={[{ name: "consentVersion", label: "승인된 동의서 버전" }, { name: "endsAt", label: "실제 수업 종료 시각 (UTC ISO 형식)" }]} schema={coursePilotSchema} disabled={disabled}
          submit={data => controller.mutate(`courses/${state.courseId}/pilot`, coursePilotResponseSchema, data, "PUT")} />
        <p>수업 시작일·담당 교수 이메일·문의 기한 설정 기능은 준비 중입니다. 운영자에게 확인해 주세요.</p>
        <label>공식 채널 팀<select disabled={disabled || !state.teams.length} value={state.teamId} onChange={e => void controller.select(state.courseId, e.target.value)}><option value="">팀 선택</option>{state.teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        {!state.busy && !state.teams.length && <p>이 수업에 등록된 팀이 없습니다.</p>}
        <SetupForm key={`team-${state.courseId}`} title="팀·공식 채널 등록" fields={[{ name: "name", label: "팀 이름" }, { name: "channelId", label: "기존 공개 채널 ID (비우면 새 채널 생성)", optional: true }]}
          schema={{ safeParse: data => createTeamSchema.safeParse({ ...(data as object), courseId: state.courseId, workspaceId: state.connection?.workspace?.id }) }} disabled={disabled || state.connection?.status !== "connected"}
          submit={data => controller.mutate("teams", teamSchema, data)} />
      </>}
    </section>

    {state.courseId && <section className="setup-section" aria-labelledby="rubric-title"><h2 id="rubric-title">3. 분석 역량 선택</h2>
      <p>communication-v1에서 1~4개를 직접 선택하고 저장하세요. 저장한 범위는 새 분석에 사용할 설정이며 과거 결과를 변경하지 않습니다. 분석 실행 기능은 준비 중입니다.</p>
      <p>서버에 저장된 역량: {state.rubric?.selection ? state.rubric.selection.selectedCompetencies.map(key => competencyLabels[key]).join(", ") : "미설정"}</p>
      <fieldset disabled={disabled}><legend>분석에 사용할 역량</legend>{competencyKeys.map(key => <label className="check-label" key={key}><input type="checkbox" checked={selected.includes(key)} onChange={e => setSelected(current => e.target.checked ? [...current, key] : current.filter(k => k !== key))} /><span>{competencyLabels[key]}<small>{competencyDescriptions[key]}</small></span></label>)}</fieldset>
      <button className="button secondary" disabled={disabled} onClick={() => {
        const parsed = rubricSelectionSchema.safeParse({ rubricVersion: "communication-v1", selectedCompetencies: selected });
        if (!parsed.success) { setSelectionMessage("역량을 1개 이상 직접 선택하세요."); return; }
        setSelectionMessage("");
        void controller.mutate(`courses/${state.courseId}/rubric`, courseRubricResponseSchema, parsed.data, "PUT", "분석 역량을 저장했습니다.");
      }}>분석 역량 저장</button>
      <p role="status">{selectionMessage}</p>
    </section>}

    {state.courseId && <section className="setup-section" aria-labelledby="participants-title"><h2 id="participants-title">4. 참가자·동의 확인</h2>
      <p>교수가 학생 본인과 종이 서류를 확인한 뒤 증빙 참조만 기록하세요. 스캔 파일·학생 대화·개인정보를 참조에 넣지 마세요. QR 학생 화면은 별도 구현 중입니다.</p>
      <SetupForm title="학생 등록" fields={[{ name: "displayName", label: "학생 표시명" }]} schema={createStudentSchema} disabled={disabled} submit={data => controller.mutate(`courses/${state.courseId}/students`, studentSchema, data)} />
      {!state.busy && !state.students.length && <p>등록된 학생이 없습니다.</p>}
      {team && state.students.map(student => {
        const member = state.members.find(m => m.studentId === student.id);
        const consent = state.consents.find(c => c.studentId === student.id);
        return <article className="setup-student" key={`${team.id}-${student.id}`}><h3>{student.displayName}</h3>
          <p>{member ? `Slack 매핑: ${member.slackUserId}` : "Slack 계정 미매핑"} · {consent ? consentLabel[consent.status] : "미동의"} · {consent?.studentConfirmedAt ? "학생 재확인 기록 있음" : "학생 재확인 필요"}</p>
          <SetupForm title="Slack 계정 매핑" fields={[{ name: "slackUserId", label: `${student.displayName}의 Slack 사용자 ID` }]} schema={{ safeParse: data => setTeamMemberSchema.safeParse({ ...(data as object), workspaceId: state.connection?.workspace?.id }) }} disabled={disabled}
            submit={data => controller.mutate(`teams/${team.id}/members/${student.id}`, teamMemberSchema, data, "PUT")} />
          <button className="button secondary" disabled={disabled || !member} onClick={() => void controller.mutate(`teams/${team.id}/invite`, inviteTeamResponseSchema, { studentId: student.id }, "POST", result => result.status === "manual_invite_required" ? "자동 초대가 불가능합니다. Slack 관리자가 해당 학생을 직접 초대하고 참여 상태를 다시 조회하세요." : result.status === "already_member" ? "이미 채널에 참여한 학생입니다." : "초대 요청이 성공했습니다. 실제 채널 참여 여부를 다시 확인하세요.")}>공식 채널 초대</button>
          <SetupForm title="오프라인 동의 확보 기록" fields={[{ name: "evidenceRef", label: `${student.displayName}의 동의서 증빙 참조` }]} schema={{ safeParse: data => setConsentSchema.safeParse({ ...(data as object), status: "granted", version: state.pilot?.consentVersion }) }} disabled={disabled || !member || !state.pilot?.policyApproved}
            submit={data => controller.mutate(`teams/${team.id}/consents/${student.id}`, consentSchema, data, "PUT")} />
          <p>학생 재확인이 없으면 수집할 수 없습니다. 학생 본인 확인·QR 화면을 준비 중이므로 동의서 확보만으로 재확인이 완료되지 않습니다.</p>
        </article>;
      })}
    </section>}

    {team && <section className="setup-section" aria-labelledby="activate-title"><h2 id="activate-title">5. 수집 상태와 활성화</h2>
      <p role="status">{state.collection ? stateLabel[state.collection.collectionStatus] : "수집 상태 미확인"} · {state.rubric?.selection ? "분석 역량 설정됨 · 분석 실행 준비 중" : "분석 역량 미설정"}</p>
      <p>공식 채널: {team.channelId} · 봇 참여: {state.membership ? state.membership.botInChannel ? "확인" : "미참여" : "미확인"}</p>
      {state.membership && <><p>미매핑 채널 계정: {state.membership.unmappedChannelMembers.length}명 · 미참여 학생: {state.membership.members.filter(m => !m.inChannel).length}명</p><p>멤버십 검증 시각: {state.membership.checkedAt}</p></>}
      {reasons.length > 0 && <ul>{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
      <button className="button primary" disabled={disabled || reasons.length > 0 || state.collection?.collectionStatus === "active"} onClick={() => void controller.mutate(`teams/${team.id}/activate`, activateTeamResponseSchema, {}, "POST", "활성화 요청이 성공했습니다. 최신 수집 상태를 확인하세요.")}>수집 활성화 요청</button>
      <button className="button secondary" disabled={disabled || state.collection?.collectionStatus === "inactive" || state.collection?.collectionStatus === "paused"} onClick={() => void controller.mutate(`teams/${team.id}/deactivate`, collectionStatusResponseSchema, {}, "POST", "수집 중지를 요청했습니다.")}>수집 중지</button>
      <p>미동의·철회·새 참가자·정책 변경·봇 권한 상실은 운영자와 확인하세요. 동의 전 구간은 수집하거나 백필하지 않습니다.</p>
    </section>}
  </div>;
}
