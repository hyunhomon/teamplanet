# 분석 통합과 복구 (#20)

`analysis.prepare` → 각 `analysis.stage/evidence_extraction` → `assessment/run_0` → `review/run_0`을 실제 Consumer에 등록했다. A는 모든 primary chunk를 처리하고 overlap을 병합한다. 최초 C가 수정 요구하면 `assessment/run_1` → `review/run_1`을 한 번씩만 실행한다. 최종 상태는 항상 `awaiting_professor`이며 교수 확정은 #23이다. 새 실행은 수동 API 요청으로만 생성한다.

## 실행·저장 경계

`packages/analysis/src/pipeline.ts`의 `processAnalysisStage`가 snapshot의 선택 역량·모델·provider·prompt를 검사한다. 세 역할은 고정 Qwen/DeepInfra BF16·ZDR·reasoning off·fallback 금지이며 Consumer의 슬롯 설정이 다르거나 키가 없으면 CONFIG_INVALID다. 모든 저장은 현재 run/source 유효성과 Queue lease를 함께 검사한다. 20초마다 lease를 갱신하며 취소·철회로 lease가 폐기되면 결과를 승격하지 않는다.

새 실행은 A의 첫 chunk만 outbox에 넣고 저장된 chunk가 다음 chunk를 예약한다. 모든 A 결과가 확인되면 B를 예약한다. 단계 결과·다음 작업·상태 전이를 같은 D1 transaction으로 저장한다. 출력 저장 뒤 ACK 전에 중단돼도 `stored` checkpoint를 재사용한다. 기존 stage 결과는 immutable PK로 중복 저장을 막는다.

B에는 해당 사건이 인용한 메시지를 전달한다. C에는 인용되지 않은 원문까지 **전체 run parts**를 제공한다. 긴 입력의 기존 B/C JSON 한도는 150000 UTF8바이트이며 이를 넘으면 CONTEXT_LIMIT다. 본문만으로 이미 한도를 넘는 실행은 B/C 전송 전에 실패한다. 임의 표본이나 일부 chunk를 전체 성공으로 바꾸지 않는다. A는 기존 chunk 계획을 따르고 이미지 원본은 A 호출 때만 전송한다. B/C 원문 재검증도 이미지 hash/metadata를 확인하되 이미지 data URL은 메시지별 확인 직후 비워 전체 실행 동안 누적하지 않는다. B/C에는 참조·작성자·한계 metadata만 전달한다.

신규 migration 0016은 `analysis_calls`와 `analysis_outputs`를 추가하며 적용된 SQL/동의 이력 트리거를 수정하지 않는다. 참조 없는 legacy 평가와 유효성 행이 없는 run을 허용하지 않는다. 두 테이블도 #14의 조기 삭제·수업 종료 후 달력 3개월 정리에 포함한다.

## 외부 호출의 중단과 metadata 재시도

| 호출 원장 상태 | 의미 | 재전달 동작 |
|---|---|---|
| `started` | 전송 전 dispatch fence를 저장함. 응답은 아직 영구 확인되지 않음 | 중단 후 새 lease는 자동 유료 재전송 금지 |
| `response` | 인용 검증을 마친 정규화 출력과 generation ID만 저장함 | 현재 원문 재검증 후 generation metadata GET만 재시도 |
| `verified` | 실제 모델/provider 확인과 단계 결과 저장 완료 | 완료 checkpoint 재사용 |
| `failed` | 공급자의 명시적 오류 응답 등 분류 가능한 실패 | 기존 Queue 한도와 Retry-After에 따라 기술 재시도/명시적 재개 |
| `uncertain` | 네트워크 결과 불명 또는 dispatch 뒤 중단 | PROVIDER_OUTCOME_UNKNOWN, 자동/일반 resume로 재전송하지 않음 |

외부 HTTP와 D1은 분산 transaction이 아니므로 외부 호출의 exactly-once를 주장하지 않는다. 응답을 받았지만 정규화 checkpoint 전에 프로세스가 중단된 경우에도 원시 completion이나 인용문을 저장해 복구하지 않는다. 결과 불명 상태는 운영자가 공급자 기록을 확인한 뒤 별도의 새 run 여부를 결정한다. 명시적으로 실패한 HTTP 요청의 재시도 비용 여부는 공급자가 결정하며 앱 자체 예산이나 자동 폴백을 두지 않는다.

`onValidated` hook은 A/B/C의 schema·인용/귀속·복제 방지 검증을 통과한 요약/참조/한계만 저장한다. raw model JSON, 원문, 인용 문자열, 이미지, 키는 호출 원장·Queue·로그에 남기지 않는다. 공급자 receipt가 아직 확인되지 않은 출력은 stage 결과나 교수 후보로 공개하지 않는다.

## 오류와 명시적 재개

- 실제 402만 `blocked_provider_billing`: 잔액 부족·키 한도·in-flight·미분류를 보존한다. 유효한 Retry-After가 있는 in-flight만 자동 재시도한다.
- 401/설정 누락은 `failed_provider_auth`, 403/provider 경로 위반은 `failed_model`의 PROVIDER_POLICY다. 429는 `rate_limited`, 5xx·HTTP200 error·metadata 조회 장애·잘못된 JSON·context는 고정 코드로 구분한다. 공급자 본문과 임의 limit_source를 저장하지 않는다.
- source 변경/삭제/철회는 유효성/lease fence로 차단한다. Slack 장애는 SOURCE_UNAVAILABLE이며 삭제 증거로 쓰지 않는다.
- 자동 재시도는 기존 generation당 5회다. `GET /analysis-runs/:id`는 실제 Queue가 dead인 경우 자동 재시도 예정이라고 표시하지 않는다.
- `/resume`은 키/잔액/공급자 정책 문제를 해결한 뒤 소유 교수가 명시 요청할 수 있다. receipt 대기는 저장한 정규화 결과를 재사용한다. generation 복구는 기존 3회 한도이며 취소/자료 무효·결과 불명·invalid output/context는 일반 resume로 우회하지 않는다. 새 run은 기존 버전을 덮어쓰지 않는다.

## 결과 재조회와 다음 화면

`GET /v1/analysis-runs/:id/artifacts`는 세션 교수 소유 run의 현재 Slack 원문·이미지 지문을 다시 확인한 뒤 `analysis-output-v1`을 반환한다. 완료 전/무효/취소는409, 타인/없음404, Slack 장애503이다. 원문/이미지 바이트는 반환하지 않는다. 공유 계약은 `packages/contracts/src/pipeline.ts`다.

응답은 snapshot/manifest, 정규화 evidence(인용 offset/hash), 원래 B, 최초 C, B 수정본, 최종 C, 교수 후보, 사람 검토 플래그와 실제 generation receipts를 보존한다. 기존 `evidence_events`/`assessments`에도 최종 후보를 같은 transaction으로 저장한다. `readRunArtifacts`도 같은 보호 경계를 제공한다. #22는 이를 바탕으로 결과·보호된 원문 뷰어를, #23은 교수 수정/확정을, #31은 출력 전 재검증을 연결한다. 학생용 평가 포털은 제공하지 않는다.

## 검증과 운영 설정

`tests/analysis-pipeline.test.ts`는 실제 SQLite migration과 실제 producer/Consumer/Queue runner를 모의 transport·OpenRouter로 연결한다. 성공, 수정/재검토, 여러 chunk와 C 전체 문맥, metadata-only retry, 최종 저장 rollback, 402/401/403/429/5xx/HTTP200 오류, context, 취소/철회, 이미지 메모리 경계, 소유권·원문 재검증·삭제를 검증한다.

`bun run queue:verify:local`은 실제 Miniflare Worker/Queue/D1에서 별도 outbound mock으로 A→B→C와 metadata-only retry까지 실행한다. mock은 외부 서비스에 요청을 전달하지 않으며 test fixture는 production Worker에 포함하지 않는다. 실제 모델 품질·외부 연결은 #24/#25에 남는다.

Consumer에는 기존 API와 동일한 `SLACK_TOKEN_KEY`, 별도의 `OPENROUTER_API_KEY` secret이 필요하다. 모델 ID 세 슬롯은 wrangler의 공개 vars다. API의 secret이 Consumer로 자동 복사되지 않는다. 키 누락을 성공으로 표시하지 않으며 공개 health는 AI 공급자 가용성 검사가 아니다. 로컬 Wrangler OAuth와 GitHub CD 자격 증명은 독립적이며 로컬 로그인 변경을 배포의 선행 조건으로 두지 않는다.

배포 뒤 `analysis-secret-status.ts`가 기존 CD 토큰으로 Consumer의 secret **이름만** 읽고 실행 Summary에 등록/미등록/확인 불가를 구분해 기록한다. 키 값 조회나 Slack/모델 호출을 하지 않으며 HTTP 인증 실패를 미등록으로 오인하지 않는다. 설정 미등록은 운영 준비 미완료로 보고하고 일반 웹/DB 배포와 구별한다. 등록 이름 확인도 키의 유효성·권한·실제 품질 검증을 뜻하지 않는다.
