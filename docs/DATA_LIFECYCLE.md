# 데이터 무효화·삭제 운영 (#14)

승인 정책은 [PRIVACY_AND_DATA](PRIVACY_AND_DATA.md)와 ADR-0002다. 원문/이미지는 저장하지 않는다. 기존 평가 컬럼과 동의 이력 트리거는 신규 migration 0013에서도 보존한다.

## 사용 중지와 무효화

`team_data_versions.epoch`는 원본 revision/내용 지문/삭제, 이미지 지문, 동의·참가 범위 변경 시 증가한다. 보수적으로 해당 팀의 모든 실행(교수 확정본 포함)을 `run_data_validity.invalidated_at`으로 영구 무효화한다. 같은 버전을 다시 유효화하지 않고 허용된 자료로 새 실행을 만든다. 기존 실행에 validity 행이 없으면 유효하다고 간주하지 않는다.

`runValidityGuard`, `dataEpochGuard`, `processingWriteGuard`, `sourceWriteGuard`는 후속 저장 트랜잭션에 함께 넣는다. 모델 전송 직전과 원문 열람·확정·출력 직전에는 현재 Slack 원문을 재검증해야 한다. API/Slack 장애는 삭제 증거가 아니며 `SLACK_UNAVAILABLE`로 분리한다. 실제 원문 변경·삭제를 발견하면 저장된 지문과 관련 결과를 무효화한다. 요약 불일치는 별도 무효화 API로 기록한다. 이미 전달한 출력물은 회수할 수 없으므로 후속 리포트 UI에서 정정 안내가 필요하다 (#22/#23/#31).

철회는 해당 작성자 참조를 tombstone으로 만들고 이미지 지문도 제거한다. 재동의가 과거 tombstone을 복구하지 않는다. 실행 중 `analysis.stage` 작업은 lease를 폐기한다. 오래된 checkpoint/재전달도 현재 동의·epoch·source guard를 통과해야 한다. Queue에는 본문이 없으며 Cloudflare 전달 자체를 회수하는 대신 저장/사용을 차단한다.

새 수집은 수업 종료 시 중단한다. 수업 종료 뒤에도 보관 만료 전까지 현재 동의와 허용된 과거 수집 구간이 확인된 자료만 재검증할 수 있다. `processingWriteGuard`는 수집 허가를 부여하지 않는다.

## 소유 교수 운영 API

모두 `/v1` 아래이며 교수 세션·Origin·소유권 검사와 기존 오류 형식을 사용한다. 다른 교수/없는 팀은 동일한 404다. 런타임 계약은 `packages/contracts/src/lifecycle.ts`다.

| 경로 | 요청 | 결과 |
|---|---|---|
| GET `/teams/:teamId/data-status` | 없음 | epoch, blockedAt, purgedAt, invalidatedRuns, erasure 상태 |
| POST `/teams/:teamId/data-invalidation` | `{reason:"summary_mismatch"}` 또는 `source_unverified` | 200 상태; 확정본 포함 재분석 필요 |
| POST `/teams/:teamId/data-erasure` | `{reason:"request"}` | 202; 즉시 차단, cron에서 물리 삭제 |
| POST `/teams/:teamId/data-erasure/retry` | `{}` | 실패 작업만 202로 재시도 예약; 없으면 409 |

`blockedAt` 이후 원문·첨부 접근/신규 저장과 팀 재활성화가 차단된다. `purgedAt`은 원문 참조·이미지 metadata·평가/근거/요약·관련 동의/감사/Queue 체크포인트 삭제가 한 트랜잭션에서 완료된 시각이다. 삭제 전에는 개별 결과 무효화 수를 제공한다. 삭제 중/실패는 `erasure.status`와 원문 없는 `ERASURE_FAILED`로 추적한다.

## 만료·복구

기존 Consumer cron(매분)이 수업 실제 종료 시각에서 **UTC 달력 3개월**(대상 월 말일로 clamp) 지난 팀을 정리한다. 90일이 아니다. 만료 시각부터 guard가 접근을 막아 cron 지연으로 열람 기간이 늘지 않는다. 50팀씩 처리하며 후속 cron이 나머지를 처리한다. 실패해도 outbox dispatch는 별도로 진행한다.

조기 삭제도 같은 경로를 쓴다. 삭제는 원자적·멱등적이다. 60초 claim 만료 후 중단 작업을 재개하고, 5회까지 지수 지연 재시도한다. 그 뒤 소유 교수의 retry API로 원인을 해결한 작업을 다시 예약할 수 있다. 실패/중단 중에도 차단 상태를 유지한다. 성공 receipt도 수업 만료 시 제거하며 별도 무기한 감사 이력 예외를 만들지 않는다. 팀/수업/명부 설정과 재사용 방지용 blocked/purged 플래그는 남으며 학생 문의의 별도 n일 삭제는 #30이다.

검증: `tests/data-lifecycle.test.ts`의 합성 SQLite 실제 migration, 월말/윤년, 철회 중 lease, 확정본 무효화, 다른 교수, 트랜잭션 실패·중단·병렬 재시도·만료 receipt 제거. 실제 Slack 운영 변경이나 실제 학생 삭제는 수행하지 않았다.
