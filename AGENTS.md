# TeamPlanet agent rules

이 규칙은 이 저장소를 수정하는 모든 코딩 에이전트에 적용한다. 다른 도구 전용 지침은 이 파일을 참조하며, 협업 절차의 단일 기준은 이 파일이다.

## 작업 시작 전 — 필수

1. `git status --short`, 현재 브랜치와 remote를 확인한다. 다른 사람의 미커밋 변경을 덮어쓰지 않는다.
2. `README.md`, `docs/DELIVERY_PLAN.md`, 변경 영역의 설계 문서를 읽는다.
3. GitHub의 열린 이슈, 열린 마일스톤, 진행 중 PR을 조회한다. GitHub CLI 또는 연결된 GitHub 도구를 사용한다.

   ```sh
   gh issue list --state open --limit 100 --json number,title,assignees,milestone
   gh api --paginate repos/{owner}/{repo}/milestones --jq '.[] | {number,title,state}'
   gh pr list --state open --json number,title,headRefName,baseRefName
   gh issue view <number> --json number,title,body,state,assignees,milestone
   ```

4. 작업 대상의 **열린 이슈**, 그 이슈에 지정된 **열린 마일스톤**, 완료 조건과 의존성을 확인한다. 기존 담당자·PR과 작업이 겹치지 않는지 확인한다. 목록이 잘렸으면 필요한 페이지도 조회한다.
5. 구현 전에 이슈 번호, 마일스톤 이름, 이번 변경 범위와 검증 방법을 짧게 알린다. 대상 이슈나 마일스톤이 없거나 GitHub 조회가 불가능하면 이를 보고하고, 확인될 때까지 구현을 시작하지 않는다. 번호·담당자·마일스톤을 추측하거나 확인했다고 허위 보고하지 않는다.

## 브랜치와 PR — 기본 경로

- 최신 `origin/main`을 기준으로 `codex/<issue-number>-<short-description>` 작업 브랜치를 만든다. 기존에 해당 이슈를 위한 브랜치/PR이 있으면 이어서 사용한다.
- 한 PR은 연결된 이슈의 완료 조건에 집중한다. 무관한 리팩터링을 섞지 않는다.
- `main` 직접 커밋·푸시, 강제 푸시, PR 자동 병합은 기본적으로 금지한다. **저장소 관리자가 현재 작업에 대해 명시적으로 지시한 경우에만** 해당 지시 범위에서 예외로 처리한다. 이전 작업의 예외를 다음 작업에 재사용하지 않는다.
- 관리자가 이번 작업을 이슈 없이 `main`에 직접 커밋하라고 명시하면 작업 시작 게이트도 그 범위에서 예외로 처리한다. 일반 PR의 CI 정책에는 예외나 우회 라벨을 추가하지 않는다.
- PR base는 `main`이다. `.github/pull_request_template.md`를 채우고, 실제 해결할 이슈마다 본문에 `Closes #123` 형태의 독립된 줄을 작성한다. 같은 저장소의 이슈만 연결한다.
- 이슈의 열린 마일스톤을 확인하고 PR에도 동일 마일스톤을 지정한다. 여러 이슈를 해결하면 같은 마일스톤에 속한 이슈만 묶는다.
- PR은 문제와 변경된 동작, 검증 결과, 남은 한계를 설명한다. 완료 조건을 충족하지 못하면 draft로 남기고 미완료 항목을 명시한다.
- CI가 실패하면 원인을 수정한다. 이슈/마일스톤 누락을 숨기거나 CI를 약화해 통과시키지 않는다. 리뷰와 필수 검사가 끝나기 전에 병합하지 않는다.

## 구현과 검증

- Node.js 24와 저장소에 지정된 Bun 버전을 사용한다. 설치는 `bun install --frozen-lockfile`, 검증은 `bun run typecheck`, `bun test`, `bun run build`를 사용한다. 의존성을 바꾸면 `bun.lock`도 갱신한다.
- `main` push는 production 자동 배포를 유발한다. 배포 구성 변경 전 `docs/DEPLOYMENT.md`를 읽고 production 단일 환경과 내부 API service binding을 유지한다.
- 동작 오류 수정에는 해당 오류를 재현하는 테스트를 추가한다. 문서만 바꾸는 작업에 구현을 그대로 복제하는 테스트는 만들지 않는다.
- DB 변경은 Drizzle 스키마와 SQL 마이그레이션을 함께 반영한다. 동의 이력 트리거를 보존한다. 평가의 근거·한계·사람 검토 필요 정보를 누락하지 않는다.
- 동의 전 수집 금지, 지정 채널 한정, 교수 최종 평가, 공급자 402 분류를 유지한다. 앱 자체 비용 제한이나 모델 자동 폴백을 임의로 추가하지 않는다.
- 비밀 값과 실제 학생 대화를 커밋하거나 테스트 fixture로 사용하지 않는다.
- 완료 보고에 이슈/PR, 변경 요약, 실행한 검사 결과를 남긴다. 실행하지 않은 검사를 통과했다고 쓰지 않는다.

## Code Review Rules

- 이슈의 완료 조건과 마일스톤 범위를 벗어난 변경, 근거 없는 평가, 동의 게이트 우회, 감사 이력 유실을 지적한다.
- 에이전트 규칙·CI·마이그레이션 변경은 검증 절차나 데이터 보호 요구를 약화하지 않는지 확인한다.
