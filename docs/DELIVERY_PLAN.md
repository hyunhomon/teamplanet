# Delivery Plan

## 1. Repo foundation

Bun workspaces, Astro+React+Tailwind web and Hono Cloudflare Worker API (each separate deployed Worker), D1 Drizzle migrations, Queue consumer.

## 2. Professor auth + Slack setup

공유 계약(#1): `packages/contracts/src/api.ts`의 Zod 스키마와 `@teamplanet/contracts/fixtures`를 인증 API(#2)·로그인 화면(#4)의 공통 출발점으로 사용한다. `docs/API_CONTRACT.md`에 HTTP 상태·쿠키·소유권·ID 규칙을 정의한다. 실제 인증·권한·Slack·동의 gate 및 정책 승인은 각 후속 이슈에서 구현/확인한다.

OTP email sign-in, Slack OAuth code flow, team/channel setup wizard, bot membership check, consent gate and activate.

## 3. Data capture

Events API signature validation, event dedupe, thread context, edit/delete events, image references and access, history/backfill policies.

## 4. Three-model analysis

Run-state machine, chunk pipeline on full in-scope logs, model-ID config, stage schemas, source ID integrity validation, provider 402 normalized errors.

## 5. Professor dashboard

Period picker, launch/progress UI, 4-competency qualitative outcomes, click-through evidence, uncertainty/review, finalize audit trail.

## 6. Pilot

Consented synthetic/real pilot data, dual-human baseline assessment, error and bias probes, professor time-to-review measurement, student privacy/acceptability interviews.

## Definition of done

- No manual student reports/task tracking
- No app-side cost threshold/stop
- Distinct provider-402 blocked UX
- No score without verifiable linked evidence
- No DM/unapproved channel ingestion
- Consent gate not bypassable
- Human professor retains final evaluation
