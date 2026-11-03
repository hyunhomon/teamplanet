# 실행 중 Slack 이미지 처리 (#13)

`@teamplanet/collection`의 `withMessageImages(deps, {teamId,channelId,slackTs}, callback)`은 현재 원본 메시지를 재조회하고 실제 `files[]`에 연결된 ID만 `files.info`로 확인한다. 클라이언트의 URL이나 파일 ID만으로 파일을 가져오는 공개 API는 제공하지 않는다. 동일 팀·채널·작성자·허용 구간·현재 동의·원본 revision/text fingerprint를 확인한다. 삭제·변경·철회 상태는 재시도에도 우회할 수 없다.

봇 토큰은 API/Consumer가 `SLACK_TOKEN_KEY`로 열고 모듈 내부에서만 사용한다. callback에 토큰·private URL을 전달하지 않는다. 다운로드는 HTTPS의 정확한 `files.slack.com` 호스트와 `/files-pri/`의 요청 file ID 경로만 허용한다. 외부/remote 파일·userinfo·다른 호스트·위조 ID를 차단한다. 자동 redirect를 끄고 같은 규칙으로 최대 2번만 따라간다. 실패 응답의 URL·본문·토큰은 로그나 영구 저장소에 쓰지 않는다.

v1은 PNG/JPEG만 허용한다. MIME, 파일 framing/PNG CRC, JPEG SOF/SOS/EOI, 실제 byte 수와 metadata 크기, dimensions를 확인한다. 압축 픽셀을 완전히 decode하는 라이브러리는 아니므로 모델의 이미지 해석 실패도 후속 단계에서 한계로 처리한다. 기술 제한은 파일 8 MiB, 메시지별 메모리 batch 16 MiB/16개, 40M pixels/한 변 16,384, 요청 15초다. unsupported/실패/초과는 명시적인 limitation이며 텍스트만으로 전체 이미지를 분석했다고 표시하지 않는다. 비용 상한이나 모델 자동 폴백을 추가하지 않는다.

callback만 메모리상의 `data:image/...;base64`를 받고 종료 시 참조를 비운다. raw bytes는 변환 뒤 지운다. D1의 `image_refs`는 원본 message/file ID, source/file revision 지문, 내용 hash, limitation, 확인 시각만 보관한다. D1/KV/R2·Queue·로그·브라우저에 이미지 원본/private URL/토큰을 영구 복제하지 않고 재사용 캐시도 두지 않는다. 파일 작성자가 현재 학생에 대응되지 않으면 attribution을 null로 하고 `image_author_uncertain`을 전달한다.

callback 직전에 메시지/첨부 연결을 다시 확인하고 `assertCurrent()`를 제공한다. 모델 요청 직전에도 이를 호출한다. 저장은 `sourceWriteGuard`와 결과/checkpoint를 같은 D1 batch에 넣는다. 외부 HTTP 전송과 DB 철회는 분산 트랜잭션이 아니므로 이미 전송 중인 요청을 소급 회수할 수는 없다. 철회/삭제 후 재개·새 전송·결과 승격은 재검증으로 차단한다. 파생 참조의 무효화/보관 만료와 운영 추적은 #14가 연결한다.

#17은 승인된 `qwen-pilot-v1`/DeepInfra BF16/ZDR helper에 이 메모리 입력을 연결하며 원본/첨부를 모델 지시문으로 취급하지 않는다. 실제 유료 모델/Slack 호출은 이번 검증에서 실행하지 않는다.

`bun test tests/slack-images.test.ts`는 합성 1px PNG와 mock 다운로드를 사용한다. forged URL·다른 호스트 redirect·private/expired·MIME/framing·크기·timeout·철회/삭제/첨부 제거와 메모리 해제를 검증한다. 신규 `0012` migration은 기존 평가/동의 이력 SQL을 수정하지 않는다.

공식 근거: [Slack 파일 다운로드·remote 파일과 인증 헤더](https://docs.slack.dev/messaging/working-with-files/), [files.info](https://docs.slack.dev/reference/methods/files.info/). 실제 `files:read`, OAuth·토큰·원격 파일 유효성 확인은 #24/#25 외부 운영 검증에 남아 있다.
