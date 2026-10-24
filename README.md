# TeamPlanet

팀 프로젝트의 **지정된 Slack 채널 내 전체 대화**를 수동 기록 없이 수집하여, 교수에게 **4개 커뮤니케이션 역량별 정성 평가와 원문 근거**를 제공하는 평가 지원 도구입니다.

> 이 번들은 **문서 + 기초 계약/설정 파일**만 포함합니다. 실행 가능한 Astro/Hono 앱 스캐폴딩, 구현된 Slack OAuth, 배포물은 포함하지 않습니다.

## 합의된 MVP 경계

- **단일 실험용 Slack 워크스페이스**를 설정 마법사로 초기화합니다. 워크스페이스 준비 안내 → OAuth → 채널 템플릿 생성 → 봇 초대 → 학생 초대 및 동의 → 수집 활성화.
- 수집 대상은 **사전 고지·동의된 팀별 공식 채널의 전체 메시지/스레드/첨부 이미지**입니다. DM/사적 채널/기타 채널은 대상이 아닙니다.
- 교수는 이메일 OTP로 접근해 **기간을 지정하고 수동으로 분석**을 시작합니다. 자동 주기 분석은 MVP 제외.
- AI는 **3개 모델을 단계별 오케스트레이션**하며, 원문 근거가 있는 역량별 정성 평가를 만듭니다.
- 앱 레벨의 비용 상한/총토큰 예산/강제 정지는 **없습니다**. 실제 OpenRouter의 잔액 부족·키 한도 등 **402 응답으로만** 과금 부족을 판단합니다. 402 이외 오류는 별도 처리합니다.
- 모델 ID는 운영 시 `.env`에 주입합니다. 직전 합의 모델명을 현재 번들에서 정확히 확인할 수 없어 **임의의 모델 ID로 고정하지 않았습니다**. 세 역할은 확정이며 슬롯에 합의된 모델 ID를 넣으면 됩니다.

## 파일 안내

- `docs/PRD.md` 문제·범위·사용자 시나리오
- `docs/ARCHITECTURE.md` 모노레포 및 Cloudflare 구성
- `docs/AI_ORCHESTRATION.md` 3단계 멀티모델 파이프라인
- `docs/EVALUATION_RUBRIC.md` 4개 역량·근거·평가 가드레일
- `docs/SLACK_ONBOARDING.md` OAuth·채널/봇 설치·동의 마법사
- `docs/PRIVACY_AND_DATA.md` 범위·권한·보관·삭제
- `docs/API_CONTRACT.md` 엔드포인트/상태/에러
- `docs/DELIVERY_PLAN.md` 개발 순서·검증 기준
- `docs/ADR/0001-decisions.md` 의사결정 로그
- `packages/contracts/` 공유 타입·JSON 계약
- `packages/ai-core/` OpenRouter 402 에러 분류 유틸·기본 계약
- `packages/db/` Drizzle D1 초기 스키마·마이그레이션
- `prompts/` 모델 역할별 프롬프트 초안

## 시작

1. `.env.example`을 복사하여 실제 비밀 값과 **합의된 3개 OpenRouter 모델 ID**를 지정합니다.
2. 문서의 평가 역량명과 Slack 앱의 실제 OAuth scope를 운영 조건에 맞게 확정합니다.
3. `bun install` 후 각 앱(`apps/web`, `apps/api`)은 직접 스캐폴딩합니다.
4. `packages/*` 코드는 **참조 구현**이며, 바로 실행되는 서비스라고 간주하지 않습니다.

## 개발 검증

협업자와 코딩 에이전트는 작업 전에 [AGENTS.md](AGENTS.md)와 [협업 절차](CONTRIBUTING.md)를 읽고, 열린 이슈·마일스톤을 확인한 뒤 작업 브랜치와 PR을 사용합니다. GitHub Actions는 PR의 실제 이슈·마일스톤 연결, 타입 검사, 테스트를 검사합니다. 서버에서 병합을 강제 차단하기 위한 `main` 보호 설정은 협업 절차에 설명되어 있습니다.

`bun install --frozen-lockfile` 후 `bun run typecheck`와 `bun test`로 공통 패키지를 검증합니다. 테스트는 OpenRouter 모의 응답과 로컬 메모리 SQLite를 사용하며 외부 API를 호출하지 않습니다.

DB 스키마 변경 후 `bun run db:generate`로 마이그레이션을 생성합니다. 초기 D1 구성 시 `packages/db/migrations/`의 SQL을 순서대로 적용해야 하며, `0001_consent_audit.sql`의 트리거도 포함해야 합니다. `drizzle-kit push`만으로는 동의 이력 트리거가 설치되지 않습니다. Cloudflare 바인딩 및 배포 설정은 앱 스캐폴딩 단계에서 구성합니다.

## 정책

비용 제한은 앱에서 걸지 않습니다. 다만 API 공급자가 반환한 `402`의 원인에 따라 `insufficient_credits`/`key_limit_exhausted`/`in_flight_budget`으로 표준화합니다. 타임아웃, 모델 컨텍스트 창 한계, Slack API rate limit은 **비용 제약이 아니라 기술적 제약**입니다.
