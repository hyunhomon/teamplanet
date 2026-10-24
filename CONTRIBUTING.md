# 협업 절차

사람과 코딩 에이전트 모두 [AGENTS.md](AGENTS.md)를 기준으로 작업합니다. Codex는 루트 지침을 사용하고, Claude Code·Gemini·Copilot·Cursor용 진입 파일도 같은 지침을 참조합니다. 다른 도구를 쓰면 작업 시작 프롬프트에서 `AGENTS.md`를 읽도록 지정하세요.

## 작업 흐름

1. 열린 이슈·마일스톤·진행 중 PR을 확인합니다. 이슈의 목표·범위·완료 조건과 담당자를 정하고, 실제 GitHub Milestone 필드에 열린 마일스톤을 지정합니다. 마일스톤은 `docs/DELIVERY_PLAN.md`의 단계에 맞춰 관리자가 준비합니다.
2. 최신 `origin/main`에서 `codex/<issue-number>-<short-description>` 브랜치를 만듭니다. 작업 전에 이슈 번호·마일스톤·변경 범위·검증 방법을 공유합니다.
3. 변경 후 `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`를 실행합니다.
4. `main`을 대상으로 PR을 열고 템플릿을 채웁니다. PR에도 이슈와 같은 열린 마일스톤을 지정하고, 본문에 아래처럼 실제 이슈를 연결합니다. 여러 이슈를 해결하면 한 줄에 하나씩 쓰며 모두 같은 마일스톤이어야 합니다.

   ```text
   Closes #123
   ```

5. CI와 동료 리뷰가 끝나면 병합합니다. 아직 완료 조건을 충족하지 못했다면 draft PR로 남깁니다.

## 최소 CI

`.github/workflows/ci.yml`은 PR과 `main` push에서 Ubuntu 작업 **하나**만 실행합니다. 의존성 캐시·빌드·배포·매트릭스는 추가하지 않습니다. Bun 버전은 `package.json`의 `packageManager`를 사용합니다.

- PR이면 GitHub API로 현재 PR과 연결 이슈의 실제 상태를 확인합니다. 이슈 누락, 닫힌 이슈, 마일스톤 누락·종료·불일치는 실패합니다. PR 번호를 이슈로 쓰거나 주석·코드 예제에만 번호를 넣어 통과시킬 수 없습니다.
- `bun install --frozen-lockfile` → `bun run typecheck` → `bun test`를 실행합니다. 테스트에는 실제 외부 모델 키나 학생 데이터가 필요하지 않습니다.
- PR 본문·PR 마일스톤 수정 시 다시 실행합니다. **연결 이슈의 마일스톤만 바꾼 경우**에는 Actions에서 해당 PR 실행의 `Re-run all jobs`를 선택하세요. 재실행은 최신 메타데이터를 다시 조회합니다.
- 토큰은 저장소·이슈·PR 읽기 권한만 가지며 PR 정책 단계에만 환경변수로 전달합니다. 이전 실행은 같은 PR의 새 실행이 시작되면 취소하고, 실행 제한은 5분입니다.

## 관리자의 최초 설정

파일의 에이전트 규칙은 작업 지침이고 CI는 검사 결과를 제공합니다. GitHub에서 병합·직접 푸시까지 차단하려면 저장소의 서버 설정이 필요합니다. 이 커밋은 해당 설정을 자동 변경하지 않습니다.

1. 이슈에 지정할 열린 마일스톤을 만들고 작업 이슈를 준비합니다.
2. 이 커밋을 push하여 CI를 한 번 실행합니다.
3. GitHub Settings → Rules → Rulesets 또는 Branches에서 `main` 보호 규칙을 만듭니다.
4. PR 필수, 동료 승인 최소 1명, 최신 커밋에서 필수 상태 검사 `checks`(워크플로 이름 `CI`) 통과를 요구합니다. force push와 브랜치 삭제는 허용하지 않습니다. 가능한 경우 병합 전에 브랜치를 최신 상태로 유지하도록 요구합니다.
5. 관리자 예외는 필요한 담당자로 제한합니다. `AGENTS.md`의 명시적인 직접 커밋 예외가 서버 보호 규칙을 우회하는 권한을 주지는 않습니다. 보호 규칙 사용 가능 여부는 저장소 공개 범위와 GitHub 플랜에 따라 다릅니다.

검사 구현은 PR 코드와 함께 실행되므로 규칙·CI 변경도 동료 리뷰 대상입니다. 변경 후 검사가 통과했어도 이슈/마일스톤이 바뀌었다면 병합 전에 다시 검사하세요.

공식 문서: [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Bun GitHub Actions](https://bun.sh/guides/runtime/cicd), [GitHub 브랜치 보호](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
