# AI Orchestration — Three Model Pipeline

## 결정

3개의 독립 OpenRouter 모델을 단계별 사용한다. **모델명은 환경변수 주입**이며 운영 중 교체 가능하다. 이전 비교에서 결정한 구체적인 세 모델 ID는 이번 대화에 확인 가능한 형태로 남아 있지 않아 임의로 채우지 않았다.

| 단계 | 환경변수 | 책임 | 입력 | 출력 |
|---|---|---|---|---|
| A. Evidence extraction | `OPENROUTER_MODEL_EVIDENCE` | 대화 사건 식별, 문맥·이미지 해석, 원문 근거 추출 | 기간별 스레드·메시지·이미지 | `evidence_events[]` |
| B. Assessment | `OPENROUTER_MODEL_ASSESSOR` | 학생별 4개 역량에 대해 행동 기반 정성 평가 | 원문+사건+루브릭 | `assessments[]` |
| C. Review | `OPENROUTER_MODEL_REVIEWER` | 환각·인용 오류·말수 편향·반례·과도한 단정 탐지 | 원문+1·2단계 출력 | 검토 결과·수정 요구·최종 후보 |

## 설계 원칙

1. **전체 채널 분석**은 표본 대화만 골라 읽는다는 뜻이 아님. 긴 기간은 모든 메시지를 chunk 처리하고, 각 사건의 주변 대화까지 문맥으로 준다.
2. **4개 역량별 점수 자동 확정 금지**: 관찰된 행동, 근거, 반례, 불확실성을 적는다. 교수 최종 결정.
3. 모든 평가 주장에는 `message_id[]`가 있어야 한다. 원문에 없는 인용/행위는 무효.
4. 활동량과 품질을 분리한다. 답이 없거나 관찰 기회가 없으면 `insufficient_evidence`.
5. 이미지가 분석 범위일 때 비전 입력을 지원하는 세 모델로 설정해야 한다. 실제 모델 capabilities는 배포 전 확인.
6. 단계별 결과 JSON schema 검증과 evidence ID 정합성 확인.
7. 모델 간 판단 불일치는 `needs_human_review` 플래그. 무조건 다수결이나 평균 점수로 합치지 않음.

## 원문 비보관과 입력·결과 버전 — #5

원문/이미지의 장기 저장소는 Slack이다. 분석 실행마다 허용 기간 전체를 History/Replies로 조회해 메모리에서 chunk 처리하고 서비스에는 링크·원문 revision/지문·범위 metadata·요약·결과를 남긴다. 원문 chunk/전체 Events payload를 DB·Queue·DLQ·로그·영구 checkpoint에 남기지 않는다. 재개는 참조 재조회와 revision 확인 후 진행한다. Slack에서 사라진 원문은 복원할 수 없으며 전체 coverage의 누락과 한계로 기록한다.

리포트 열람·확정·출력 전 현재 원문과 요약을 검증한다. 수정·삭제·불일치는 근거 링크 제외·영향받은 초안/교수 확정본 무효화·새 버전 재분석으로 연결한다. 링크만 삭제하고 근거 없는 판단을 유지하지 않는다. Slack 장애/권한 오류는 삭제와 구분하고 검증 불가 결과를 최신으로 확정하지 않는다. 저장 요약·리포트는 수업 종료 후 3개월에 삭제한다.

실행 중 모델에 원문을 보내는 사실은 고지한다. 식별자/이미지 가림 수준 및 선택 모델별 보관·학습 사용·처리 지역은 #15와 시작 전 확인 항목이다. 운영자의 저장 전략 승인을 이 외부 전송 세부 사항의 승인으로 추정하지 않는다. 상세 상태표는 [운영 정책](PRIVACY_AND_DATA.md)을 따른다.

## 비용 및 OpenRouter 오류

- 클라이언트·서버 자체 `budget_usd`, `max_cost`, `token_quota`, `monthly_cap`, `cost_guardrail`을 적용하지 않는다.
- OpenRouter가 HTTP 402를 반환하면 `error.metadata.limit_source`로 분류한다:
  - `openrouter_credits`: 계정/요청에 사용할 크레딧 부족. 분석을 `blocked_provider_billing`으로 멈춤.
  - `openrouter_key_limit`: 키 자체 크레딧 제한. 동일 처리.
  - `openrouter_in_flight_budget`: OpenRouter 동시 실행 예산 제한. `Retry-After`가 있으면 지시대로 지연 후 재시도 가능. 이것은 **OpenRouter 자체 제한**, 앱 자체 예산이 아님.
- 401/403/429/502/503은 각각 자격증명/권한·정책/속도/공급자 장애로 분류한다.
- `max_tokens`는 API/모델에서 요구할 때 출력 형식과 context management를 위해 쓰는 기술적 설정이지 앱 예산 상한이 아니다. 불필요하면 지정하지 않는다.
- 한 단계에서 공급자 빌링 402 발생 시 다른 유료 모델로 우회하지 않는다.

## 모델 교체 검증 체크리스트

- OpenRouter 공식 모델 ID 유효성 및 vision input 지원
- 한국어 스레드·인터랙션·코드 스위칭 처리
- Structured JSON 출력 안정성
- original `message_id` 인용 정합성
- 장문 처리/긴 스레드 누락률
- 평가자 간 방향성 일치 및 반례 감지율

## 구현 의사코드

```ts
const evidence = await openrouter.complete(MODEL_EVIDENCE, fullContext);
const events = validateEvidence(evidence, validatedSourceIds); // authorized, ephemeral Slack input
const assessed = await openrouter.complete(MODEL_ASSESSOR, { fullContext, events, rubric });
const review = await openrouter.complete(MODEL_REVIEWER, { fullContext, events, assessed });
const results = reconcileWithEvidence(review, validatedSourceIds); // unknown id/revision => reject
await saveDraftAssessment(runId, results); // professor finalizes later
```

OpenRouter 오류 출처: https://openrouter.ai/docs/api/reference/errors-and-debugging 및 https://openrouter.ai/docs/api/reference/limits
