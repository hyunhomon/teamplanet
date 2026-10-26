# Architecture

```text
Bun Workspaces
├─ apps/web          Astro SSR + React islands + Tailwind (교수 UI 초기 구조)
├─ apps/api          Hono, Cloudflare Worker + D1 (API 초기 구조)
├─ apps/consumer     Queue/cron Consumer (합성 probe, 후속 handler 등록 지점)
├─ packages/contracts   공통 API/평가 타입, Zod 검증, 합성 fixture
├─ packages/ai-core     OpenRouter 어댑터의 기초 정책/에러 타입
├─ packages/queue       D1 outbox/lease/checkpoint, producer/consumer, 재시도/DLQ 복구
└─ packages/db          Drizzle + D1 소유권/매핑 schema와 SQL migrations

Cloudflare D1 ← API Worker → Cloudflare Queues → Analysis Consumer Worker
                        ↕                            ↕
                    Slack API                    OpenRouter (3 models)
```

웹 경로는 `teamplanet.cloby.co → web Worker → /v1/* service binding → api Worker → D1`을 유지한다. 환경 분리 없이 production만 운영하며 API와 Consumer는 공개 URL이 없다. #10 배포 경로는 큐 준비·마이그레이션·Consumer·API·웹 순서이며 실제 리소스 생성/production smoke는 CD 결과로 확인한다. Consumer에는 합성 probe만 등록되어 있으며 Slack 수집·분석 handler는 후속 이슈 범위다. 상세 운영은 `DEPLOYMENT.md`, 실행·재시도·DLQ 복구 계약은 `QUEUE_OPERATIONS.md`를 참조한다.

## 배치/비동기

- Slack 수집(webhook/event)는 요청을 빠르게 검증·접수하고 비동기 저장한다.
- 분석 실행 요청은 DB에 `analysis_runs`를 생성하고 Queue로 전달한다.
- Consumer는 지정 기간의 채널 데이터 조회, 스레드 문맥 복원, 이미지 첨부 참조, 모델 호출, JSON 검증, 근거 ID 대조, 결과 저장을 수행한다.
- Worker CPU/실행시간 및 Queue 메시지 크기를 고려해 chunk 단위로 나눈다. 대용량 이미지 원본은 D1에 넣지 않으며 필요할 경우 R2 사용을 별도 결정한다.
- 같은 `run_id:stage:chunk`는 멱등 처리하여 재시도 중복을 방지한다.
- D1 `queue_jobs`에 전송 전에 참조 envelope를 기록한다. 매분 dispatcher는 누락 전송과 만료 lease를 제한된 횟수로 재전송한다. 원자적 lease 선점과 체크포인트/결과 저장 트랜잭션으로 병렬 전달·중간 중단·오래된 실행의 중복 저장을 막는다. 외부 HTTP 호출 자체는 exactly-once가 아니므로 후속 handler는 공급자 멱등 키와 소유권·동의 재검증을 연결해야 한다.

## 프라이버시 아키텍처

- 소유권은 `professors → courses → teams`, 학생은 수업 단위 ID로 구분한다. Slack 계정은 `(workspace_id, slack_user_id)`로 식별하고 수업별 student에 연결한다. 복합 FK로 다른 수업 학생의 팀 연결을 거부한다.
- 단일 workspace와 팀 이름/공식 채널 중복 제약을 DB에서 적용한다. 기존 소유권 미지정 팀은 NULL course로 보존하고 교수 조회·후속 수집에서 기본 거부한다. 상세 계약과 레거시 이관 경계는 `API_CONTRACT.md`, 로컬 D1 검증은 `packages/db/README.md`를 참조한다.

- Slack Bot OAuth token, OpenRouter key는 Worker secrets.
- 원문 메시지는 최소 필요 범위로 저장/접근 제어한다.
- Slack permalinks는 교수 권한과 별개로 열람 가능 여부가 달라질 수 있으므로 **내부 evidence ID**를 주키로 쓴다.
- 결과물에 포함된 AI 문장은 교수 최종 평가와 별도로 저장한다.
- 비동의 처리 및 철회 시 데이터 접근·삭제·재분석 방침은 `PRIVACY_AND_DATA.md` 참조.

## 앱 비용 정책

- **제거**: 예상 사용료 검사, 실사용료 합계 상한, 일일/월별 지출 제한, 입력 컨텍스트를 비용 때문에 자르는 규칙.
- **유지**: 모델 provider의 한도/컨텍스트 오류, Slack 제한, 정상적인 전송 크기/타임아웃/재시도 상한. 이는 기술적 안정성 장치이며 금액 예산이 아니다.
- OpenRouter 402일 때 분류하고 사용자에게 정확한 이유를 보인다. 402를 '저예산 모델로 자동 폴백'하지 않는다.
