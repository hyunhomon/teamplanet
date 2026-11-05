# 검증된 결과와 내부 원문 뷰어 (#22)

교수 팀 분석에서 완료한 run을 선택하면 결과를 다시 검증해 표시한다. 학생 개요·실행 당시 선택 역량·정성 판정·근거/반례·신뢰도·한계·교수 검토 필요를 보존한다. 최초 B·C와 수정/재검토를 별도로 열 수 있다. 관찰 부족을 실패나 낙제로 표시하지 않는다.

보호 API는 `GET /v1/analysis-runs/:id/assessments`, `GET /:id/evidence/:evidenceId`, `GET /:id/messages/:messageId?after=<internal-message-id>`다. contracts/results.ts의 strict schema를 사용한다. 모든 응답은 no-store이고 세션 교수의 run 소유권을 먼저 확인한다. 없는/타인 리소스404, 무효/미완료409, Slack 검증 장애503이다. 공개 학생 평가 엔드포인트는 없다.

`withVerifiedArtifacts`는 현재 Slack 원문·이미지 지문을 검증하며 A 사건, manifest/snapshot, 원래 초안→수정→최종 검토/후보의 일관성을 재구성한다. 요약/후보 불일치는 team epoch를 무효화하고 교수 확정본도 유효 결과에서 제외한다. Slack 장애는 변경/삭제로 기록하지 않는다. 기존 `readRunArtifacts`도 같은 검증을 사용한다. 원문 문맥은 manifest 내부의 동일 스레드만 20개씩 표시하고 허용 기간 밖 루트·작성자·다른 팀 원문은 가져오지 않는다. 원문은 응답 구성 중에만 메모리에 존재하고 DB/로그/브라우저 저장소에 복제하지 않는다.

UI는 메시지/모델 출력을 React 텍스트로만 렌더링한다. HTML·Markdown·Slack 링크를 실행하지 않으며 외부 attachment URL을 내려주지 않는다. 이미지 원본은 이 뷰어에 재복제하지 않고 불가/확인 필요를 표시한다. 내부 근거 조회가 Slack permalink 가용성에 의존하지 않으므로 외부 링크 실패를 영구 캐시로 우회하지 않는다. 새 검증 실패·탭 숨김·세션 만료 때 화면의 기존 결과/원문을 지운다.

#23은 `withVerifiedArtifacts(deps, runId, callback)`의 artifacts/input/spec/current와 `artifactHash`를 사용해 확정 직전 재검증할 수 있다. 실제 쓰기에는 current 호출뿐 아니라 동일 D1 batch의 `runValidityGuard`와 상태/낙관적 버전 조건이 필요하다. #31도 출력 직전 같은 검증을 재사용해야 한다. 교수 수정/확정·인쇄는 이 PR에서 제공하지 않는다.

검증은 실제 SQLite/source fence와 합성 Slack 응답을 사용한다. 실제 Slack/OpenRouter 키나 유료 호출을 사용하지 않는다. 실제 모델 품질·외부 운영 준비는 #24/#25 범위다.
