# API Contract

이슈 #1의 개발 계약이다. Base는 동일 origin의 `/v1`, JSON 요청·응답은 `application/json`이다. 성공 응답은 아래 표의 객체를 직접 반환하고 실패만 `{error: ...}`로 감싼다. 인증은 #2에서 구현했다. Slack·동의 기능은 후속 이슈에서 구현하며 현재 미구현 경로는 404를 반환한다. `/health`는 기존 서비스 상태 응답을 유지한다.

## 공유 코드와 사용법

- `packages/contracts/src/api.ts`: 인증·소유권·팀·동의 Zod 스키마, 추론 타입, 오류 코드/HTTP 상태.
- `packages/contracts/src/validation.ts`: 기간 및 기존 평가 형태의 최소 검증. 분석 단계 상세 schema는 #16에서 확장한다.
- `packages/contracts/src/fixtures.ts`: 교수 A/B와 각 수업·팀·학생, 인증/팀/동의 성공·실패 및 무효 입력. 전부 합성 데이터이며 `.invalid` 이메일은 발송용이 아니다.
- `packages/db/src/schema.ts`, `packages/db/migrations/0002_majestic_wolf_cub.sql`: 소유권·Slack 학생 매핑과 추가 마이그레이션.

```ts
// #2 API: JSON 파싱 실패와 safeParse 실패는 VALIDATION_ERROR/400.
import { otpRequestSchema, sessionResponseSchema, apiErrorSchema } from "@teamplanet/contracts";
import { auth, failures, teams, professors } from "@teamplanet/contracts/fixtures";

const input = otpRequestSchema.safeParse({ email: "PROFESSOR-A@example.invalid" });
if (input.success) console.log(input.data.email); // 소문자로 정규화된 합성 이메일

// #4 UI mock: HTTP 202 -> auth.accepted, HTTP 200 -> auth.session.
sessionResponseSchema.parse(auth.session);
apiErrorSchema.parse(failures.expiredOtp.body);
// failures.emailUnavailable / rateLimited / signedOut도 status와 body를 함께 제공.
// 교수 A의 타 교수 팀 ID 바꿔치기: teams[1], professors[0], failures.otherProfessorTeam.
```

UI는 `response.ok`를 확인하고 성공 schema 또는 `apiErrorSchema`로 파싱한다. fixture 시각은 고정 값이므로 mock 시계를 맞추거나 복사본의 시각을 바꾼다. fixture의 만료/재전송/세션 수명은 운영 기본값이 아니다. 개발/테스트에서만 명시적으로 사용하고 production의 성공 대체 응답으로 연결하지 않는다.

외부 입력은 `unknown`에서 시작하여 공유 스키마의 `safeParse`로 검증한다. 객체는 모두 strict이므로 알 수 없는 필드를 거부한다. 경로 파라미터도 `teamParamsSchema`, `courseParamsSchema`, `teamStudentParamsSchema`로 검증한다. malformed JSON/필수 필드 누락/잘못된 ID는 400이다. schema 통과는 형식 확인이며 DB 존재·교수 소유권·실제 Slack 채널 종류·현재 동의를 보장하지 않는다.

## ID·날짜·필드 규칙

| 항목 | 규칙 |
|---|---|
| 내부 ID | `<resource>_<소문자 UUIDv4>`; resource는 `prof`, `course`, `team`, `student`, `workspace`, `challenge`, `request`, `evidence` |
| 예시 | `team_00000000-0000-4000-8000-000000000001`; 서버의 `crypto.randomUUID()`로 생성 |
| Slack ID | 내부 ID와 구분. team은 `T`, user는 `U`/`W`, 공식 공개 channel은 `C`로 시작하는 대문자 영숫자 ID(접두사 이후 8자 이상). DM ID 거부. 채널 적격성은 서버가 Slack 응답으로 추가 검증 |
| 시각 | UTC ISO 8601 밀리초 정밀도 `2026-10-26T00:00:00.000Z`; offset/날짜만/존재하지 않는 날짜 거부 |
| DB 시각 | `integer` epoch milliseconds; Drizzle `timestamp_ms`는 `Date`, API에서는 `toISOString()` |
| 분석 기간 | `[from, to)`, `from < to`; 비용에 따른 기간 상한·입력 절단 없음 |
| Slack message ts | Slack 원문 문자열 그대로 보존. JS 부동소수점 수나 API ISO 날짜로 대체하지 않음 |
| 이메일 | 유효한 이메일, 최대 254자, 소문자 정규화. 앞뒤 공백 거부. DB도 소문자·공백 제거 상태만 허용 |
| 이름 | trim 후 1–200자. 팀 이름은 Slack 채널 slug와 별개 |
| 동의서 버전 | trim 후 1–100자의 불투명 식별자. 승인된 버전인지 #5/#8에서 확인 |

기존 DB의 예전 ID와 NULL 소유권은 보존한다. 신규 API는 위 ID 규칙만 사용한다. 레거시를 공개 API에 노출하려면 별도의 검토된 ID/소유권 이관이 필요하다.

## 소유권과 Slack 학생 매핑

`professors → courses → teams`가 소유권 경로다. 수업은 교수 한 명에게 속하고 팀은 수업 한 개와 단일 파일럿 workspace에 속한다. 학생은 `students.course_id`로 수업에 속한다. 같은 사람이 여러 수업에 참여하면 별도 student ID를 사용한다. 교수 ID는 세션에서만 결정하며 생성 요청은 `professorId`를 받지 않는다.

`slack_users(workspace_id, slack_user_id)`가 Slack 계정이다. `student_slack_mappings`는 student당 한 계정을 연결하며 한 수업 안에서 같은 Slack 계정을 여러 student로 연결할 수 없다. 같은 Slack 계정이 다른 수업의 student에 연결되는 것은 가능하다. `team_members`의 복합 FK는 팀·학생의 수업과 workspace가 일치하게 한다. 표시 이름/이메일로 소유권을 추론하지 않는다. 매핑은 실제 채널 멤버십 검증 증빙을 대신하지 않는다.

단일 workspace는 상수 표현식 UNIQUE 인덱스로 강제한다. `(workspace_id, channel_id)`와 `(workspace_id, name)`도 각각 UNIQUE이므로 같은 채널의 중복 수집 대상 지정과 같은 팀 이름의 중복 등록을 막는다. 이름은 SQLite 기본의 대소문자 구분을 따르며 Slack slug 정규화는 #7에서 처리한다. 팀의 workspace 참조는 레거시 테이블 재생성을 피하기 위해 INSERT/UPDATE 및 workspace DELETE/ID UPDATE 트리거로 보호한다. 수업·학생·매핑·멤버 FK는 삭제를 cascade하지 않는다.

서버는 **쓰기 전에** 세션 교수 ID를 넣어 조인한다. 다음은 #3의 조회 형태이며 미들웨어 자체는 이번 변경에 포함하지 않는다.

```sql
SELECT t.* FROM teams t JOIN courses c ON c.id = t.course_id
WHERE t.id = :team_id AND c.professor_id = :session_professor_id;

SELECT s.* FROM students s JOIN courses c ON c.id = s.course_id
WHERE s.id = :student_id AND c.professor_id = :session_professor_id;
```

멤버/동의 변경은 팀과 학생이 같은 수업·workspace인지 및 실제 참가자인지도 확인한다. run/evidence/assessment는 팀을 통해 같은 소유권 조인을 적용한다. 기존 분석·동의 ID에는 신규 FK를 소급 적용하지 않는다. DB 제약이 세션 권한 검사나 동의 gate를 대신하지 않는다.

미인증/만료 세션은 401, 자기 소유가 아닌 리소스와 없는 리소스는 같은 404다. 403은 Origin/CSRF 등 리소스 존재 여부와 관계없는 거부에 쓴다. 목록은 세션 교수 소유 데이터만 반환한다. Slack callback/events의 state/서명 인증은 #6/#11에서 구현한다.

## 인증 계약 — #2와 #4의 시작점

| Method / Path | 요청 schema / JSON | 성공 status / 응답 schema |
|---|---|---|
| POST `/auth/otp/request` | `otpRequestSchema`: `{email}` | 202 / `otpRequestResponseSchema`: `{challengeId, expiresAt, resendAvailableAt}` |
| POST `/auth/otp/verify` | `otpVerifySchema`: `{challengeId, code}` | 200 / `sessionResponseSchema`: `{professor, expiresAt}` + 세션 쿠키 |
| GET `/auth/me` | body 없음 | 200 / `sessionResponseSchema` |
| POST `/auth/logout` | body 없음 | 200 / `logoutResponseSchema`: `{loggedOut:true}` + 쿠키 만료 |

`code`는 앞자리 0을 보존하는 6자리 문자열이다. `Professor`는 `{id, email, createdAt}`이며 세션 토큰·OTP는 응답 본문에 넣지 않는다. 세션 쿠키는 `__Host-teamplanet_session`, `HttpOnly; Secure; SameSite=Lax; Path=/`, Domain 없음이다. 로컬 HTTP 쿠키 운용은 #2에서 명시적으로 분리하며 production 플래그를 약화하지 않는다. 브라우저는 같은 origin `/v1`과 `credentials: "same-origin"`을 쓴다. 변경 요청은 서버의 Origin/CSRF 검사를 통과해야 한다. 만료·회전·서버 세션 무효화·저장소는 #2 구현 범위다. 로그아웃은 반복 호출에도 200, 로그인하지 않은 `/auth/me`는 `UNAUTHENTICATED`/401이다. 인증 응답은 `Cache-Control: no-store`다.

OTP 요청은 이메일 허용 여부를 열거할 수 없도록 동일한 성공/실패 형태·타이밍 정책을 사용한다. 메일 제공자 실패를 발송 성공으로 꾸미지 않는다. 허용 기준·제공자·만료/시도/쿨다운 수치는 #2에서 설정으로 정하며 fixture 숫자를 운영 정책으로 확정하지 않는다. 오입력/재사용/경합 실패는 `OTP_INVALID`, 만료는 `OTP_EXPIRED`, 반복 시도는 `RATE_LIMITED`, 발송 장애는 `EMAIL_DELIVERY_UNAVAILABLE`다. UI는 `resendAvailableAt`까지 기다리고 서버의 429 및 `retryAfterSeconds`/`Retry-After`를 우선한다.

#2 구현 정책(`apps/api/src/auth.ts`의 `authPolicy`):

| 항목 | 값 |
|---|---|
| 로그인 허용 | `professors` 테이블에 등록된 이메일만. 자동 가입 없음. 운영자가 D1에 직접 등록 |
| OTP | 6자리, 5분 만료, 단일 사용, challenge당 검증 5회. 5회 초과는 `RATE_LIMITED`, 새 코드 필요 |
| 발송 제한 | 이메일당 재발송 60초, 1시간 5회. 등록 여부와 무관하게 동일 적용 |
| 세션 | 8시간 고정 만료, 슬라이딩 없음. 로그인마다 새 토큰. 요청에 실린 이전 세션은 폐기 |
| 저장 | `auth_challenges`·`auth_sessions`에 OTP·토큰의 SHA-256만 저장. challenge 행은 24시간 후 삭제 |
| 열거 방지 | 미등록 이메일도 같은 202·challenge·발송 제한. 메일은 보내지 않음. OTP 요청 응답은 최소 1초 |
| Origin | `/v1/*`의 GET/HEAD/OPTIONS 외 요청은 `Origin`이 요청 URL origin과 같아야 함. 아니면 `FORBIDDEN`/403 |

등록 교수에게 메일 제공자가 실패하면 `EMAIL_DELIVERY_UNAVAILABLE`/503이고 challenge를 지운다. 이 응답은 등록 이메일에서만 나오므로 제공자 장애 중에는 등록 여부가 드러날 수 있다. 성공으로 꾸미지 않는다는 계약을 우선했다. 발송 제한은 이메일 기준이라 제3자가 특정 교수의 시간당 요청 한도를 소진시킬 수 있다.

## 수업·팀·학생 계약 — 구현은 #3/#7

| Method / Path | 요청 schema | 성공 status / 응답 schema |
|---|---|---|
| POST `/courses` | `createCourseSchema`: `{name}` | 201 / `courseSchema` |
| GET `/courses` | body 없음 | 200 / `courseListResponseSchema`: `{courses: Course[]}` |
| POST `/courses/:courseId/students` | `createStudentSchema`: `{displayName}` | 201 / `studentSchema` |
| GET `/courses/:courseId/students` | body 없음 | 200 / `studentListResponseSchema`: `{students: Student[]}` |
| POST `/teams` | `createTeamSchema`: `{courseId, workspaceId, channelId, name}` | 201 / `teamSchema` |
| GET `/teams` | body 없음 | 200 / `teamListResponseSchema`: `{teams: Team[]}` |
| GET `/teams/:teamId` | body 없음 | 200 / `teamSchema` |
| PUT `/teams/:teamId/members/:studentId` | `setTeamMemberSchema`: `{workspaceId, slackUserId}` | 200 / `teamMemberSchema` |
| GET `/teams/:teamId/members` | body 없음 | 200 / `teamMemberListResponseSchema`: `{members: TeamMember[]}` |
| POST `/teams/:teamId/invite` | `inviteTeamSchema`: `{studentId}` (한 명씩) | 200 / `inviteTeamResponseSchema`: `{teamId, studentId, status}` |

`Course`는 `{id, professorId, name, createdAt}`, `Student`는 `{id, courseId, displayName, createdAt}`, `Team`은 `{id, courseId, workspaceId, channelId, name, collectionStatus}`, `TeamMember`는 `{teamId, studentId, courseId, workspaceId, slackUserId}`다. workspace는 `{id, slackTeamId, createdAt}`다. 생성 ID/소유 교수/생성 시각/수집 상태는 서버가 결정하며 팀은 `inactive`로 시작한다. createTeam에 `active`나 교수 ID를 추가하면 400이다. `collectionStatus`는 `inactive | active | paused`며 중단/재활성화 검사는 #8에서 구현한다.

멤버 PUT은 같은 매핑의 반복 요청에 같은 결과를 반환한다. 다른 수업 학생은 404, 소유 범위 안의 중복 매핑·채널·팀은 `CONFLICT`/409다. 초대 결과는 `invited | already_member | manual_invite_required`다. 초대 불가능한 플랜/계정은 수동 초대를 안내하며 자동 초대 성공으로 취급하지 않는다. 초대/매핑 성공으로 실제 가입·동의·활성화를 간주하지 않는다. 목록은 페이지네이션 없는 소유 범위 전체 목록이며 확장은 후속 이슈에서 명시한다.

## 동의·활성화 계약 — 구현은 #8

| Method / Path | 요청 schema | 성공 status / 응답 schema |
|---|---|---|
| PUT `/teams/:teamId/consents/:studentId` | `setConsentSchema`: `{status, version}` | 200 / `consentSchema` |
| GET `/teams/:teamId/consents` | body 없음 | 200 / `consentListResponseSchema`: `{consents: Consent[]}` |
| POST `/teams/:teamId/activate` | `activateTeamSchema`: `{}` | 200 / `activateTeamResponseSchema`: `{teamId, collectionStatus:"active", activatedAt}` |

`Consent`는 `{teamId, studentId, status, version, recordedAt}`다. 상태는 `pending | granted | declined | withdrawn`이다. 외부 변경 요청은 `granted | declined | withdrawn`만 허용하며 pending으로 덮어쓸 수 없다. 기록이 없는 학생은 미동의로 취급한다. `recordedAt`은 서버 시각이며 클라이언트 주입은 400이다. 응답은 저장된 최신 상태다. 행위자/증빙 참조는 #3/#8 감사 기록에서 연결하며 본문 상태만으로 학생의 동의를 증명하지 않는다.

서버는 교수 소유권, 학생 매핑/멤버십, 승인된 동의서 버전과 증빙을 검증한다. `consents` upsert의 기존 INSERT/UPDATE 트리거가 `consent_history`를 쓴다. 철회는 DELETE가 아닌 상태 갱신이며 이력을 수정하지 않는다. 이력은 `recorded_at`, 동률이면 `id` 순서다.

활성화는 `{}`만 받으며 `consentApproved:true` 같은 우회 플래그를 거부한다. #5 운영 정책 승인, 모든 실제 참가자의 유효한 동의, bot/채널 권한과 멤버십을 서버에서 확인한다. 실패는 `POLICY_NOT_APPROVED`, `CONSENT_REQUIRED`, `CHANNEL_MEMBERSHIP_REQUIRED`/409 또는 `SLACK_UNAVAILABLE`/503이다. 비활성화·허용 구간·가입/철회 경합·상태 상세는 #8에서 확장한다. fixture의 `synthetic-policy-v1`은 승인 정책이 아니며 수집을 허용하지 않는다.

## 오류 envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "요청 형식을 확인하세요.",
    "requestId": "request_00000000-0000-4000-8000-000000000001",
    "retryable": false,
    "issues": [{"path": ["email"], "message": "유효한 이메일을 입력하세요."}]
  }
}
```

`code`, `message`, `requestId`, `retryable`은 필수, `issues`, `retryAfterSeconds`는 선택이다. `issues.path`는 필드명/배열 인덱스다. 입력값·OTP·토큰·SQL·학생 대화는 오류나 로그에 복사하지 않는다. 코드/HTTP 상태의 단일 정의는 `apiErrorStatus`다.

| HTTP | code |
|---|---|
| 400 | `VALIDATION_ERROR` |
| 401 | `UNAUTHENTICATED`, `OTP_INVALID`, `OTP_EXPIRED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT`, `CONSENT_REQUIRED`, `CHANNEL_MEMBERSHIP_REQUIRED`, `POLICY_NOT_APPROVED` |
| 429 | `RATE_LIMITED` (`Retry-After`가 있으면 `retryAfterSeconds`와 일치) |
| 503 | `EMAIL_DELIVERY_UNAVAILABLE`, `SLACK_UNAVAILABLE` |
| 500 | `INTERNAL_SERVER_ERROR` |

`retryable:true`도 무제한/자동 재시도를 의미하지 않는다. OTP 만료 시 새 코드를 요청하고 동의/권한 실패 시 필요한 상태를 해결한다. 없는 리소스와 다른 교수 리소스의 오류 메시지는 같다. API 기본 404/500도 이 envelope를 사용한다.

## 기존 DB 업그레이드

신규 migration은 평가·메시지·run·동의 테이블을 재생성하거나 수정하지 않는다. `limitations_json`, `requires_human_review`, `professor_override_json`, `consent_history` ID·기록·INSERT/UPDATE 트리거를 보존한다. 기존 팀의 `course_id`는 NULL로 남으며 소유권 조인에서 제외한다. 새 팀은 수업을 필수화하고 이미 소유권이 있는 팀의 소유권 제거도 거부한다. 기존 팀을 임의 교수에게 귀속시키거나 레거시 수집 상태만 보고 재개하지 않는다. 소유권 없는 팀은 후속 수집/분석 guard에서도 기본 거부해야 한다.

여러 workspace 또는 중복 팀/채널이 있으면 migration이 실패하며 자동 병합/삭제하지 않는다. 충돌 해결과 레거시 소유권·ID 이관은 관리자가 근거를 확인한 별도 변경으로 수행한다. production 조회/배포는 이번 검증에 포함하지 않는다. 업그레이드 전에 다음 쿼리로 충돌을 확인할 수 있다.

```sql
SELECT count(*) AS workspace_count FROM workspaces; -- 0 또는 1
SELECT workspace_id, channel_id, count(*) FROM teams GROUP BY workspace_id, channel_id HAVING count(*) > 1;
SELECT workspace_id, name, count(*) FROM teams GROUP BY workspace_id, name HAVING count(*) > 1;
```

`bun run db:generate`로 schema/snapshot을 유지하고 migration SQL의 수동 트리거도 보존한다. `drizzle-kit push`는 트리거 설치 경로가 아니다. 로컬 D1 및 합성 업그레이드 검증은 `packages/db/README.md`를 참고한다.

## 후속 계약과 미결 결정

비동기 작업은 `packages/contracts/src/jobs.ts`의 version 1 `QueueEnvelope`와 event/run:stage:chunk 멱등 key를 사용한다. 원문·토큰 대신 저장소 참조만 전달한다. 실제 handler 등록 전 작업은 성공으로 처리하지 않는다. 공개 HTTP 큐 발행/복구 엔드포인트는 추가하지 않으며 내부 producer와 운영자 도구를 사용한다. 재시도·DLQ·체크포인트 계약은 `QUEUE_OPERATIONS.md`를 참고한다.

Slack 설치/OAuth/연결/이벤트 상세는 #6/#11에서 정의한다: GET `/slack/install`, `/slack/oauth/callback`, `/slack/connection`, POST `/slack/events`.

분석은 POST `/analysis-runs` (`analysisRunRequestSchema`: `{teamId,from,to}`), GET `/analysis-runs/:id`, `/analysis-runs/:id/assessments`, POST `/analysis-runs/:id/finalize`를 유지한다. 상태는 `queued → collecting → evidence_extraction → assessment → review → awaiting_professor → finalized`, 오류 상태는 `blocked_provider_billing`, `failed_provider_auth`, `rate_limited`, `failed_model`, `failed_data`, `cancelled`다. `CompetencyAssessment`의 근거·반례·limitations·requiresHumanReview를 보존한다.

#15 공통 `rubricSelectionSchema`는 `{rubricVersion:"communication-v1",selectedCompetencies:["clarity"]}` 형태로 1~4개의 중복 없는 key를 검증한다. #3은 교수 소유 수업 설정 API/Drizzle schema/신규 migration에 이 구성을 포함하고 #9는 초기 선택 UI를 구현한다. 현재 createCourse schema에는 아직 이 필드가 없으므로 해당 후속 변경 전 전송하면 거부된다. #16은 클라이언트 임의 선택 대신 서버의 수업 설정을 run에 스냅샷한다. `assessmentSetSchema`로 학생×선택 key 전체를 검사하고 #17~#20은 원문/행위자/동의/최신성까지 검증한다. 미선택 항목을 생성하거나 빈 결과로 누락시키지 않는다.

공급자 402는 기존 `ProviderBillingError` 계약을 유지한다. 인증·팀·동의 오류와 별도이며 `apiErrorSchema`로 파싱하지 않는다.

```json
{"error":{"code":"OPENROUTER_BILLING_BLOCKED","kind":"insufficient_credits","source":"openrouter_credits","providerStatus":402,"retryable":false}}
```

`kind`는 `insufficient_credits | key_limit_exhausted | in_flight_budget | unspecified_provider_billing`이다. provider가 명시적 지연을 제공한 in-flight budget만 일시적 재시도가 가능하다. 일반 잔액 부족 402 자동 재시도·앱 비용 상한·모델 자동 폴백을 추가하지 않는다. #5 서비스 정책은 아래 인수인계를 따르며 루브릭·모델/전송 결정은 ADR-0003을 따르며 실제 외부 전송 고지와 Slack scope(#6)는 시작 전 확인 대상이다.

## #5 파일럿 정책 인수인계 — 후속 API 확장

[운영 정책](PRIVACY_AND_DATA.md)과 [ADR-0002](ADR/0002-pilot-policy.md)를 기준으로 #8/#9에서 교수의 오프라인 동의 확인+학생 QR 재확인·증빙 참조·계정/수업/버전 연결을 확장한다. 공개 QR/체크박스만으로 임의 학생의 동의를 쓰지 못하게 한다. 전원 사전 동의·고정 참가자 파일럿을 전제로 대체 평가/개정 전용 UI는 제외하되 서버 gate는 유지한다. 이 문서는 새 엔드포인트/공유 타입이 구현됐다는 뜻이 아니다.

수업에는 실제 종료일·교수 연락처를, 문의에는 교수 설정 답변/보관 기한 n일과 접수별 만료 시각을 정의해야 한다. 문의는 접수+n일에 답변 여부와 무관하게 자동 삭제하며 설정 변경으로 기존 기한을 암묵적으로 바꾸지 않는다. 요약·리포트·근거/관련 이력은 수업 종료 후 3개월에 삭제한다. 구체 필드·공유 schema·런타임 검증·migration은 해당 구현 PR에서 함께 제공한다.

#11/#12/#13/#16은 Slack 원문을 장기 저장하지 않고 참조·revision/지문·요약을 보관한다. 기존 messages.text와 평가 schema를 이번 문서 PR에서 삭제하지 않는다. 원문 재검증 실패/불일치와 실제 삭제를 구분하며, 근거 링크 제외 및 교수 확정본 무효화·재검토 상태를 #14/#22/#23에서 표현한다. 열람·확정·출력은 최신 원문 검증을 거쳐야 하고, 학생 페이지는 본인 동의/문의에 한정한다. 학생 피드백은 교수가 검증된 리포트를 출력해 전달한다.
