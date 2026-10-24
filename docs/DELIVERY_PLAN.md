# Delivery Plan

## 1. Repo foundation

Bun workspaces, Astro+React+Tailwind web and Hono Cloudflare Worker API (each separate deployed Worker), D1 Drizzle migrations, Queue consumer.

## 2. Professor auth + Slack setup

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
