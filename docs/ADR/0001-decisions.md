# ADR-0001 — 2026-10-24 MVP Decisions

Status: Accepted, pending validation on exact rubric labels, model IDs and legal/consent operation.

1. Slack integration, not Discord-only / a new chat app.
2. One experimental workspace; setup wizard supports channel template, bot invitation, students/consent.
3. Existing channel conversations, not student-authored progress reports.
4. Professor-only MVP dashboard, email OTP.
5. Analyze entire designated channel within professor-selected period, manually triggered.
6. 4 competencies, qualitative explanations and exact evidence; professor approves final assessment.
7. Three configurable OpenRouter model slots for evidence extraction, assessment, independent review. Must resolve exact three model IDs from prior decision before production.
8. Bun monorepo; Astro/React UI; Hono API separate CF Worker; D1 + Drizzle; Queues.
9. No app-level cost guardrails, maximum token spending, or artificial budget. Honor provider billing 402; don't conflate with generic rate limiting.
10. Access/consent/deletion process is a deployment blocker, not an optional polish item.
