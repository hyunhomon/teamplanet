# B 정성 평가 adapter (#18)

`@teamplanet/analysis`의 `assessStudents(deps, input, assertCurrent)`는 #16 `assessmentInputSchema` 메모리 입력을 받아 B 역할을 한 번 호출한다. 입력은 실행 전체의 A 사건(`normalizedEvidenceSchema`, #17 `mergeEvidenceChunks` 결과)과 그 사건이 인용한 메시지의 원문 parts다. `assessorSystemPrompt`만 system role이고 원문·사건 요약은 user data다. 호출자는 전송 전·결과 수신 뒤 `assertCurrent`를 제공해야 한다. Queue stage handler·결과 저장·근거 메시지 원문 로드(`withChunkInput` 일반화)·상태 전이는 #20이고 C는 #19다.

## 전송과 공급자 확인

#17과 같은 `requestStage`·`verifyEvidenceGeneration`을 쓴다. `qwen/qwen3.5-9b`·DeepInfra BF16 only·ZDR·reasoning off·fallback false, strict JSON schema(`teamplanet_assessment_v1`, 수정 시 `teamplanet_correction_v1`)를 강제한다. 실제 공급자는 generation metadata로만 확인한다. 401/403/429/5xx/실제 402 분류, Retry-After 보존, 원시 본문 비노출과 자동 유료 재시도 없음도 A와 같다. 오류는 같은 `EvidenceError` 코드다. 앱 비용 상한·자동 모델 폴백은 추가하지 않는다.

모델에는 선택 역량과 라벨, 학생, 기간, 입력 한계, A 사건, 학생×선택 역량별 후보 근거 ID(`candidates`), 인용된 메시지의 원문 parts만 보낸다. 인용되지 않은 메시지는 보내지 않으므로 사건이 없는 잡담·말수 변화가 B 입력을 바꾸지 않는다. 이미지 바이트는 다시 보내지 않고 A의 검증된 이미지 사건만 쓴다. JSON이 150000 UTF8바이트를 넘으면 표본 추출 없이 `CONTEXT_LIMIT`다.

## 근거 역추적 (전송 전)

- 사건의 모든 메시지 ID가 입력 parts에 있어야 하고, 모든 인용은 해당 메시지 parts를 UTF16 offset으로 이어 붙인 원문 slice의 SHA256과 같아야 한다. 원문이 바뀌었거나 범위를 벗어나면 `DATA_INVALIDATED`이며 모델을 호출하지 않는다.
- 사건의 행위자는 인용 메시지 작성자이거나 입력에 포함된 이미지의 검증된 업로더여야 한다. 다른 학생의 발화를 그 학생 행동으로 귀속하면 `DATA_INVALIDATED`다. 이미지만으로 귀속된 사건은 #20이 해당 이미지 metadata를 B 입력에 포함해야 통과한다.
- 알 수 없는 학생·선택하지 않은 역량 태그·중복 ID는 `MODEL_INVALID`다.

## 출력 검증과 보존

`validateAssessmentOutput`(#16)으로 학생별 개요, 학생×선택 역량 정확히 한 행, 미선택·중복·누락·알 수 없는 학생/근거, 다른 학생 근거 인용, 근거 없는 `observed_strength`/`mixed`/`needs_support`, 한계·사람 검토 없는 `insufficient_evidence`를 거부한다. 추가로 거부하는 것:

- `mixed`인데 반례가 없거나, 같은 근거를 근거·반례에 동시에 쓴 행
- narrative·개요의 점수/등급/순위/학점, 말수·활동량·참여도·답장/이모지/링크 수, A와 같은 성격·동기·보호 속성·낙제·메시지 수 표현
- 원문 32자 이상 복제, 원문이나 A 요약에 없는 외부 행동 단어(배포·구현·완성 등)

서버는 결과를 낮추지 않고 올리기만 한다. 행에는 인용한 사건의 한계를 합치고, 사건이 사람 검토를 요구하면 행도 요구한다. 해당 학생·역량의 후보 근거를 근거·반례 어디에도 쓰지 않으면 `unaddressed_evidence:<id>` 한계와 사람 검토를 붙인다. 개요에는 입력 한계를 합치고 그 학생 행 중 하나라도 검토가 필요하면 개요도 검토 필요다. A가 모든 사건을 검토 필요로 표시하므로 근거가 있는 행은 항상 교수 검토 대상이다.

## 수정 1회

`correction`이 있으면 `validateCorrectionOutput`으로 `resolvedIssueIds`가 요청 issue ID와 정확히 같고 수정 결과가 같은 검증을 통과하는지 확인한다. 새 근거·원문을 만들 수 없다. 수정은 `iteration: 1` 한 번뿐이며 C 재검토 1회 뒤 미해결은 사람 검토다(#19/#20의 전이 검사).

## 한계

ID·범위·표현 검사는 해석의 교육적 타당성을 증명하지 않는다. 언어 검사는 완전한 의미 판별기가 아니다. 실제 Qwen 호출의 한국어 품질·편향·장문 누락, 교수 최종 판단은 #24/#25와 교수 검토에 남는다. 합성 검증: `tests/assessor.test.ts`(공유 한국어 평가 fixture의 강점·실질 공유·반례·합의 불일치·관찰 부족, 입력 주입, 원문 변경·범위 밖 인용·타인 귀속, 누락/중복/미선택, 활동량·점수 표현, 잡담 추가 불변, 수정 1회, 철회·설정·context·402). 실제 모델·학생·Slack 호출은 하지 않았다.
