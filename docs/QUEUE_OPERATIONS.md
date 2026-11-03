# Queue 실행·복구 계약

#10은 공통 실행 기반이다. `slack.event` handler는 #11에서 등록했다(API_CONTRACT.md "Slack Events 수신"). `slack.history`(History 보정)는 #12에서 등록했다. AI 분석(#16/#20) handler는 아직 등록하지 않는다. 현재 등록된 `system.probe`는 합성 체크포인트만 저장하며 메일/Slack/AI/학생 데이터에 접근하지 않는다.

## 구성과 envelope

- 생산자: `apps/api`의 `WORK_QUEUE`, `@teamplanet/queue`의 `enqueueJob`.
- Consumer: `apps/consumer`, `teamplanet-consumer`. HTTP route·service binding·workers.dev·preview URL 없음.
- 단일 production 리소스: `teamplanet-jobs`, `teamplanet-jobs-dlq`, 기존 `teamplanet-production` D1. 웹→API 내부 service binding을 유지한다.
- 매분 Consumer cron이 D1의 미전송/전송 중단/만료 lease를 재확인해 outbox를 전송한다. 이 cron은 작업 전달 복구용이며 자동 주기 분석을 생성하지 않는다.
- `packages/contracts/src/jobs.ts`에 strict 런타임 스키마와 `jobKey`를 공유한다.

```json
{"version":1,"generation":0,"job":{"kind":"system.probe","probeId":"00000000-0000-4000-8000-000000000010"}}
```

| kind | job 필드 | 멱등 key |
|---|---|---|
| `system.probe` | `probeId`: UUIDv4 | `probe:<probeId>` |
| `slack.event` | `workspaceId`, `eventId` (`Ev…`), `eventRef` (`event_<UUIDv4>`) | `event:<workspaceId>:<eventId>` |
| `slack.history` | `requestId` (UUIDv4), `teamId`, `fromMs`, `toMs` (epoch ms, from < to) | `history:<teamId>:<requestId>` |
| `analysis.stage` | `runId` (`run_<UUIDv4>`), `stage`, `chunkId` | `run:<runId>:<stage>:<chunkId>` |

stage는 `collecting | evidence_extraction | assessment | review`, chunkId는 1–100자 영숫자/`_`/`-`이다. generation은 0으로 시작하고 검토된 복구 시에만 증가한다. 이벤트 원문은 동의·서명 검증을 통과한 저장소의 eventRef에서, 분석 입력은 run/chunk에서 읽는다. 큐와 원장에는 메시지 본문·이미지 원본·토큰·OTP를 복사하지 않는다. 이후 수집 저장소·동의 정책을 이 계약만으로 구현한 것으로 간주하지 않는다.

```ts
import { JobStore, enqueueJob } from "@teamplanet/queue";
// handler 등록 전 실제 수집/분석 요청을 보내지 않는다.
await enqueueJob(new JobStore(env.DB), env.WORK_QUEUE, {
  kind: "system.probe", probeId: crypto.randomUUID(),
});
```

생산자는 먼저 D1에 canonical job을 기록한 뒤 Queue에 전송한다. DB→Queue 사이에는 분산 트랜잭션이 없으므로 전송에 실패하면 요청은 실패하고 원장은 pending으로 남는다. 호출자가 같은 key로 재시도하거나 cron이 전송한다. 같은 key에 다른 참조 payload를 덮어쓰지 않는다. 전송 성공 여부가 불확실하면 중복 메시지가 생길 수 있으나 완료 작업은 다시 실행하지 않는다.

## 선점·체크포인트·완료

`queue_jobs`가 outbox이자 작업 원장이다. `pending → running → completed`, 일시 실패는 `retry`, 영구 실패/한도 초과는 `dead`다. `UPDATE … RETURNING` 하나로 선점하고 매 선점마다 임의 lease token과 실행 횟수를 부여한다. lease는 60초다. 병렬 메시지 중 하나만 실행하며 나머지는 실제 실행 횟수를 소비하지 않고 지연 재전달한다.

handler는 단계별 `context.checkpoint(name)`과 `context.commit(name, reference, writes)`를 사용한다. commit은 체크포인트 INSERT를 첫 SQL로, 애플리케이션 결과 저장을 뒤에 두어 같은 D1 batch 트랜잭션으로 실행한다. SQL 트리거가 실행 상태/generation/lease token/시각을 검사하므로 오래된 실행의 결과 저장은 전체 롤백된다. 같은 단계의 두 commit도 체크포인트 PK가 중복 쓰기를 막는다. 완료 체크포인트와 완료 상태 변경도 한 트랜잭션이다.

```ts
const handlers = {
  "analysis.stage": async (job, context) => {
    // 실제 구현은 매 실행/재개 시 소유권·동의·수집 범위와 입력 버전을 재검증한다.
    if (!await context.checkpoint("output")) {
      const result = await computeFromValidatedReferences(job);
      await context.heartbeat();
      await context.commit("output", result.reference, [saveResultStatement(result)]);
    }
  },
};
```

위 코드는 인터페이스 예시이며 이번에 분석 handler를 등록하지 않는다. 짧은 단계로 나누고 60초 전에 heartbeat를 갱신한다. 각 외부 호출에는 timeout을 둔다. lease가 만료되면 heartbeat/새 commit/완료를 거부한다. DB 쓰기는 반드시 commit의 `writes`에 넣고 별도 무보호 쓰기를 하지 않는다. checkpoint name은 소문자 시작 1–64자 영숫자/`_`/`-`, reference는 1–200자 영숫자/`_:/.-`의 불투명 참조다.

출력 저장 후 완료 전에 중단되면 다음 실행은 저장된 단계를 건너뛰고 완료한다. 완료 후 ACK 전에 중단되어도 재전달에서 handler를 호출하지 않는다. **외부 HTTP 호출까지 exactly-once를 보장하지 않는다.** 외부 요청 성공 후 checkpoint 전에 중단되면 호출이 반복될 수 있다. 후속 handler는 공급자의 멱등 키/조회 기능을 사용하고 반환 결과를 참조로 저장해야 한다. 오래된/철회된 입력의 checkpoint 무효화는 #14/#16에서 연결한다.

## 재시도와 실패 기록

| 경계 | 기술적 상한/동작 |
|---|---|
| 실제 handler 실행 | generation당 최대 5회. 중간 강제 중단의 lease 재선점도 1회로 계산 |
| 일시 오류 backoff | 2, 4, 8, 16…초, 기본 최대 3600초. provider Retry-After가 더 길면 원장에 그 시각까지 대기 |
| Queue 단일 지연 | 최대 86400초. 더 긴 provider 대기는 원장의 available_at으로 유지하고 조기 실행하지 않음 |
| 미완료 outbox 전송 | generation당 최대 20회. 전송과 선점 사이 중단도 포함 |
| 애플리케이션 DLQ 전송 | generation당 최대 5회. 모두 실패하면 dead 원장을 보존하고 운영자 복구 대기 |
| 플랫폼 재전달 | `max_retries: 4` (최초 포함 최대 5회), native DLQ 지정 |
| 운영자 복구 | 명시적인 단건 복구, 최대 3세대. 자동 DLQ→work 큐 순환 없음 |

이 상한은 장애 복구의 기술적 한계이며 앱 비용 예산/모델 폴백을 추가하지 않는다. `JobError(code, retryable, retryAfterSeconds?)`로 일시/영구 실패를 구분한다. 예상하지 못한 예외는 `HANDLER_FAILURE`로 제한 재시도하고 원문 예외 문자열을 저장하지 않는다. 공급자 잔액/키 한도 402는 `PROVIDER_BILLING_BLOCKED`/영구 실패로 연결하며, 명시적 Retry-After가 있는 in-flight 제한만 후속 어댑터가 일시 실패로 분류한다.

`job_failures`는 key/generation/attempt/code/retryable/시각, `queue_rejections`는 message ID/고정 오류 코드/시각만 저장한다. 알 수 없는 schema/kind는 성공 ACK하지 않고 제한 재전달 후 native DLQ로 간다. 알려진 kind라도 handler가 미등록이면 `HANDLER_UNREGISTERED`/dead 기록 후 DLQ 전송한다. 이때 ACK는 **격리 완료**이며 작업 성공이 아니다. DLQ 전송 장애에도 dead 원장은 남는다. DB 장애는 성공 ACK하지 않는다.

## 운영 관찰과 DLQ 복구

Cloudflare Queues 대시보드에서 work backlog, DLQ, Consumer 실패를 확인한다. D1에서는 본문을 출력하지 않고 다음 metadata를 조회한다.

```sql
SELECT job_key, generation, status, attempts, dispatches, error_code, dlq_attempts, dead_lettered_at
FROM queue_jobs WHERE status = 'dead' ORDER BY updated_at;
SELECT message_id, code, recorded_at FROM queue_rejections ORDER BY recorded_at;
SELECT job_key, generation, attempt, code, retryable FROM job_failures ORDER BY recorded_at;
```

1. 장애 원인, 현재 handler 배포, 대상 참조의 유효성·동의·권한을 확인한다. unknown schema는 생산자를 수정하고 raw payload를 그대로 다시 보내지 않는다.
2. 원장의 상태/현재 generation을 확인한다. 완료 작업은 재실행하지 않는다. pending/retry/실행 중 또는 만료 lease는 dispatcher가 복구하며, 임의로 상태/횟수를 초기화하지 않는다.
3. dead 작업만 아래 명령으로 한 건씩 복구한다. `--generation`은 조회한 현재 값, `--reason`은 검토 이슈/티켓의 불투명 참조다. SQL 트리거가 dead/세대/상한 확인·감사 기록·pending 전환을 한 작업으로 수행한다. checkpoint와 이전 실패 이력은 유지한다.

```sh
# 기존 로컬 DB 또는 --persist-to로 지정한 로컬 DB
bun run jobs:recover --local --key probe:00000000-0000-4000-8000-000000000010 --generation 0 --reason issue-10
# 승인된 운영 복구: 환경에 production 계정과 D1 권한 토큰이 있어야 한다.
bun run jobs:recover --remote --key probe:00000000-0000-4000-8000-000000000010 --generation 0 --reason issue-10
```

복구 후 cron이 새 generation을 전송한다. 과거 DLQ 메시지는 이전 generation이므로 재실행하지 않는다. 새 세대의 완료/체크포인트를 확인한 뒤 Cloudflare에서 해당 DLQ 항목을 ACK한다. 전체 DLQ purge/자동 일괄 replay를 하지 않는다. DLQ 발행 후 D1 기록 전에 중단되면 DLQ에도 중복이 있을 수 있으므로 key/generation으로 비교한다.

native DLQ에만 있고 DB 장애로 원장 생성도 실패한 유효 메시지는 원본 참조 envelope를 공유 스키마로 검증한 뒤 운영자가 work 큐로 단건 재발행할 수 있다(generation 0). Consumer가 원장을 생성한다. 이미 원장이 있으면 위 상태별 절차를 따른다. 알 수 없는/민감 정보 포함 payload는 그대로 재발행하지 않고 생산자·저장소 참조를 수정한다. DLQ는 영구 저장소가 아니므로 provider의 보존 기간 전에 metadata를 점검한다. 작업 원장/실패 이력의 운영 보관 정책은 별도 정책 결정에 따른다.

## 로컬·CI·production 검증

```sh
bun install --frozen-lockfile
bun test
bun run queue:verify:local
bun run typecheck
bun run build
```

`queue:verify:local`은 실행별 `node_modules/.cache/queue-local-*`에 빌드/상태를 격리한다. 실제 Consumer와 생산자 harness를 Workerd/Miniflare에서 실행하고 D1 migrations를 적용한다. 로컬 wrapper는 실제 Consumer 처리 후 수신 metadata를 기록하여 FIFO 순서를 가정하지 않고 중복 메시지가 실제 처리되었는지 확인한다. 정상 큐 왕복·완료 재전달·미등록 handler의 애플리케이션 DLQ·unknown envelope의 native retry→DLQ를 검증한다. wrapper·생산자 harness·DLQ 관찰 Worker는 로컬 테스트 전용이며 production에는 배포하지 않는다. 테스트 후 runtime을 종료한다. 플랫폼 로컬 Consumer 자동 확장은 지원되지 않으므로 병렬 선점/중간 중단/lease 경합은 SQLite 트랜잭션 테스트로 별도 검증한다.

일반 로컬 개발에서 API/Consumer를 함께 실행하려면 `bunx wrangler dev -c apps/api/wrangler.jsonc -c apps/consumer/wrangler.jsonc --persist-to .wrangler/state`를 사용한다. 웹은 별도 `bun run --cwd apps/web dev`로 실행한다. 로컬 migration도 같은 persist 경로를 사용한다.

CD는 같은 검증 SHA로 큐 준비 → D1 migration → Consumer → API → 웹 순서로 배포하고 합성 production probe와 health를 검증한 뒤 GitHub Deployment 결과를 기록한다. 운영 smoke는 `bun run queue:smoke:production`이며 현재 CD 토큰으로 동일 probe를 두 번 발행하고 최대 30회 D1 완료/실행 1회/체크포인트 2개를 확인한다. 외부 메일/Slack/AI/학생 자료를 사용하지 않는다. 이번 PR 검증에서는 production에 실행하지 않으며 첫 main CD에서 결과를 확인해야 한다.

근거: [Queue 재시도·ACK](https://developers.cloudflare.com/queues/configuration/batching-retries/), [DLQ](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/), [로컬 개발](https://developers.cloudflare.com/queues/configuration/local-development/), [D1 batch 트랜잭션](https://developers.cloudflare.com/d1/worker-api/d1-database/).
