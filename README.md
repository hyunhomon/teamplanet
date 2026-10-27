# TeamPlanet

팀 프로젝트의 **지정된 Slack 채널 내 전체 대화**를 수동 기록 없이 수집하여, 교수에게 **선택한 커뮤니케이션 역량별 정성 평가와 원문 근거**를 제공하는 평가 지원 도구입니다.

> Astro SSR 웹과 Hono API의 실행 가능한 초기 구조, D1 마이그레이션, GitHub Actions production CD가 구성되어 있습니다. 교수 인증·Slack OAuth·수집·AI 분석 기능은 아직 구현 전입니다.

교수 로그인 UI는 `/login`에서 실제 `/v1/auth/*` 계약을 사용합니다. 인증 API가 제공되기 전에는 서비스 준비 안내를 표시하며, 로그인 셸의 합성 응답 검증과 실제 서버 통합 범위는 [로그인 UI 문서](docs/WEB_AUTH.md)에 정리했습니다.

## 합의된 MVP 경계

- **단일 실험용 Slack 워크스페이스**를 설정 마법사로 초기화합니다. 워크스페이스 준비 안내 → OAuth → 채널 템플릿 생성 → 봇 초대 → 학생 초대 및 동의 → 수집 활성화.
- 수집 대상은 **사전 고지·동의된 팀별 공식 채널의 전체 메시지/스레드/첨부 이미지**입니다. DM/사적 채널/기타 채널은 대상이 아닙니다.
- 내부 파일럿은 성인 4명×20팀·약 2개월이며 성적에 반영하지 않는 참고/피드백용입니다. 교수가 오프라인 동의를 확보하고 학생이 QR 페이지에서 재확인합니다. [승인 정책](docs/PRIVACY_AND_DATA.md)에 따라 전원 사전 동의를 전제로 대체 평가·가입/개정 전용 UI는 제외하며 서버의 동의 확인은 유지합니다.
- Slack을 원문 저장소로 사용하고 서비스는 **메시지 링크·변경 확인 metadata·요약·결과**를 보관합니다. 원문/이미지는 실행 중에만 처리합니다. 리포트 열람·확정·출력 전 원문을 재검증하며 변경 시 교수 확정본도 무효화합니다.
- 요약·리포트 등은 **수업 종료 후 3개월** 보관 후 삭제합니다. 웹 문의는 **접수 후 교수 설정 n일**에 자동 삭제합니다. 학생 문의·교수의 리포트 출력 전달은 후속 구현 범위이며 문서가 기능 구현을 뜻하지 않습니다.
- 교수는 이메일 OTP로 접근해 **기간을 지정하고 수동으로 분석**을 시작합니다. 자동 주기 분석은 MVP 제외.
- 교수는 초기 설정에서 **4개 중 1~4개 역량을 선택**합니다. AI는 A/B/C 별도 호출로 원문 근거가 있는 선택 역량별 정성 평가를 만듭니다. 선택 UI와 실행 연결은 #3/#9/#16 후속 구현입니다.
- 앱 레벨의 비용 상한/총토큰 예산/강제 정지는 **없습니다**. 실제 OpenRouter의 잔액 부족·키 한도 등 **402 응답으로만** 과금 부족을 판단합니다. 402 이외 오류는 별도 처리합니다.
- 초기 `qwen-pilot-v1`은 세 역할 모두 `qwen/qwen3.5-9b`·DeepInfra BF16·ZDR 전용입니다. 실제 표시명/동의된 프로젝트 이미지 전송을 허용합니다. [결정 근거·검증 한계](docs/ADR/0003-rubric-model-profile.md)를 따르며 실제 모델 품질 검증은 아직 수행하지 않았습니다.

## 파일 안내

- `docs/PRD.md` 문제·범위·사용자 시나리오
- `docs/ARCHITECTURE.md` 모노레포 및 Cloudflare 구성
- `docs/AI_ORCHESTRATION.md` 3단계 멀티모델 파이프라인
- `docs/EVALUATION_RUBRIC.md` 4개 역량·근거·평가 가드레일
- `docs/SLACK_ONBOARDING.md` OAuth·채널/봇 설치·동의 마법사
- `docs/PRIVACY_AND_DATA.md` 범위·권한·보관·삭제
- `docs/API_CONTRACT.md` 엔드포인트/상태/에러
- `docs/DELIVERY_PLAN.md` 개발 순서·검증 기준
- `docs/DEPLOYMENT.md` 로컬 실행·단일 production 배포·CD 운영
- `docs/ADR/0001-decisions.md` 의사결정 로그
- `packages/contracts/` 공유 타입·Zod 런타임 검증·합성 API fixture (`@teamplanet/contracts/fixtures`)
- `packages/ai-core/` OpenRouter 402 에러 분류 유틸·기본 계약
- `packages/db/` Drizzle D1 초기 스키마·마이그레이션
- `packages/queue/` D1 outbox·lease·체크포인트·재시도와 DLQ 복구 기반
- `docs/QUEUE_OPERATIONS.md` 작업 envelope·재시도 상한·DLQ 단건 복구·큐 검증
- `prompts/` 모델 역할별 프롬프트 초안
- `apps/web/` Astro SSR + React + Tailwind 웹
- `apps/api/` D1에 연결된 Hono Worker API
- `apps/consumer/` Queue/cron Worker (합성 probe, 실제 수집·분석 handler는 후속 구현)

## 시작

Node.js 24와 Bun 1.3.14를 사용합니다.

```sh
bun install --frozen-lockfile
bun run db:migrate:local
bun run dev
```

웹은 `http://127.0.0.1:4321`에서 열립니다. 기본 화면과 API 상태 확인에는 외부 서비스 비밀 값이 필요하지 않습니다. 외부 기능 구현 시 `.env.example`을 참고해 비밀 값과 합의된 3개 모델 ID를 등록합니다. 선택 설정 UI는 후속 구현이며 Slack OAuth scope와 실제 전송 고지는 운영 전에 확인해야 합니다.

production 주소는 `https://teamplanet.cloby.co`입니다. `main` push의 **CI**가 성공하면 별도 **CD**가 배포하고, [GitHub Deployments](https://github.com/hyunhomon/teamplanet/deployments)에 커밋·진행 상태·결과·실행 로그를 기록합니다. 상세 구성은 [배포 문서](docs/DEPLOYMENT.md)를 참고하세요.

## 개발 검증

협업자와 코딩 에이전트는 작업 전에 [AGENTS.md](AGENTS.md)와 [협업 절차](CONTRIBUTING.md)를 읽고, 열린 이슈·마일스톤을 확인한 뒤 작업 브랜치와 PR을 사용합니다. GitHub Actions는 PR의 실제 이슈·마일스톤 연결, 타입 검사, 테스트와 빌드를 검사합니다. 서버에서 병합을 강제 차단하기 위한 `main` 보호 설정은 협업 절차에 설명되어 있습니다.

`bun install --frozen-lockfile` 후 `bun run typecheck`, `bun test`, `bun run build`로 공통 패키지와 세 앱을 검증합니다. 테스트는 OpenRouter 모의 응답과 로컬 메모리 SQLite를 사용하며 외부 API를 호출하지 않습니다.

`bun run queue:verify:local`은 실제 Consumer와 로컬 Queue/D1을 격리해 정상·중복 전달 및 DLQ 이동을 검증하며 CI에서도 실행합니다. Consumer를 포함해 세 앱의 타입·빌드를 확인합니다. 배포는 단일 production에서 큐 준비 → migration → Consumer → API → 웹 순서이며 공개 큐 테스트 엔드포인트를 추가하지 않습니다.

DB 스키마 변경 후 `bun run db:generate`로 마이그레이션을 생성합니다. 로컬은 `bun run db:migrate:local`, production은 CD의 `bun run db:migrate`로 SQL과 동의 이력 트리거를 순서대로 적용합니다. `drizzle-kit push`만으로는 트리거가 설치되지 않습니다.

인증 API(#2)와 로그인 UI(#4)는 [API 계약](docs/API_CONTRACT.md)의 요청·세션·오류 스키마와 `packages/contracts/src/fixtures.ts`를 공유합니다. 교수별 소유권과 Slack 학생 매핑, 기존 DB 평가·동의 이력의 로컬 D1 업그레이드 검증은 [DB 안내](packages/db/README.md)를 참고하세요. 서비스 정책은 [ADR-0002](docs/ADR/0002-pilot-policy.md)에 승인 기록을 남기며, 루브릭·모델 결정은 [ADR-0003](docs/ADR/0003-rubric-model-profile.md)에 기록하며 실제 전송 고지·품질·운영 확인은 파일럿 시작 전에 남아 있습니다.

## 정책

비용 제한은 앱에서 걸지 않습니다. 다만 API 공급자가 반환한 `402`의 원인에 따라 `insufficient_credits`/`key_limit_exhausted`/`in_flight_budget`으로 표준화합니다. 타임아웃, 모델 컨텍스트 창 한계, Slack API rate limit은 **비용 제약이 아니라 기술적 제약**입니다.
