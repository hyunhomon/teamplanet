# Production 배포

운영 환경은 하나입니다. preview/staging Worker, 브랜치별 배포, 별도 API 도메인은 만들지 않습니다.

| 항목 | 구성 |
|---|---|
| 웹 주소 | `https://teamplanet.cloby.co` |
| 웹 Worker | `teamplanet-web` — Astro SSR + React + Tailwind |
| API Worker | `teamplanet-api` — Hono, 공개 URL 없음 |
| API 진입점 | 웹의 `/v1/*` → `API` service binding → API Worker |
| DB | `teamplanet-production` — D1, APAC |
| 세션 저장소 | `teamplanet-web-session` KV — 웹의 `SESSION` 바인딩 |
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

## GitHub Actions CI / CD

Actions 목록에 **CI**와 **CD**가 별도 워크플로로 표시됩니다. 두 워크플로는 각각 Ubuntu 작업 하나를 사용하며, 배포 환경은 production만 있습니다.

1. `.github/workflows/ci.yml` — PR과 `main` push에서 실행합니다. PR이면 연결 이슈·마일스톤 확인 후 고정 lockfile 설치 → 타입 검사 → 테스트 → 두 앱 빌드를 수행합니다. 배포하거나 Release를 만들지 않으며 권한은 읽기 전용입니다.
2. `.github/workflows/cd.yml` — 같은 저장소의 `main` push CI가 성공한 경우에만 실행합니다. CI가 검증한 정확한 SHA를 checkout하고 시작 시 최신 `main`인지 확인합니다. 실패한 CI·PR·fork·오래된 커밋의 재실행은 배포하지 않습니다.
3. CD가 고정 lockfile로 해당 SHA를 다시 빌드하고 원격 D1 마이그레이션 → API Worker → 웹 Worker를 배포합니다. `/v1/health`에서 API·DB 정상 응답을 확인한 다음 GitHub Release를 게시합니다.

CI는 새 커밋이 들어오면 오래된 검증을 취소합니다. CD는 `cd-production` concurrency group에서 직렬로 처리하고 진행 중인 배포를 새 push가 취소하지 않습니다. Cloudflare 토큰은 CD의 배포 단계에만 전달하며, GitHub 쓰기 권한은 CD의 Release 게시에 사용합니다. CI는 CD 산출물을 다운로드하지 않고, CD는 검증된 소스를 다시 빌드합니다.

배포 실패 시 CD의 `Re-run failed jobs`로 재시도할 수 있습니다. D1은 이미 적용한 마이그레이션을 다시 실행하지 않습니다. 배포는 성공했지만 상태 확인이나 Release 게시가 실패하면 CD는 실패로 표시되고 Release는 새로 게시되지 않습니다. 현재 `main`의 CD를 재실행하면 동일 커밋으로 재배포한 뒤 Release 게시를 다시 시도합니다. 구버전 rollback은 관리자가 별도로 수행하며 오래된 CI 재실행으로 우회하지 않습니다.

## Release 조회

[GitHub Releases](https://github.com/hyunhomon/teamplanet/releases)에서 성공한 production 배포를 조회합니다.

- 태그는 `production-<커밋 SHA 앞 12자리>`, 제목은 `Production · <짧은 SHA>`입니다. 수동 버전 증가나 별도 preview/prerelease를 사용하지 않습니다.
- 본문에는 서비스 주소, 전체 커밋 SHA, CI/CD 실행 링크, 배포 확인 시각, 마이그레이션과 health 확인 결과가 포함됩니다. 최초 생성 시 GitHub 자동 변경 내역도 추가합니다.
- 같은 SHA를 재배포하면 기존 Release의 배포 정보를 갱신하고 중복 Release를 만들지 않습니다. 기존 태그가 다른 커밋을 가리키면 덮어쓰지 않고 실패합니다.
- Release는 성공한 배포의 기록입니다. Release를 생성하는 행위가 배포를 시작하지 않으며, 소스 버전 복구만으로 DB 마이그레이션을 되돌릴 수는 없습니다.

GitHub 저장소 `hyunhomon/teamplanet`에는 다음 값을 설정합니다.

| 종류 | 이름 | 값 |
|---|---|---|
| Repository Secret | `CLOUDFLARE_API_TOKEN` | production 배포용 Cloudflare API 토큰 |
| Repository Variable | `CLOUDFLARE_ACCOUNT_ID` | 위 Cloudflare 계정 ID |

토큰 이름은 `teamplanet-github-production`이며 2027-10-24 만료입니다. 계정의 Workers Scripts/KV/D1 쓰기와 Account Settings 읽기, `cloby.co`의 Workers Routes/SSL 쓰기와 Zone/DNS 읽기 권한을 사용합니다. 만료 전에 동일 권한으로 갱신하여 GitHub Secret을 교체합니다. 로컬 `wrangler login` OAuth는 CI 자격 증명으로 복사하지 않습니다.

## Cloudflare 구성 확인 — 2026-10-26

- production Worker는 `teamplanet-web`, `teamplanet-api` 두 개입니다.
- `teamplanet.cloby.co` Custom Domain은 웹 Worker에 연결되어 있습니다. 루트 `cloby.co`는 기존 설정을 유지합니다.
- 웹에는 정적 자산 `ASSETS`, 세션 KV `SESSION`, 내부 API 서비스 `API`가 바인딩되어 있습니다. API에는 D1 `DB`가 바인딩되어 있습니다.
- D1은 `teamplanet-production`, KV는 `teamplanet-web-session`을 사용합니다. D1 초기 테이블과 동의 이력 트리거는 SQL 마이그레이션으로 관리합니다.
- 이 프로젝트의 Queue/Consumer, R2 바인딩, 실제 Slack·메일·모델 자격 증명은 아직 구성하지 않았습니다. 관련 구현 이슈에서 추가합니다. Workers preview URL과 `workers.dev`는 비활성화한 상태입니다.

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
