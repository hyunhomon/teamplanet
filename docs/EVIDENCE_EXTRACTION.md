# A 근거 추출 adapter (#17)

`@teamplanet/analysis`의 `extractRunEvidence`는 #16 `withChunkInput`과 현재 run snapshot을 사용한다. 원문·이미지/지시문은 user data이며 `evidenceSystemPrompt`만 system role이다. `extractEvidence`는 이미 권한 검증된 메모리 입력/fixture용 경계이며 호출자는 전송/결과 수신 전 `assertCurrent`를 제공해야 한다. 공개 모델 호출 API나 Queue stage handler를 추가하지 않는다. B/C와 전체 실행/저장/공급자 재시도는 #18/#19/#20이다.

## 전송과 공급자 확인

기존 `communication-prompts-v1` A 역할을 `packages/analysis/src/evidence-prompt.ts`에 구현한다. `qwen-pilot-v1`의 evidence 모델과 snapshot이 정확히 같아야 한다. DeepInfra BF16 only·ZDR·학습 미사용·reasoning off·fallback false를 기존 OpenRouter helper로 강제하며 구조화 JSON schema를 지정한다. 앱 비용 상한·자동 저가 모델 폴백을 추가하지 않는다.

실제 model은 응답과 대조하고 generation의 **metadata만** 조회해 id/model/provider_name=DeepInfra를 확인한다. 요청 provider를 실제 provider로 가장하지 않는다. receipt는 generationId/model/provider/requestedProvider/promptVersion뿐이며 prompt/output 내용 조회 API는 사용하지 않는다. [Chat 구조화 출력](https://openrouter.ai/docs/guides/features/structured-outputs)과 [generation metadata API](https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation)를 따른다. metadata 지연/권한 실패면 `PROVIDER_RECEIPT_UNAVAILABLE`과 generationId를 반환하는 오류이며 완료가 아니다. adapter는 유료 호출을 자동 재시도하지 않는다. #20은 metadata만 별도로 재확인하고 중복 유료 전송을 피하는 checkpoint를 연결해야 한다.

401 인증/403 정책/429 rate limit/5xx·네트워크 장애/실제402 billing을 분리한다. 402는 기존 `parseOpenRouter402` 분류와 Retry-After를 보존한다. 원시 provider 본문·키·원문은 에러/로그/Queue로 보내지 않는다. `EvidenceError`는 고정 코드 중심이며 `MODEL_INVALID`, `CONTEXT_LIMIT`, `DATA_INVALIDATED`도 구분한다. 중단/철회 뒤 이전 입력을 재사용하지 않는다.

## 원본과 주장 경계

모든 primary part가 처리 목록에 정확히 한 번 있어야 한다. 메시지 ID/학생/태그/인용 offset·문자열/이미지 ID·행위자를 #16 validator로 대조한다. 자기 보고는 그 발화의 증거이며 외부 작업 완료의 증명이 아니다. 원문에 없는 외부 행동 단어, 성격·사적 동기·활동량 대리 판단과 원문 복제 요약의 일부 패턴은 추가 거부한다. 이 언어 검사는 완전한 의미 판별기가 아니다. 모든 생성 해석은 `model_interpretation_requires_independent_review`와 requiresHumanReview로 전달하고 실제 타당성 검증/교수 판단을 대체하지 않는다. 허위 원문/인용/귀속을 review 플래그로 우회하지 않는다.

이미지에는 실제 data URL을 제공하고 알려진 ID만 인용한다. 작성자 불명은 actorId=null로 유지하며 텍스트 발화로 입증되지 않은 학생 귀속을 거부한다. 이미지 해석은 항상 별도 검토 대상이다. 해당 chunk에 없는 이미지/실패 이미지는 `missingImageIds`/`image_input_incomplete`로 남기며 시각 자료까지 처리 완료라고 주장하지 않는다. 원문 재검증은 첨부 목록뿐 아니라 요청 이미지의 현재 파일 metadata/지문도 전송·결과 수신 시 다시 확인한다.

기술 context 기준: #16의 전체 text parts(최대48000 UTF8바이트), 최대1개 이미지, JSON metadata 포함150000 UTF8바이트와 이미지1048576픽셀을 넘으면 CONTEXT_LIMIT로 실패한다. 이미지 축소·임의 표본·잘라낸 성공을 하지 않는다. #13의 다운로드 가능 한도와 실제 모델 context 한도는 서로 다르다. 파일의 PNG/JPEG 구조 검증은 전체 pixel codec 검증을 뜻하지 않는다. 공급자 length/truncation/비정상 JSON도 완료가 아니다.

## 저장·overlap·coverage

반환 사건은 안정적인 run+원문ID+행위자+선택태그+modality 기반 ID다. raw 인용은 messageId/UTF16 offset/SHA256으로 바꾸고 이미지 원본/URL·토큰은 반환하지 않는다. 같은 원문 사건의 overlap 중복은 `mergeEvidenceChunks`/`mergeEvents`로 병합하며 인용/이미지·한계를 합친다. 서로 다른 요약은 결정적 순서로 보존하고 대안 해석은 `overlap_summary_variant` 한계에 남긴다. 입력 순서/중복 재전달에 결과가 흔들리지 않는다. 모든 예상 chunk/primary coverage가 있어야 합칠 수 있으며 다른 run/원문 참조는 거부한다.

실제 단계 결과를 DB에 저장할 때 #20은 normalized 사건·receipt만 현재 run validity/Queue checkpoint와 같은 batch에 넣어야 한다. 이 adapter 성공 자체는 B/C 완료·awaiting_professor·교수 확정을 뜻하지 않는다. 새 DB 스키마나 과거 migration 변경은 없다.

합성 검증: `tests/evidence-extractor.test.ts`의 한국어·관찰 부족·입력 주입·허위 ID/인용/행위자/행위·미선택 태그·원문 복제·이미지 작성자 불명·overlap/전체 coverage·실제402 분류·미검증 공급자·모델 context·전송 전후 철회. #16 fixture를 그대로 사용한다. 실제 모델/학생/Slack/메일 호출을 하지 않았으며 실제 한국어·이미지 품질/편향·provider 가용성/계정 logging·처리 지역·고지 확인은 #24/#25에 남는다.
