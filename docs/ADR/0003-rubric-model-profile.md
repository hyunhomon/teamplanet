# ADR-0003 · 선택형 루브릭과 Qwen MVP 프로필

Status: 2026-10-27 운영자 hyunhomon 승인에 따른 개발 v1. 교수 사전 승인·실제 모델 품질 검증 완료를 의미하지 않는다.

## 승인 근거

#15 질문 1~9에 대한 이 관리 채팅의 답변: 네 역량 유지 및 초기 교수 선택, 교수의 별도 루브릭 승인을 기다리지 않는 MVP, 정성 4판정과 학생 개요/카드/근거/반례/한계 유지, Qwen 통일·최소 비용 방향, 동의 범위의 실제 표시명 허용, 프로젝트 이미지 원본 전송 허용, ZDR 전용, 자동 수정 한 번 후 재검토 및 사람 검토 이관이다. 사용자가 기억한 과거의 정확한 모델 ID는 저장소와 조회 가능한 관련 채팅에서 확인되지 않았다. 아래 ID는 이 방향에 따라 이번에 선정한 초기 프로필이다.

## 결정

- `communication-v1`: clarity / information_sharing / feedback_alignment / decision_execution. 교수는 수업 초기 1~4개를 선택하며 전체 자동 기본값은 없다. #3/#9가 설정 API·저장·UI를 구현한다.
- #16은 실행 생성 시 선택 key, rubric/prompt/model profile 버전, 실제 모델 ID와 provider, 입력 범위/revision을 스냅샷한다. 설정 변경은 기존 결과를 덮어쓰지 않는다. MVP에서는 변경 후 새 실행만 반영한다. 역량/기준 변경은 새 버전이다.
- `qwen-pilot-v1`: A/B/C 모두 `qwen/qwen3.5-9b`, `deepinfra/bf16`으로 별도 호출한다. C는 원문과 출력을 새 역할로 감사하지만 같은 가중치 사용으로 오류가 상관될 수 있다. 모델 다양성·다수결 검증으로 표현하지 않는다.
- `communication-prompts-v1`: `prompts/01~03`의 역할 분리. reasoning을 끄고 이미지·한국어·구조화 출력 지원 경로를 사용한다. 공급자에 맡기는 JSON 출력 외에도 서버 schema/참조/선택 범위/최신성 검증이 필요하다.
- provider `only:["deepinfra/bf16"]`, `allow_fallbacks:false`, `require_parameters:true`, `data_collection:"deny"`, `zdr:true`. 경로 부재는 공급자/정책 오류이며 다른 모델·공급자로 자동 우회하지 않는다. 유료 호출이나 앱 비용 상한은 이번 결정 작업에 포함하지 않는다.
- C 수정 요구 → B 수정 1회 → C 재검토 1회. 여전히 불일치하면 사람 검토 후보로 표시하고 자동 확정하지 않는다. 미등록/철회/삭제/변경된 근거는 별도 무결성 실패로 결과 승격을 막는다. 사람 검토 플래그로 유효하지 않은 자료를 허용하지 않는다. 이 의미상 수정 횟수와 전송 실패 재시도는 구분한다.
- 실제 표시명과 동의된 프로젝트 이미지 원본을 실행 중 전송할 수 있다. 학생/수업 내부 ID와 권한 검증은 이름과 별개다. 비밀 키·인증 토큰·동의 범위 밖 자료는 보내지 않는다. 원문/이미지 영구 복제 금지와 교수 최종 판단은 유지한다.

## 공식 정보 확인 — 2026-10-27 공개 metadata

[OpenRouter endpoint API](https://openrouter.ai/api/v1/models/qwen/qwen3.5-9b/endpoints)의 DeepInfra BF16 경로는 text+image 입력, text 출력, context 262,144, 최대 completion 81,920, response_format/structured_outputs/reasoning 지원을 표시한다. 당시 endpoint 가격은 입력 **$0.10**, 출력 **$0.15 / 100만 토큰**이다. 가격·가용성은 변할 수 있으며 aggregate 모델 가격과 다를 수 있다. 최소가 보장이나 실제 호출 성공·품질 확인이 아니다.

[Qwen 공식 모델 카드](https://huggingface.co/Qwen/Qwen3.5-9B), [OpenRouter provider 목록](https://openrouter.ai/providers), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [ZDR 정책](https://openrouter.ai/docs/guides/features/zdr), [DeepInfra 데이터 정책](https://docs.deepinfra.com/account/data-privacy)을 확인했다. DeepInfra는 프롬프트/응답의 학습 미사용·내용 무보관을 명시하며 메타데이터 보관과는 다르다. bulk/batch 저장 경로는 사용하지 않는다. OpenRouter ZDR 정의에는 공급자의 일부 메모리 캐시가 허용될 수 있으므로 모든 계층의 모든 metadata 무보관으로 안내하지 않는다. web search/plugin은 쓰지 않는다.

실제 자료 전송 전 OpenRouter 계정의 prompt/output logging을 끄고, 실제 경로·약관·처리 지역·학생 고지 일치를 #25에서 확인한다. 회사 본사 주소를 실제 추론 처리 지역으로 단정하지 않는다. 현재 확인은 공개 정책/경로 metadata이며 리전 고정 증명이나 실제 학생 동의 확보가 아니다.

## 구현 경계

#15는 공유 선택/출력 검증, 모델 요청 정책, 합성 fixture, 문서·프롬프트를 제공한다. 설정 화면/DB migration(#3/#9), run 스냅샷/단계 schema(#16), 실제 A/B/C와 수정 루프(#17~#20), 선택한 결과만 표시/교수 확정/출력(#21~#23/#31)은 후속 구현이다. env 예제는 production secret 설정을 뜻하지 않는다.
