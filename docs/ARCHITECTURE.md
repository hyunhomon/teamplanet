# Architecture

```text
Bun Workspaces
├─ apps/web          Astro SSR + React islands + Tailwind (교수 UI) [직접 scaffold]
├─ apps/api          Hono, Cloudflare Worker (OTP/Slack/API) [직접 scaffold]
├─ packages/contracts   공통 API/평가 타입
├─ packages/ai-core     OpenRouter 어댑터의 기초 정책/에러 타입
└─ packages/db          Drizzle + D1 schema 초안

Cloudflare D1 ← API Worker → Cloudflare Queues → Analysis Consumer Worker
                        ↕                            ↕
                    Slack API                    OpenRouter (3 models)
```

## 배치/비동기

- Slack 수집(webhook/event)는 요청을 빠르게 검증·접수하고 비동기 저장한다.
- 분석 실행 요청은 DB에 `analysis_runs`를 생성하고 Queue로 전달한다.
- Consumer는 지정 기간의 채널 데이터 조회, 스레드 문맥 복원, 이미지 첨부 참조, 모델 호출, JSON 검증, 근거 ID 대조, 결과 저장을 수행한다.
- Worker CPU/실행시간 및 Queue 메시지 크기를 고려해 chunk 단위로 나눈다. 대용량 이미지 원본은 D1에 넣지 않으며 필요할 경우 R2 사용을 별도 결정한다.
- 같은 `run_id:stage:chunk`는 멱등 처리하여 재시도 중복을 방지한다.

## 프라이버시 아키텍처

- Slack Bot OAuth token, OpenRouter key는 Worker secrets.
- 원문 메시지는 최소 필요 범위로 저장/접근 제어한다.
- Slack permalinks는 교수 권한과 별개로 열람 가능 여부가 달라질 수 있으므로 **내부 evidence ID**를 주키로 쓴다.
- 결과물에 포함된 AI 문장은 교수 최종 평가와 별도로 저장한다.
- 비동의 처리 및 철회 시 데이터 접근·삭제·재분석 방침은 `PRIVACY_AND_DATA.md` 참조.

## 앱 비용 정책

- **제거**: 예상 사용료 검사, 실사용료 합계 상한, 일일/월별 지출 제한, 입력 컨텍스트를 비용 때문에 자르는 규칙.
- **유지**: 모델 provider의 한도/컨텍스트 오류, Slack 제한, 정상적인 전송 크기/타임아웃/재시도 상한. 이는 기술적 안정성 장치이며 금액 예산이 아니다.
- OpenRouter 402일 때 분류하고 사용자에게 정확한 이유를 보인다. 402를 '저예산 모델로 자동 폴백'하지 않는다.
