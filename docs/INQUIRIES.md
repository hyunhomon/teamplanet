# 학생 웹 문의 (#30)

학생 페이지 `/inquiries#<본인 QR token>`은 오프라인 동의 재확인 완료 화면에서 연결된다. 개인 fragment는 서버 URL/Referer/교수 쿠키에 넣지 않으며 학생 요청은 credentials omit/no-store다. 학생 ID·수업 ID를 입력해 타인 문의에 접근할 수 없다. 교수는 워크스페이스에서 선택한 자기 수업의 n일·문의·답변·별도 철회/정정 처리를 관리한다. 실제 이메일 발송이나 첨부/평가 열람 포털은 제공하지 않는다.

## 기간과 본인 경계

`inquiry_settings.days`는 교수가 명시 설정한 양의 정수이며 기본값이 없다. 미설정은 담당 교수 이메일만 안내하고 제출을 막는다. Date 표현 범위를 벗어난 일수는 400이다. 하루는 정확히 24시간이며 접수 시각은 서버 UTC다. 각 문의의 receivedAt·days·expiresAt을 고정한다. 답변/설정 변경은 이를 바꾸지 않는다. 제출 전 예상 종료일/교수 이메일/적용 n을 표시하고 성공 receipt에 정확한 종료일을 표시한다.

확인 완료된 개인 QR은 **문의 본인 증명에만** 사용한다. 철회 뒤에도 본인 문의와 답변을 확인할 수 있으며 수집 동의를 부여하지 않는다. 새 접수는 삭제 차단/수업 보관 만료 이후 막힌다. 문의 n일이 수업의 달력 3개월보다 길면 기존 문의는 독립 만료일까지 본인 capability로 확인할 수 있다. 마지막 문의 만료 이후에는 그 문의에서 본인 권한을 복원하지 않는다.

lookup은 10분짜리 일회성 접수 ticket을 발급한다(이 10분은 문의 보관 n의 기본값이 아닌 제출 보안 수명이다). ticket은 hash만 저장하고 한 문의 ID에 원자적으로 연결한다. 같은 ticket 재전달은 같은 접수 결과다. 설정이 바뀐 미사용 ticket은 409로 다시 안내한다. 오래된 ticket 삭제 후 동일 요청은 새 문의를 만들 수 없다. 새 문의는 최신 안내와 새 ticket으로 접수한다.

## API와 오류

공유 런타임 계약: `packages/contracts/src/inquiries.ts`. 기존 `{error:{code,message,requestId,retryable}}`를 사용한다. 잘못된 입력 400, 교수 세션 누락 401, 타인/없는/만료 문의 404, 안내 변경/만료·처리 충돌 409다. 내부 오류/삭제 실패는 본문/학생 토큰을 노출하지 않는다.

| /v1 경로 | 권한과 입력 |
|---|---|
| GET/PUT `/courses/:courseId/inquiry-settings` | 소유 교수; PUT `{days:n}` |
| GET `/courses/:courseId/inquiries` | 소유 교수; 만료 전 문의만 |
| POST `/student-inquiries/lookup` | `{token}`; 이메일/설정/예상 만료/ticket/본인 목록 |
| POST `/student-inquiries` | `{token,ticket,body}`; 201 접수 |
| POST `/student-inquiries/:id` | `{token}`; 본인 만료 전 문의만 |
| PUT `/inquiries/:id/answer` | 소유 교수 `{answer}`; 원래 만료 불변 |
| POST `/inquiries/:id/action` | 소유 교수 `{kind:"withdrawal"|"correction"}` |

철회/정정 접수만으로 상태를 자동 변경하지 않는다. 교수가 본인 요청을 확인해 action을 실행하면 실제 동의 철회(기존 append-only trigger/수집 중단) 또는 결과 무효화와 `inquiry_effects`의 본문 없는 처리 기록/교수 감사가 같은 트랜잭션에 기록된다. 반복 action은 멱등적이다. 문의 만료는 이 처리를 되돌리지 않는다. 별도 기록은 수업 종료 후 달력 3개월에 #14 경로와 cron으로 정리한다.

## 자동 삭제·확인

매분 Consumer cron의 `sweepInquiries`가 문의/답변과 연결된 ticket을 같은 트랜잭션에서 삭제한다. 답변 여부와 무관하며 경계 `expiresAt <= now`부터 모든 조회/답변/처리 경로와 UI에서 제외한다. 물리 정리가 지연되거나 실패해도 접근은 차단된다. 실패는 `INQUIRY_CLEANUP_FAILED`, 성공 시 lastCleanupAt·오류 해제로 교수 설정 API/UI에서 확인하며 다음 cron이 멱등 재시도한다. 외부 이메일함 삭제는 범위 밖이다. 본문을 별도 로그/감사/Queue에 복사하지 않는다.

신규 Drizzle schema/migration 0014는 기존 평가·동의 이력 테이블/trigger를 변경하지 않는다. 합성 회귀는 `tests/inquiries.test.ts`: 학생/교수 바꿔치기, 미설정/무효 n, 동시 접수, 만료 경계, 설정 변경, 동시 답변/삭제, 실패 rollback/retry, 철회 보존, UI 클라이언트 자격 증명. 실제 학생/메일/Slack 조작은 실행하지 않았다. 실제 브라우저 전체 동선은 #24의 E2E에도 연결한다.
