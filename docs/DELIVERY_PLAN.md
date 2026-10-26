# Delivery Plan

## 1. Repo foundation

Bun workspaces, Astro+React+Tailwind web and Hono Cloudflare Worker API (each separate deployed Worker), D1 Drizzle migrations, Queue consumer.

## 2. Professor auth + Slack setup

공유 계약(#1): `packages/contracts/src/api.ts`의 Zod 스키마와 `@teamplanet/contracts/fixtures`를 인증 API(#2)·로그인 화면(#4)의 공통 출발점으로 사용한다. `docs/API_CONTRACT.md`에 HTTP 상태·쿠키·소유권·ID 규칙을 정의한다. 실제 인증·권한·Slack·동의 gate 및 정책 승인은 각 후속 이슈에서 구현/확인한다.

OTP email sign-in, Slack OAuth code flow, team/channel setup wizard, bot membership check, consent gate and activate.

#5 승인 정책: 성인 4명×20팀·약 2개월의 내부 파일럿. 교수 오프라인 동의 확보 → 학생 QR 재확인 → 동의자 Slack 초대/서버 gate를 사용한다. 대체 평가·가입/개정 전용 UI는 제외하고 전제 위반 시 차단·교수 안내를 유지한다. 상세 상태표는 `docs/PRIVACY_AND_DATA.md`다.

## 3. Data capture

비동기 기반(#10): 공유 `QueueEnvelope`와 `@teamplanet/queue`의 producer/lease/checkpoint 계약을 사용한다. 실제 수집/분석 handler는 소유권·동의·범위를 검증한 뒤 등록한다. 단일 production 작업 큐/DLQ와 Consumer의 배포·복구 절차는 `docs/QUEUE_OPERATIONS.md`를 따른다.

Events API signature validation, event dedupe, thread context, edit/delete events, image references and access, history/backfill policies.

#11/#12/#13은 원문·이미지를 영구 DB/Queue/로그에 복제하지 않고 참조·revision/지문·요약을 보관한다. 분석/재개/열람 검증 때 허용 기간의 Slack 원문을 다시 조회한다. 기존 원문 저장 초안은 구현 PR의 신규 schema/migration으로 조정하며 적용 SQL/동의 이력 트리거를 삭제하지 않는다.

## 4. Three-model analysis

Run-state machine, chunk pipeline on full in-scope logs, model-ID config, stage schemas, source ID integrity validation, provider 402 normalized errors.

## 5. Professor dashboard

Period picker, launch/progress UI, 4-competency qualitative outcomes, click-through evidence, uncertainty/review, finalize audit trail.

#22/#23은 열람·확정·출력 전 원문/요약 재검증과 불일치 링크 제외·교수 확정본까지 무효화/재검토를 연결한다. 학생 QR #29(M2), 웹 문의 #30(M5), 교수 리포트 출력 #31(M5)을 #24 E2E의 선행 작업으로 추적한다. 문의는 접수 후 교수 설정 n일 자동 삭제, 요약·리포트 등은 수업 종료 후 3개월 삭제다. 학생용 평가 열람 포털은 제외한다.

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
