# DB 계약과 업그레이드 검증

소유권/ID/API 규칙은 [API_CONTRACT.md](../../docs/API_CONTRACT.md)를 따른다. Drizzle schema는 `src/schema.ts`, 실제 적용 경로는 `migrations/*.sql`이다. `0000`/`0001`과 기존 동의 이력 트리거를 수정하지 않는다. `0002`는 테이블 추가·`teams.course_id` 추가·UNIQUE 인덱스·레거시 호환 참조 트리거만 적용한다.

## 자동 테스트

Node.js 24, Bun 1.3.14에서 저장소 루트 기준으로 실행한다.

```sh
bun install --frozen-lockfile
bun test packages/contracts packages/db
bun run --cwd packages/db verify:upgrade
```

`schema.test.ts`는 FK를 켠 메모리 SQLite에서 교수 두 명의 수업·팀·학생 조회, 다른 수업 학생/잘못된 workspace/중복 매핑·팀·채널 거부를 검증한다. 업그레이드 테스트는 실제 `0000` → 합성 데이터 삽입 → `0001` → 철회 → 신규 migration을 순서대로 실행한다. 평가·run·근거·메시지의 모든 필드와 동의 이력 ID/시각을 전후 비교하고 INSERT/UPDATE 이력 트리거가 계속 작동하는지 확인한다. 여러 workspace가 있으면 변경 전체가 롤백되는지도 확인한다.

`verify:upgrade`는 Wrangler와 로컬 D1을 사용하여 같은 업그레이드 경로를 검증한다. `node_modules/.cache/contracts-d1-upgrade-*`에 실행별로 독립된 Wrangler 설정/DB/로그/합성 seed를 만들며 production 설정과 기존 `.wrangler/state`를 사용하지 않는다. 모든 D1 호출은 `--local --persist-to`이고 원격 API/메일/Slack/AI/production DB를 호출하지 않는다. 평가·동의 데이터 보존, 감사 트리거, 교수 두 명의 소유권, 단일 workspace 거부, `foreign_key_check`, 재실행 시 이력 중복 방지를 검증한다. 실패 시 해당 실행 디렉터리와 로그를 보존한다. 일반 `bun test`는 CLI/로컬 서버 실행 없이 동작한다.

합성 레거시 SQL은 `fixtures/legacy-upgrade.sql`, 신규 API 합성 데이터는 `@teamplanet/contracts/fixtures`다. 레거시 ID는 의도적으로 신규 공개 API ID 규칙과 다르다.

## 데이터 이관 경계

기존 팀의 `course_id`는 NULL이다. 교수·수업을 자동 생성하거나 임의 배정하지 않으며 소유권 조인으로 접근할 수 없다. 기존 평가와 동의 이력은 그대로 보존한다. 새 팀은 수업과 기존 workspace가 필수이며 소유권이 있는 팀의 course를 NULL로 지울 수 없다. workspace 삭제/ID 변경도 참조 팀이 있으면 거부한다. `teams.workspace_id` 참조는 재생성을 피하기 위한 SQL 트리거이며 Drizzle FK로 표시되지 않는다.

단일 workspace 또는 팀 이름/채널 중복 제약과 충돌하는 레거시는 migration을 실패시킨다. 자동 삭제/병합하지 않는다. 실제 이관은 소유권·ID·충돌 해결 근거를 검토한 별도 변경으로 진행한다. `consents`/평가 테이블에 신규 FK를 소급 적용하지 않았으므로 후속 API는 팀 소유권·학생 멤버십을 반드시 검증해야 한다. DB 제약만으로 HTTP 인증/권한/동의 gate가 구현된 것은 아니다.

schema 변경 후 `bun run db:generate`를 실행한다. SQL의 참조 트리거와 기존 `consents_audit_insert`/`consents_audit_update`도 검토한다. `drizzle-kit push`는 트리거 설치를 보장하지 않는다. 이번 검증은 production 데이터 조회나 배포를 포함하지 않는다.
