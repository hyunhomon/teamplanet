# 합성 전체 흐름 검증 (#24)

Node.js 24와 Bun 1.3.14에서 새 checkout을 다음 순서로 검증한다.

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bunx playwright-core install chromium --only-shell
bun run e2e:local
```

이미 설치된 Chrome/Chromium을 사용할 때는 `E2E_CHROMIUM_EXECUTABLE`에 실행 파일 경로를 지정한다. CI는 기존 Ubuntu runner의 Chrome을 찾아 사용하며 브라우저를 새로 내려받거나 배포 secret을 사용하지 않는다. 한 checks job을 유지하고 빌드 후 E2E를 추가한다. 테스트는 조용히 건너뛰지 않으며 브라우저가 없으면 실패한다.

## 실제로 실행하는 경계

`verify-e2e-local.ts`는 **빌드된 Astro SSR·정적 assets → 내부 API service binding → production Hono 라우트/세션/소유권/메일 adapter → 실제 로컬 D1·Queue → production Consumer handlers/lease runner → 실제 결과/확정/출력 UI**를 연결한다. 합성 브라우저가 설정/평가 DTO를 대신 만들어 반환하지 않는다. 초기 SQL은 운영자가 등록해야 하는 합성 교수 2명과 동의 정책뿐이다. 수업·팀·학생·동의·수집 구간·coverage·분석/평가/확정은 실제 앱 경로로 생성한다.

테스트 전용 Worker entrypoint는 시계를 주입한다. 실제 외부 서비스 경계의 Slack/OAuth·메일·OpenRouter만 `tests/e2e/provider.ts`가 응답한다. OAuth 설치 라우트가 만든 실제 state/redirect를 확인하고 외부 화면 대신 로컬 callback으로 보낸다. 브라우저의 외부 navigation 전에 가로채며 Worker outbound도 알 수 없는 목적지에서 실패한다. provider 함수는 실제 fetch로 fallback하지 않는다. 운영용 엔트리·wrangler·환경·secret을 바꾸거나 공개 테스트 API를 배포하지 않는다.

각 실행은 `node_modules/.cache/e2e-local-*` 아래 격리 D1/Queue/KV와 합성 PDF를 사용한다. production DB/큐/실제 학생 자료·Slack·메일 계정·유료 모델을 사용하지 않는다. 실제 모델 정확도나 외부 계정 연결 검증을 뜻하지 않는다.

## 실행 경로와 증거

- Chromium에서 OTP 로그인과 Secure/HttpOnly host cookie, Slack OAuth state/callback, 수업·기간·명시 역량 선택·공식 채널·학생·계정 매핑·오프라인 증빙·개인 QR 재확인·수집 활성화.
- QR 학생의 교수 API 접근 거부, 동의 전 활성화 거부, 모델 전송 0회. 웹 문의의 접수·교수 답변·학생 재조회.
- coverage가 없는 신규 팀에서 기간 프리뷰 → 수집 확인 요청 → History Queue 처리 → 전체 coverage → 수동 분석. Queue 작업 payload는 공통 schema로 정규화하며 동일 요청/분실 응답의 재전달이 새 작업을 만들지 않는다.
- 이미지 포함 A→B→C, 근거 원문 뷰어, 교수 사유/명시 확인·확정, 학생 리포트 재검증과 실제 PDF 생성/출력 후 비우기.
- Worker reload 이후 세션/저장 결과 재조회, 1개/4개 선택·기존 snapshot 보존, B 수정/C 재검토 1회, 확정 충돌, 402 명시 재개·429 기술 재시도.
- 서로 다른 실제 교수 세션/ID 바꿔치기·Origin/Slack 서명 거부, Slack 장애와 삭제 구분, 확정 후 원문 변경·철회 차단, DB/Queue/checkpoint의 원문·이미지·키 비보관과 FK 검사.

`bun test`의 세부 거부 회귀와 native E2E는 역할을 나눠 유지한다. 시나리오를 통과하지 않은 범위까지 전체 E2E 완료라고 쓰지 않는다.

| 경계 | 자동 검증 |
|---|---|
| 세션/교수 소유권/CSRF/학생 접근 | native E2E + auth/guard/results/reports 테스트 |
| 동의 전·신규/미매핑 참가자·위조/DM/철회 이벤트 | native E2E + teams/consents/student-consent/slack-events 테스트 |
| History 페이지 누락/반복 cursor/원문 삭제와 Slack 장애 | slack-history 테스트 + native 정상/장애 경로 |
| 공급자 402 종류·401/403/429/5xx/200 오류/JSON/context·참조 조작 | analysis-pipeline/evidence/assessor/reviewer 테스트 + native 402/429 |
| 실행 중 철회·취소·저장 rollback·결과 불명/재전달 | analysis-pipeline/queue 테스트; native reload는 완료 checkpoint/세션 보존 검사 |
| 수업 종료 + 달력 3개월, 문의 접수 + 교수 n일·삭제 rollback | data-lifecycle/inquiries 테스트의 고정 시계·실제 SQL migration |
| 긴 한국어 다중 페이지·승인 전 PDF·모바일·출력 정보 분리 | reports/report-location 테스트, #31 Chromium/Poppler/pypdf QA; native E2E는 실제 출력 연결 |

## 실제 외부 서비스 smoke와 중단 기준 (#25)

운영자가 승인한 테스트 계정/합성 자료로만 수행하고 결과·일시·책임자와 비밀 값 없는 로그 참조를 #25에 남긴다. 아직 실행하지 않은 항목은 **미실시**로 둔다.

1. 실제 메일 수신 → OTP 로그인/로그아웃/세션 만료. 요청 202를 메일 전달 성공으로 간주하지 않는다.
2. Slack 앱/manifest·workspace·bot scopes·서명·API/Consumer 동일 `SLACK_TOKEN_KEY` 확인 → OAuth → 공식 채널/매핑 → 오프라인·QR → 활성화. 미동의 상태에 이벤트/History/이미지 전송이 없어야 한다.
3. Consumer의 `OPENROUTER_API_KEY`·고정 Qwen 슬롯, 유효 DeepInfra BF16/ZDR 경로와 계정 logging/지역·고지 일치를 확인한다. 합성 대화/이미지로 실제 provider receipt와 402/권한 구분을 확인한다. 키 값/대화 원문을 증거에 붙이지 않는다.
4. 실제 thread/편집/삭제/철회/권한 상실·검증 장애가 기존 교수 확정/출력을 차단하는지 확인한다. 장애를 삭제로 판단하거나 영구 캐시로 우회하면 중단한다.
5. 교수/운영자의 품질 기준과 사람 2인 평가, 편향·관찰 부족·이미지·검토 시간·학생 고지 이해를 확인하고 go/no-go를 기록한다. 실패한 조건을 CI 성공으로 대체하지 않는다.

키/권한/유효성·전체 coverage·근거 정합성·외부 전송 조건을 확인하지 못하면 실제 수집/분석/출시를 진행하지 않는다. production에 fixture를 심지 않으며 이 검증 명령은 파일럿 개시나 실제 학생 수집을 승인하지 않는다.
