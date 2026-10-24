# Production 배포

운영 환경은 하나입니다. preview/staging Worker, 브랜치별 배포, 별도 API 도메인은 만들지 않습니다.

| 항목 | 구성 |
|---|---|
| 웹 주소 | `https://teamplanet.cloby.co` |
| 웹 Worker | `teamplanet-web` — Astro SSR + React + Tailwind |
| API Worker | `teamplanet-api` — Hono, 공개 URL 없음 |
| API 진입점 | 웹의 `/v1/*` → `API` service binding → API Worker |
| DB | `teamplanet-production` — D1, APAC |
| 세션 저장소 | Astro 어댑터가 제공하는 `SESSION` KV |
| Cloudflare 계정 | `d09b11497e0618d6dceff0559855a7b2` |

루트 `cloby.co`의 기존 DNS는 변경하지 않습니다. 앱은 비어 있는 `teamplanet.cloby.co`에 Custom Domain으로 연결하며, Cloudflare가 DNS와 TLS를 관리합니다. 두 Worker 모두 `workers.dev`와 버전 preview URL을 비활성화합니다. API를 별도로 공개하지 않으므로 CORS나 API용 DNS 설정이 필요하지 않습니다.

## 로컬 실행

Node.js 24와 `package.json`에 지정된 Bun 버전을 사용합니다.

```sh
bun install --frozen-lockfile
bun run db:migrate:local
bun run dev
```

웹은 `http://127.0.0.1:4321`, 로컬 API는 `http://127.0.0.1:8787`입니다. 두 개발 서버를 함께 실행해야 서비스 바인딩이 연결됩니다. 로컬 DB는 Wrangler의 `.wrangler/state`에 보관되며 production DB를 사용하지 않습니다.

`bun run typecheck`, `bun test`, `bun run build`로 공통 패키지와 두 앱을 검증합니다. `/v1/health`는 API와 초기 DB 스키마가 연결되면 200을 반환하며 학생 데이터는 반환하지 않습니다. 교수 로그인·Slack 연결·대화 수집·분석·Queue consumer는 후속 구현 대상입니다. 미구현 API는 404를 반환합니다.

## GitHub Actions CD

`.github/workflows/ci.yml`의 단일 `checks` 작업이 다음 순서로 실행됩니다.

1. PR이면 연결 이슈와 마일스톤 확인
2. 고정 lockfile 설치 → 타입 검사 → 테스트 → 두 앱 빌드
3. `main` push인 경우에만 원격 D1 마이그레이션 → API Worker 배포 → 웹 Worker 배포

PR에서는 Cloudflare 토큰을 전달하거나 배포하지 않습니다. `main` 배포는 같은 concurrency group에서 직렬로 처리하며 진행 중인 배포를 새 push가 취소하지 않습니다. 배포 실패 시 Actions 로그를 확인한 후 `Re-run failed jobs`로 재시도할 수 있습니다. D1은 적용 이력을 저장하므로 이미 적용한 마이그레이션을 다시 실행하지 않습니다.

GitHub 저장소 `hyunhomon/teamplanet`에는 다음 값을 설정합니다.

| 종류 | 이름 | 값 |
|---|---|---|
| Repository Secret | `CLOUDFLARE_API_TOKEN` | production 배포용 Cloudflare API 토큰 |
| Repository Variable | `CLOUDFLARE_ACCOUNT_ID` | 위 Cloudflare 계정 ID |

토큰 이름은 `teamplanet-github-production`이며 2027-10-24 만료입니다. 계정의 Workers Scripts/KV/D1 쓰기와 Account Settings 읽기, `cloby.co`의 Workers Routes/SSL 쓰기와 Zone/DNS 읽기 권한을 사용합니다. 만료 전에 동일 권한으로 갱신하여 GitHub Secret을 교체합니다. 로컬 `wrangler login` OAuth는 CI 자격 증명으로 복사하지 않습니다.

## 수동 배포와 변경

관리자가 필요할 때만 아래 명령으로 동일한 production에 수동 배포합니다. 기본 배포 경로는 `main` push에 따른 GitHub Actions입니다.

```sh
bunx wrangler login
bun run build
bun run deploy
```

DB 변경 시 `bun run db:generate`로 마이그레이션을 추가하고 기존 SQL 파일을 수정하지 않습니다. `drizzle-kit push`만으로는 동의 이력 트리거가 설치되지 않습니다. CD는 마이그레이션을 먼저 적용하므로 이미 실행 중인 코드와 호환되는 변경을 사용합니다. 데이터 삭제·비호환 변경은 별도 이관 계획을 마련합니다.

Slack·메일·OpenRouter 비밀 값은 기능 구현 시 API Worker의 secrets로 등록합니다. `.dev.vars`, `.env`, 인증 토큰과 학생 데이터는 커밋하지 않습니다. UI의 연결 표시는 실제 API 상태이며, 초기 화면에서 로그인이나 분석이 구현된 것처럼 표시하지 않습니다.

참고: [Cloudflare GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [Astro Cloudflare 어댑터](https://docs.astro.build/en/guides/integrations-guide/cloudflare/).
