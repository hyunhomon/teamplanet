# ADR-0001 — 2026-10-24 MVP Decisions

Status: Accepted; service policy updated by ADR-0002, rubric/model decisions by ADR-0003. Actual consent and pilot validation remain required.

2026-10-27 서비스 파일럿 정책은 [ADR-0002](0002-pilot-policy.md)로 구체화했다. 교수용 평가 대시보드는 유지하고 학생 QR 재확인·본인 문의·교수의 리포트 출력 전달을 추가한다. 전원 사전 동의 전제, 원문 비보관/참조·요약 저장, 문의 n일/요약·리포트 수업 종료 후 3개월 보관을 따른다. 실제 루브릭/모델 전송 조건 확인과 파일럿 시작 승인은 별개다.

1. Slack integration, not Discord-only / a new chat app.
2. One experimental workspace; setup wizard supports channel template, bot invitation, students/consent.
3. Existing channel conversations, not student-authored progress reports.
4. Professor-only MVP dashboard, email OTP.
5. Analyze entire designated channel within professor-selected period, manually triggered.
6. Professor selects 1–4 competencies at initial setup; qualitative explanations and exact evidence; professor approves final assessment (ADR-0003).
7. Three configurable OpenRouter model slots for evidence extraction, assessment, independent review. Initial Qwen profile and provider policy are defined in ADR-0003; no model diversity is claimed.
8. Bun monorepo; Astro/React UI; Hono API separate CF Worker; D1 + Drizzle; Queues.
9. No app-level cost guardrails, maximum token spending, or artificial budget. Honor provider billing 402; don't conflate with generic rate limiting.
10. Access/consent/deletion process is a deployment blocker, not an optional polish item.
