# 분석 실행·단계 계약 v1 (#16)

#20에서 실제 A/B/C handler·정규화 결과·공급자 오류/복구를 연결했다. 현재 동작과 신규 artifacts API는 [ANALYSIS_PIPELINE](ANALYSIS_PIPELINE.md)을 따른다. 아래는 #16의 기반 계약이며 당시 후속 작업으로 표시한 B/C adapter도 #18/#19에서 구현됐다.

지훈 선배(#18 B)·민지 선배(#19 C)는 `@teamplanet/contracts`와 **`@teamplanet/contracts/analysis-fixtures`**를 사용한다. 실제 모델 호출 없이 `tests/analysis-contracts.test.ts`의 A/B/C·수정 요구/응답·실패 fixture를 실행할 수 있다. 공유 schema는 `packages/contracts/src/analysis.ts`, fixture는 `packages/contracts/src/analysis-fixtures.ts`다. #17은 A adapter, #18/#19는 B/C adapter, #20은 전체 실행/결과 저장/오류 재시도 연결이다. 이 PR은 B/C나 통합 실행을 제공하지 않는다.

## 고정 버전과 범위

| 항목 | v1 |
|---|---|
| 단계 JSON | `analysis-stages-v1` |
| 참조 manifest | `dataset-manifest-v1` |
| chunk 계획 | `qwen-chunks-v1` |
| 선택 루브릭 | `communication-v1`, 교수가 선택한 1~4개만 |
| 모델/프롬프트 | `qwen-pilot-v1` / `communication-prompts-v1` |
| 각 역할 설정 | `qwen/qwen3.5-9b` / `deepinfra/bf16`, ZDR·fallback 금지 |

설정 snapshot의 configuredModel/Provider는 요청 경로다. 실제 호출이 없는 단계의 실제 공급자 수신을 주장하지 않는다. `analysis_stage_results`에는 실제 응답에서 검증한 model/provider/promptVersion을 기록해야 하며 #20에서 연결한다. 역할은 별도 호출이며 모델 다양성을 뜻하지 않는다.

OpenRouter [공개 endpoint metadata](https://openrouter.ai/api/v1/models/qwen/qwen3.5-9b/endpoints)를 2026-11-04 재확인했다. 지정 경로 context 262144·최대 completion 81920·text/image·structured output 지원을 표시한다. chunk는 텍스트 UTF8 최대48000바이트, 이미지1개, primary/context 합64parts 이하의 보수적 기술 계획이다. 단일 메시지를 Unicode codepoint 경계로 자르고 UTF16 절대 offset을 보존한다. 이미지마다 별도 part를 둔다. 원문을 비용 때문에 표본 추출하지 않는다. 실제 이미지 해상도/공급자 context 거절은 성공으로 바꾸지 않고 기술 한계로 처리한다. 크기/형식/권한 실패는 명시적 limitation으로 남기며 이미지 의미까지 검증됐다고 주장하지 않는다.

## 실행 API

교수 세션·Origin과 소유권 경계 아래 `POST /v1/analysis-runs`:

```json
{"teamId":"team_00000000-0000-4000-8000-000000000001","from":"2026-11-01T00:00:00.000Z","to":"2026-11-02T00:00:00.000Z","timezone":"Asia/Seoul","idempotencyKey":"00000000-0000-4000-8000-000000000016"}
```

실제 수업 시작/종료, 현재 동의/참가 매핑, 승인된 과거 수집 구간과 전체 기간 complete coverage, 서버 rubric 설정을 검사한다. from/to는 UTC 밀리초 포함 ISO이고 `[from,to)`다. timezone은 유효한 Intl/IANA 이름이며 기간을 암묵 변환하지 않는다. 수업 전/후 또는 미래 범위는 거부한다. 설정/coverage 미완료는409, 동의/사용 불가는 CONSENT_REQUIRED, 잘못된 입력400, 타인/없는 리소스404다. 기존 error envelope를 그대로 쓴다.

같은 교수+idempotencyKey+입력은202 동일 run이다. 같은 키의 다른 입력은409다. 다른 키는 팀의 새 version이다. run/spec/metadata outbox는 한 D1 트랜잭션이며 전송 실패에도 재시도 예약이 남는다. 큐 전송 성공을 분석 완료로 표시하지 않는다.

`GET /v1/analysis-runs/:id`는 status, snapshot, manifest header, valid, 버전, 실제 sources/chunks/completedChunks와 오류를 반환한다. 미등록 handler는 `HANDLER_UNREGISTERED`이며 결과 완료가 아니다. 모델 결과는 원문 재검증 없이 이 응답에 공개하지 않는다. invalidated/cancelled 실행은 manifest를 반환하지 않는다. validity 없는 queued/collecting은 아직 입력 준비 중이며 결과가 유효한 상태가 아니다.

`POST /:id/cancel`은 교수 검토 전의 작업 lease까지 폐기한다. `POST /:id/resume`은 현재 자료를 재검증하고 재개 가능한 dead 작업만 기존 Queue generation/복구 한도(3회) 내에서 다시 예약한다. 살아 있는 작업의 반복 resume는 중복 생성하지 않는다. 철회/삭제/취소/무효 입력이나 한도 초과는409이며 새 실행이 필요하다. 교수 검토/확정은 별도 기능이다.

## 준비·재시작·원문 경계

`analysis.prepare`는 metadata envelope이며 모델을 호출하지 않는다. 수업 진행 중에는 #12 전체 History/Replies 보정을 새 request로 수행하고 그 결과가 complete여야 한다. 수업 종료 뒤에는 허용 구간의 기존 complete coverage와 현재 원문 재검증을 사용하며 coverageAsOf/누락 한계를 보존한다. 종료 뒤 신규 수집 gate를 열지 않는다.

source마다 원문/이미지를 메모리에서 검증한 뒤 opaque ID, source revision/내용 지문, 이미지 식별자/지문/제약, part offset/byte 수만 저장한다. 참조는 source별 행, chunk는 chunk별 행으로 보관해 원문 전체를 하나의 DB JSON에 넣지 않는다. API의 전체 manifest header는 순서가 고정된 참조 지문의 hash다. 일반 동의 이력 트리거/기존 평가 필드는 보존한다.

부분 성공 checkpoint는 source ID로 고정돼 재시작/새 메시지 순서에 흔들리지 않는다. 재시작 시 원문을 재조회하고 DB source/image 지문·현재 참가자/동의·epoch를 같은 최종 batch에서 검사한다. 전체 source 수 대조로 조회 중간에 들어온 누락 메시지도 성공으로 덮지 않는다. source 준비 중의 epoch 변경과 모델 단계의 무효화를 분리하며 모델 단계는 #14의 lease/epoch fence를 그대로 쓴다.

`@teamplanet/analysis.withChunkInput`은 해당 chunk의 원문과 이미지만 현재 Slack에서 복원해 callback에 전달한다. 모든 이미지의 ID는 manifest와 대조하고 필요한 이미지 part만 다운로드한다. callback 종료 시 text/dataURL 참조를 비우며 원문/인용문/이미지 바이트를 Queue/DB/checkpoint에 저장하지 않는다. `assertCurrent()`는 전송/승격 직전에 호출하고 저장 batch에도 `runValidityGuard`를 넣는다. 외부 Slack과 D1의 원자적 트랜잭션은 불가능하므로 변경 이벤트와 매 사용 시 재검증이 함께 필요하다.

## A/B/C 입출력과 검증

- A: `evidenceInputSchema`, `evidenceModelOutputSchema`, `validateEvidenceOutput`. parts의 본문/이미지는 실행 메모리 전용이다. processedPartIds는 primary 전체와 정확히 같아야 한다. 인용은 part의 UTF16 절대 offset/실제 문자열에 일치해야 하고 학생/메시지/이미지/선택 key가 실제 입력에 있어야 한다. 모호한 이미지 행위자는 귀속하지 않고 한계·사람 검토로 남긴다.
- 저장 A: `normalizedEvidenceSchema`. raw quote 대신 messageId/offset/hash와 요약을 보관한다. summary는 원문 사본으로 쓰지 않는다. 원문 재검증 전에는 결과가 최신이라고 주장하지 않는다.
- B: `assessmentInputSchema`, `assessmentOutputSchema`, `validateAssessmentOutput`. 학생별 overview, **학생×선택 역량 각각 정확히 한 행**, 근거·반례·불확실성·한계·사람 검토를 반환한다. 근거 ID는 존재하며 해당 학생/역량과 연결돼야 한다. `insufficient_evidence`는 한계와 사람 검토가 필요하다. 원문 parts는 전체 입력에 대한 접근을 제공하며 긴 기간의 호출 계획/전체 통합은 #18/#20에서 연결한다.
- C: `reviewInputSchema`, `reviewOutputSchema`, `validateReviewOutput`. 원문+검증된 A/B를 별도 역할로 확인한다. issues는 알려진 학생·역량·근거·메시지만 참조한다. accept는 미해결 issue가 없어야 한다. 수정 요구는 iteration0에서만 가능하다.
- B 수정: `correctionOutputSchema`, `validateCorrectionOutput`로 정확한 issue ID와 새 B 결과를 검사한다. B 수정1회 → C iteration1 재검토1회이며 미해결은 human_review다. invalid source를 사람 검토 플래그로 통과시키지 않는다.

ID/범위 검증이 실제 해석의 교육적 타당성을 증명하지 않는다. #18/#19의 정성 해석과 #24/#25의 합성/실제 품질·편향 검증, 교수 최종 판단은 계속 필요하다. `assertAnalysisTransition`은 허용 전이/완료·valid proof를 검사하며 proof는 저장된 검증 결과에서 만들어야 한다. 단순 handler 실행 성공이나 fixture를 production 완료 proof로 사용하지 않는다. 실제 단계 저장/전이/공급자 오류 연결은 #20이다.

검증: `tests/analysis-contracts.test.ts`, `tests/analysis-runs.test.ts`. 실제 학생/Slack 변경·실제 메일·유료 모델 호출 없이 합성 자료와 mock만 사용한다.
