# 교수 팀 분석 대시보드 (#21)

로그인 후 **팀 분석** 메뉴(`/workspace?view=analysis`)에서 교수 소유 팀의 수업/채널·신규 수집 상태·현재 동의/매핑 수·선택 역량을 확인한다. 한국 시각(Asia/Seoul, UTC+09:00)으로 시작/종료를 명시 입력하고 서버 프리뷰를 확인한 뒤 직접 실행한다. 기간은 `[from,to)`이며 HTTP 요청은 밀리초 UTC ISO다. 컴퓨터의 로컬 timezone에 기대지 않고 실제 달력 날짜를 검사한다. 설정 화면은 `/workspace`에서 유지한다.

## 보호 API와 실행 조건

- `GET /v1/analysis-dashboard`: 세션 교수의 팀만 반환한다. 수업 기간·rubric 선택·전원 재확인 수·매핑 전 참가자 수를 포함하며 학생 이름/대화는 반환하지 않는다.
- `POST /v1/analysis-preview`: `{teamId,from,to,timezone}`. run을 만들거나 수집·모델 호출을 수행하지 않는다. 서버 수업 설정과 processing gate, 포함하는 단일 complete coverage, 기간의 삭제되지 않은 메시지 참조를 확인한다. 실행 API도 같은 `analysisEligibility`를 사용한다.
- `GET /v1/teams/:teamId/analysis-runs?before=<version>`: 버전 내림차순 20개와 `nextBefore`를 반환한다. 모든 페이지를 조회할 수 있으며 모델 결과/근거 원문을 공개하지 않는다. run 상태 응답은 #16의 `analysisRunResponseSchema`를 그대로 쓴다.

프리뷰 차단 이유는 SETTINGS_REQUIRED/PERIOD_OUTSIDE_COURSE/FUTURE_PERIOD/DATA_USE_BLOCKED/COVERAGE_INCOMPLETE/NO_DATA다. 형식/유효하지 않은 timezone은400, 세션 만료401, 다른 교수/없는 팀은 동일404다. 프리뷰 자체는 차단 이유를200으로 반환하며 실제 생성은 기존409/CONSENT_REQUIRED를 유지한다. 참조가 전혀 없는 기간은 새 실행을 거부한다. 원문 지문 재확인이 필요한 기존 참조는 삭제로 오인하지 않고 준비 단계에서 다시 확인한다. 생성 batch에서 coverage·참조 존재를 다시 확인하며 기존 동의/설정/참가자 원자적 guard도 유지한다.

수업 종료·수동 중지 후에도 현재 동의가 유효하고 과거 승인 구간과 보관 기한이 허용하는 분석은 가능하다. 신규 수집 비활성만으로 과거 분석을 허용하거나 거부하지 않는다. 프리뷰는 실행 권한을 예약하는 토큰이 아니며 생성 때 조건을 다시 확인한다. 클라이언트가 선택 역량을 run 요청에 넣거나 서버 선택을 덮어쓰지 않는다.

## coverage의 의미와 한계

프리뷰는 source 참조 수, 지문 재확인 필요 수, 확인된 이미지 참조/제약, 수집 보정의 제외 수와 기간 밖 스레드 시작 수, coverage 범위/확인 시각/limitations를 보여준다. 이미지 metadata가 없다고 이미지가 없음을 증명하지 않는다. 기간 이전 스레드 답글은 Events에 의존하는 제약을 항상 표시한다. 실행 때 현재 Slack 원문·이미지와 coverage를 재검증하며 이 프리뷰를 실제 원문 검증 완료로 표현하지 않는다. 통계를 평가 점수·학생 간 순위로 쓰지 않는다.

## 멱등 실행·복원·진행

POST 전 `sessionStorage`에 **교수 ID로 구분한 요청 metadata**(teamId/from/to/timezone/idempotencyKey, 응답 뒤 runId)만 저장한다. OTP·세션·이름·대화·모델 결과는 저장하지 않는다. 중복 클릭은 동기 잠금으로 막는다. 응답 유실 후 같은 요청 확인 버튼은 같은 key를 재사용하므로 #16의 원자적 멱등 API가 기존 run을 반환한다. 알려진 run은 GET만 사용한다. 저장소가 차단되면 복원할 수 없는 POST를 보내지 않는다.

URL에는 검증된 view/team/run ID만 남긴다. 새로고침·인증 재확인 뒤 현재 run을 복원하고, 화면이 보일 때 진행 중 run을5초마다 조회한다. 네트워크 오류 때는 마지막 확인 상태임을 표시하고 조작을 막으며 Retry-After와 세션 만료를 처리한다. 대기/수집/A/B/C/교수 검토·확정과 실제 공급자402/인증/속도/모델/자료 오류를 구분한다. 자동 분석·모델 변경·결과 확정은 하지 않는다.

취소/재개는 실제 `POST /v1/analysis-runs/:id/cancel|resume` 응답을 표시하며 성공을 추정하지 않는다. 재개 가능 여부와 Queue generation 한도는 서버가 결정한다. 새 버전 준비는 진행 중 run이나 응답 미확인 요청을 버리지 않고, 이미 종료한 기존 실행의 이력을 보존한다.

## 검증과 후속 경계

명시적으로 연 팀/run URL은 다른 팀에 보존된 요청보다 우선한다. 보존한 요청은 별도 복원 버튼으로 확인할 수 있다. 취소 상태는 원문 복원·전송 직전·응답 뒤의 공통 run guard에서 검사하며, Slack 재확인 중 취소된 경우도 마지막 guard가 차단한다. 이미 전송 중인 외부 요청을 소급 회수할 수는 없지만 결과 반환·저장을 차단한다.

`tests/analysis-dashboard.test.ts`는 실제 SQLite와 run API를 사용해 소유권·기간/동의/coverage·원자적 실행·22개 버전 페이지·유실 응답 뒤 단일 run/작업·새로고침/취소를 검증한다. `tests/web-analysis.test.ts`와 공유 `@teamplanet/contracts/dashboard-fixtures`는 모든 단계/오류, 빈 상태, 미확인/저장 불가, 중복 클릭·재시도·401·429·날짜·다른 팀 응답을 검사한다. 합성 모의 API 브라우저 검사에서는 단계10종·복원·취소·부분 coverage·관찰 없음·세션 만료·320px/desktop을 확인한다.

현재 Queue A/B/C 연결(#20), 결과/근거(#22), 교수 확정(#23), 출력(#31)이 연결돼 있다. #24는 coverage가 없는 신규 팀의 **기간 대화 확인** 요청과 상태 조회를 추가한다. 실제 수집이 활성화되고 현재 동의가 유효한 팀만 History outbox를 만들 수 있으며, complete coverage 이전에 분석 생성은 계속 거부된다. 프리뷰를 자동 분석으로 바꾸지 않는다. 유실 응답 재시도는 같은 요청 ID를 사용하고, 기술 재시도는 기존 Queue 정책을 따른다. 상세 전체 흐름/거부 회귀와 외부 smoke 범위는 [E2E.md](E2E.md)를 따른다. 실제 외부 메일/Slack/유료 모델 품질·운영 검증은 #25에 남는다.
