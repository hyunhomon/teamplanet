# Production 배포

운영 환경은 하나입니다. preview/staging Worker, 브랜치별 배포, 별도 API 도메인은 만들지 않습니다.

| 항목 | 구성 |
|---|---|
| 웹 주소 | `https://teamplanet.cloby.co` |
| 웹 Worker | `teamplanet-web` — Astro SSR + React + Tailwind |
| API Worker | `teamplanet-api` — Hono, 공개 URL 없음 |
| Consumer 배포 대상 | `teamplanet-consumer` — Queue/cron 전용, 공개 URL 없음 |
| Queue 배포 대상 | `teamplanet-jobs`, `teamplanet-jobs-dlq` — 같은 production 계정 |
| API 진입점 | 웹의 `/v1/*` → `API` service binding → API Worker |
| DB | `teamplanet-production` — D1, APAC |
| 세션 저장소 | `teamplanet-web-session` KV — 웹의 `SESSION` 바인딩 |
| Cloudflare 계정 | `d09b11497e0618d6dceff0559855a7b2` |

루트 `cloby.co`의 기존 DNS는 변경하지 않습니다. `teamplanet.cloby.co` Custom Domain과 Cloudflare DNS/TLS를 유지합니다. 웹·API·Consumer 모두 `workers.dev`와 버전 preview URL을 비활성화합니다. API와 Consumer를 별도로 공개하지 않으므로 CORS나 추가 API용 DNS 설정이 필요하지 않습니다. Queue/Consumer는 #10의 배포 대상이며 이 문서 수정만으로 실제 리소스가 생성된 것은 아닙니다.

## 로컬 실행

Node.js 24와 `package.json`에 지정된 Bun 버전을 사용합니다.

```sh
bun install --frozen-lockfile
bun run db:migrate:local
bun run dev
```

로컬 교수 로그인은 실제 메일 대신 API 콘솔로 OTP를 받습니다. `apps/api/.dev.vars.example`을 `apps/api/.dev.vars`로 복사하고 합성 교수를 등록합니다.

```sh
cp apps/api/.dev.vars.example apps/api/.dev.vars
cd apps/api && bunx wrangler d1 execute DB --local --command "INSERT INTO professors (id, email, created_at) VALUES ('prof_00000000-0000-4000-8000-000000000001', 'professor-a@example.invalid', 1793000000000)"
```

`http://127.0.0.1:4321`에서 OTP를 요청하면 API 로그에 `[local dev only] TeamPlanet OTP ...`가 찍힙니다. 콘솔 발송은 `AUTH_DEV_LOG_OTP=true`와 loopback 요청 host가 모두 맞을 때만 동작하므로 production에서는 켜지지 않습니다. 세션 쿠키는 production과 같은 `__Host-` Secure 쿠키입니다. Chromium·Firefox는 `127.0.0.1`/`localhost`의 HTTP에서도 이 쿠키를 받습니다. Safari 로컬 로그인은 지원하지 않습니다.

웹은 `http://127.0.0.1:4321`, 로컬 API는 `http://127.0.0.1:8787`입니다. 두 개발 서버를 함께 실행해야 서비스 바인딩이 연결됩니다. 로컬 DB는 Wrangler의 `.wrangler/state`에 보관되며 production DB를 사용하지 않습니다.

`bun run typecheck`, `bun test`, `bun run build`로 공통 패키지와 세 앱을 검증합니다. `bun run queue:verify:local`은 실제 Consumer·격리된 로컬 Queue/D1 왕복과 native DLQ를 검증합니다. `/v1/health`는 API와 DB 연결 상태만 확인하며 학생 데이터를 반환하지 않습니다. Consumer는 합성 probe만 처리하고 Slack 연결·수집·분석 handler는 후속 구현 대상입니다. 세션 없는 `/v1` 요청은 미구현 경로도 401, 로그인 상태의 미구현 경로는 404입니다. 일반 개발에서 생산자·Consumer 연결과 같은 D1 persist 경로 사용법은 [Queue 운영 문서](QUEUE_OPERATIONS.md)를 참고하세요.

## GitHub Actions CI / CD

Actions 목록에 **CI**와 **CD**가 별도 워크플로로 표시됩니다. 두 워크플로는 각각 Ubuntu 작업 하나를 사용하며, 배포 환경은 production만 있습니다.

1. `.github/workflows/ci.yml` — PR과 `main` push에서 실행합니다. PR이면 연결 이슈·마일스톤 확인 후 고정 lockfile 설치 → 타입 검사 → 테스트 → 격리된 로컬 큐 검증 → 세 앱 빌드를 수행합니다. 배포하지 않으며 권한은 읽기 전용입니다. Cloudflare 자격 증명을 추가하지 않습니다.
2. `.github/workflows/cd.yml` — 같은 저장소의 `main` push CI가 성공한 경우에만 실행합니다. CI가 검증한 정확한 SHA를 checkout하고 시작 시 최신 `main`인지 확인합니다. 실패한 CI·PR·fork·오래된 커밋의 재실행은 배포하지 않습니다.
3. CD가 GitHub Deployment를 생성해 진행 중 상태를 기록하고, 고정 lockfile로 해당 SHA를 다시 빌드합니다. `bun run deploy`는 **DLQ/작업 큐 준비 → 원격 D1 마이그레이션 → Consumer Worker → API Worker → 웹 Worker** 순서로 실행하며 어느 단계든 실패하면 다음 배포를 진행하지 않습니다. 큐 생성은 멱등이며 기존 큐의 보관/일시정지 설정을 덮어쓰지 않습니다. Consumer를 먼저 연결한 뒤 API 생산자를 배포합니다.
4. `queue:smoke:production`이 현재 CD 토큰으로 합성 probe를 발행하고 D1 완료를 확인합니다. 이어서 `/v1/health`에서 API·DB를 확인한 다음 성공 상태를 기록합니다. 빌드·큐 준비·배포·smoke·health 실패/취소도 기존 GitHub Deployment 마지막 단계에 그대로 기록합니다. Release/태그로 배포 이력을 대체하지 않습니다.

CI는 새 커밋이 들어오면 오래된 검증을 취소합니다. CD는 `cd-production` concurrency group에서 직렬로 처리하고 진행 중인 배포를 새 push가 취소하지 않습니다. Cloudflare 토큰은 CD의 배포 단계에만 전달합니다. CD의 GitHub 권한은 소스 읽기와 Deployment 기록 쓰기뿐이며 소스·태그·Release 쓰기 권한을 주지 않습니다. CD는 검증된 소스를 다시 빌드합니다.

배포 실패 시 CD의 `Re-run failed jobs`로 재시도할 수 있습니다. D1은 이미 적용한 마이그레이션을 다시 실행하지 않습니다. 현재 `main`의 CD를 재실행하면 새로운 배포 시도로 기록합니다. 구버전 rollback은 관리자가 별도로 수행하며 오래된 CI 재실행으로 우회하지 않습니다.

## 배포 이력과 로그 조회

[GitHub Deployments](https://github.com/hyunhomon/teamplanet/deployments)에서 production 배포 이력을 조회합니다. CD 실행의 Summary에도 배포 이력·실행 로그·서비스 링크가 표시됩니다.

- 각 시도에 검증된 커밋 SHA, `production` 환경, CI/CD 실행 ID가 저장됩니다. 상태에는 생성/진행/완료 시각과 서비스 주소, CD 로그 링크가 기록됩니다.
- 상태는 `in_progress` → `success` 또는 `failure`입니다. 취소는 GitHub가 지원하는 `error` 상태와 취소 설명으로 남깁니다. 실패한 시도를 성공 기록으로 덮어쓰지 않습니다.
- 같은 SHA를 재배포해도 각 시도를 별도로 남깁니다. 재실행 attempt 번호와 해당 attempt의 로그 링크도 보존합니다. 시작 조건을 통과하지 못해 실제 배포를 하지 않은 실행은 Deployment를 만들지 않습니다.
- 배포 로그를 위해 Release·태그·소스 압축 파일을 생성하지 않습니다. Deployment 기록은 실제 Cloudflare 배포와 별개인 이력이며 소스 버전 복구만으로 DB 마이그레이션을 되돌릴 수는 없습니다.

GitHub 저장소 `hyunhomon/teamplanet`에는 다음 값을 설정합니다.

| 종류 | 이름 | 값 |
|---|---|---|
| Repository Secret | `CLOUDFLARE_API_TOKEN` | production 배포용 Cloudflare API 토큰 |
| Repository Variable | `CLOUDFLARE_ACCOUNT_ID` | 위 Cloudflare 계정 ID |

토큰 이름은 `teamplanet-github-production`이며 2027-10-24 만료입니다. 계정의 Workers Scripts/KV/D1 쓰기와 Account Settings 읽기, `cloby.co`의 Workers Routes/SSL 쓰기와 Zone/DNS 읽기 권한을 사용합니다. 만료 전에 동일 권한으로 갱신하여 GitHub Secret을 교체합니다. 로컬 `wrangler login` OAuth는 CI 자격 증명으로 복사하지 않습니다.

### #10 Queue 권한 확인 — 2026-10-27

실제 CD secret 값은 GitHub에서 읽을 수 없고, 현재 브라우저는 Cloudflare 로그인 화면으로 이동했습니다. 토큰 정책 자체와 Queue 원격 호출은 검증하지 못했으며, 사용자도 아직 권한 포함 여부를 확인하지 못한 상태입니다. 기존 문서의 Workers Scripts 권한만으로 부족하다고 단정하지 않습니다.

- 공식 Queue 생성/발행 API는 `Queues Write` 또는 `Workers Scripts Write`를 허용합니다. 명시적으로 추가할 최소 권한은 **Account → Queues → Edit** (`Queues Write`), 리소스 범위는 계정 **`d09b11497e0618d6dceff0559855a7b2` 한 개**입니다. Consumer 코드/바인딩/cron 배포에는 기존 `Workers Scripts: Edit`, migration·smoke·복구에는 기존 `D1: Edit`도 필요합니다.
- `queues:ensure`는 실제 CD 토큰으로 정확한 큐 이름을 조회하고 없을 때 생성합니다. 기존 큐 조회 성공만으로 쓰기 권한 검증 완료라고 보고하지 않습니다. Consumer 배포와 이후 합성 메시지 발행 smoke가 쓰기·연결·처리를 검증합니다.
- 401/403 또는 permission error면 로그에 HTTP 상태/고정 API 오류 코드와 필요한 권한·계정만 남기고 CD를 실패시킵니다. 관리자가 Cloudflare의 토큰 정책/계정 범위를 확인하고 필요한 경우 위 Queues 권한을 추가한 토큰으로 GitHub `CLOUDFLARE_API_TOKEN`을 교체한 뒤 같은 최신 main의 CD를 재실행해야 합니다. 실제 토큰 값은 이슈·PR·로그에 붙이지 않습니다.
- 이번 PR에서는 권한 변경·토큰 발급/교체·원격 큐 생성·실제 배포·production smoke를 수행하지 않습니다. 첫 main CD 전 토큰 확인이 남아 있습니다.

근거: [Queue 생성 API 권한](https://developers.cloudflare.com/api/resources/queues/methods/create/), [메시지 발행 API 권한](https://developers.cloudflare.com/api/resources/queues/subresources/messages/methods/push/). 구현·DLQ 복구·원장 조회와 smoke 절차는 [Queue 운영 문서](QUEUE_OPERATIONS.md)에 있습니다.

## Cloudflare 구성 확인 — 2026-10-26

- production Worker는 `teamplanet-web`, `teamplanet-api` 두 개입니다.
- `teamplanet.cloby.co` Custom Domain은 웹 Worker에 연결되어 있습니다. 루트 `cloby.co`는 기존 설정을 유지합니다.
- 웹에는 정적 자산 `ASSETS`, 세션 KV `SESSION`, 내부 API 서비스 `API`가 바인딩되어 있습니다. API에는 D1 `DB`가 바인딩되어 있습니다.
- D1은 `teamplanet-production`, KV는 `teamplanet-web-session`을 사용합니다. D1 초기 테이블과 동의 이력 트리거는 SQL 마이그레이션으로 관리합니다.
- 위 목록은 2026-10-26에 확인한 배포 상태입니다. #10은 `teamplanet-consumer`와 production 작업 큐/DLQ의 구성·생성·배포·smoke 경로를 추가하지만 실제 생성 여부는 첫 CD 결과로 확인해야 합니다. R2 바인딩과 실제 Slack·메일·모델 자격 증명은 후속 이슈 범위입니다. preview URL과 `workers.dev`는 계속 비활성화합니다.

## 수동 배포와 변경

관리자가 필요할 때만 아래 명령으로 동일한 production에 수동 배포합니다. 기본 배포 경로는 `main` push에 따른 GitHub Actions입니다.

```sh
bunx wrangler login
bun run build
bun run deploy
```

DB 변경 시 `bun run db:generate`로 마이그레이션을 추가하고 기존 SQL 파일을 수정하지 않습니다. `drizzle-kit push`만으로는 동의 이력 트리거가 설치되지 않습니다. CD는 마이그레이션을 먼저 적용하므로 이미 실행 중인 코드와 호환되는 변경을 사용합니다. 데이터 삭제·비호환 변경은 별도 이관 계획을 마련합니다.

### 교수 로그인 메일(Resend)

API Worker는 [Resend](https://resend.com/docs/api-reference/emails/send-email) HTTP API로 OTP를 보냅니다. 두 값이 없으면 OTP 요청은 `EMAIL_DELIVERY_UNAVAILABLE`/503이며 성공으로 표시하지 않습니다.

1. Resend에서 발신 도메인을 추가하고 안내된 DNS 레코드(SPF·DKIM)를 Cloudflare DNS에 등록한 뒤 검증합니다.
2. 발송 전용 API 키를 만들고 API Worker에 등록합니다. 값은 저장소·이슈·PR에 남기지 않습니다.

```sh
cd apps/api
bunx wrangler secret put RESEND_API_KEY
bunx wrangler secret put AUTH_EMAIL_FROM   # 예: TeamPlanet <login@검증된-도메인>
```

3. 교수 이메일을 production D1에 등록합니다. ID는 `prof_<소문자 UUIDv4>`, 이메일은 소문자입니다.

```sh
bunx wrangler d1 execute DB --remote --command "INSERT INTO professors (id, email, created_at) VALUES ('prof_<uuid>', '<email>', <epoch-ms>)"
```

4. 실제 전달 확인: 등록한 본인 테스트 이메일로 https://teamplanet.cloby.co 에서 OTP를 요청하고 메일 수신, 로그인, `/v1/auth/me` 200, 로그아웃 후 401을 확인합니다. Resend 대시보드의 Emails 기록과 `bunx wrangler tail teamplanet-api`의 `auth.email_delivery_failed` 유무도 확인합니다. 로그에는 OTP·토큰을 남기지 않습니다.

### Slack 앱(#6)

1. https://api.slack.com/apps → Create New App → From a manifest에서 파일럿 workspace를 고르고 [`apps/api/slack-manifest.json`](../apps/api/slack-manifest.json)을 붙여 넣습니다.
2. Basic Information의 Client ID·Client Secret과 새 암호화 키를 API Worker secret으로 등록합니다. 키는 한 번 만들고 바꾸지 않습니다. 바꾸면 저장된 토큰을 열 수 없어 재설치가 필요합니다.

```sh
cd apps/api
bunx wrangler secret put SLACK_CLIENT_ID
bunx wrangler secret put SLACK_CLIENT_SECRET
openssl rand -base64 32 | bunx wrangler secret put SLACK_TOKEN_KEY
```

3. 설치·권한 확인은 [SLACK_ONBOARDING.md](SLACK_ONBOARDING.md) 1단계를 따릅니다. Slack은 HTTPS redirect만 허용하므로 로컬 `http://127.0.0.1`에서는 실제 설치를 하지 않고 테스트의 OAuth 가짜 응답으로 검증합니다.

OpenRouter 비밀 값은 기능 구현 시 API Worker의 secrets로 등록합니다. `.dev.vars`, `.env`, 인증 토큰과 학생 데이터는 커밋하지 않습니다. UI의 연결 표시는 실제 API 상태이며, 초기 화면에서 로그인이나 분석이 구현된 것처럼 표시하지 않습니다.

참고: [Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [Astro Cloudflare 어댑터](https://docs.astro.build/en/guides/integrations-guide/cloudflare/).
