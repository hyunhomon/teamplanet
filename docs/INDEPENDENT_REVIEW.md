# C 독립 검토 adapter (#19)

`@teamplanet/analysis.reviewAssessment(deps, input, assertCurrent)`는 #16의 `reviewInputSchema`를 받아 별도 C 호출을 한 번 수행한다. B 구현에 의존하지 않고 `@teamplanet/contracts/analysis-fixtures`와 `/reviewer-fixtures`로 개발·검증한다. `accept`는 검토상 수용, `request_correction`은 수정 필요, `human_review`는 미해결 이견이다. 어떤 경우에도 교수의 최종 평가를 대신하지 않는다.

## 원문과 출력 검증

입력 B의 학생×선택 역량·근거 ID·귀속을 공유 validator로 검사한다. A의 정규화 인용은 현재 메모리 parts의 UTF16 절대 offset을 이어 붙인 문자열의 SHA256과 대조한다. 등록된 근거라도 원문이 다르거나 인용 작성자/검증된 이미지 업로더와 행위자가 다르면 전송 전에 거부한다. 철회·원문 변경은 `assertCurrent`를 전송 전과 결과 수신 후 호출해 차단한다.

모델에는 원문 전체 parts·thread·시각·기간·학생·선택 역량·A/B와 한계를 user data로 전달한다. system role은 `reviewerSystemPrompt`만 사용하며 입력 안의 지시를 신뢰하지 않는다. C는 A가 선택한 근거 밖의 원문에서도 반례를 검토할 수 있다. 이미지 바이트는 재전송하지 않으며 이미지 해석의 한계를 유지한다. 입력 JSON이 150000 UTF8바이트를 넘으면 표본 추출 없이 `CONTEXT_LIMIT`다. 긴 실행의 전체 coverage 계획은 #20에서 연결해야 한다.

C의 모든 issue는 알려진 학생·선택 역량과 실제 근거 또는 메시지가 필요하다. 다른 학생/역량의 근거, 관계없는 메시지, 빈 참조, 중복·가짜 ID, schema 밖의 대체 평가·점수는 거부한다. 원문을 32자 이상 복제한 지시도 거부한다. C의 지시는 자동 대체 평가로 채택하지 않는다. 실제 A/B 원문 해석과 C의 의미 판단이 항상 옳음을 증명하는 검사는 아니며 최종 교수 검토가 필요하다.

## 유한 수정과 이력

`await reconcileReview(initialInput, firstReview, correction?, secondReview?)`가 원래 B 초안, 첫 검토, B 수정본, 재검토, 후보를 분리해 반환한다. 입력과 원래 초안을 변경하지 않는다.

- 최초 수정 요구만 `needs_correction`이며 후보는 null이다.
- B 수정은 `correctionOutputSchema`/`validateCorrectionOutput`으로 issue ID 전체·정확한 학생/선택 범위·근거를 검사한다.
- C iteration1 재검토는 한 번뿐이다. 두 번째 수정 요구는 거부하며 미해결은 `human_review`로 종료한다.
- 수용/사람 검토의 다음 상태는 항상 `awaiting_professor`다. 입력 A/B의 한계·사람 검토 플래그를 C가 낮출 수 없고 후보에도 보존한다. 이전 issue와 수정 전후 결과를 지우지 않는다.

## 공급자와 통합 경계

Qwen·DeepInfra BF16 only·ZDR·reasoning off·fallback false와 strict JSON 출력을 사용한다. 실제 공급자는 #17 `verifyEvidenceGeneration`의 generation metadata로 확인한다. 오류는 `EvidenceError`를 공유하며 실제 HTTP402만 billing이고 401/403/429/5xx·context·invalid data와 구분한다. 자동 유료 재시도·다른 모델 전환·앱 비용 상한은 없다. raw 공급자 본문을 오류에 붙이지 않는다.

이 adapter는 DB·Queue·로그에 원문을 저장하지 않고, run을 완료로 바꾸지 않는다. #20은 snapshot의 model/provider/prompt와 계약 버전을 확인하고, 현재 Slack 원문 전체를 메모리에 복원해 callback과 `assertCurrent`를 제공해야 한다. callback 종료 후 원문/이미지를 비우고 결과·receipt·수정 이력을 저장하는 **동일 D1 batch**에 `runValidityGuard`와 lease fence를 넣어야 한다. C adapter 호출 성공만으로 결과를 승격하지 않는다. production handler·저장·복구는 #20 범위다.

`tests/reviewer.test.ts`는 합성 원문과 모의 공급자만 사용한다. 잘못된 인용/학생 귀속/빠진 반례/활동량 편향/과도한 단정의 예상 수정 응답과 C 자체의 가짜 참조, 수정 한도, 철회, 공급자 오류를 검증한다. 실제 모델이 이 오류들을 발견하는 정확도나 한국어 품질·편향·실제 학생 자료의 안전성을 측정한 것은 아니다. 실제 품질 검증은 #24/#25에 남는다.
