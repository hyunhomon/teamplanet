# API Contract (proposal)

Base: `/v1`; auth: professor email OTP session; standard response `application/json`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/otp/request` | 이메일 OTP 발송 |
| POST | `/auth/otp/verify` | OTP 검증 / 세션 발급 |
| GET | `/slack/install` | Slack OAuth 시작 |
| GET | `/slack/oauth/callback` | 코드 교환 / 워크스페이스 연결 |
| GET | `/slack/connection` | 설치·권한 상태 조회 |
| POST | `/teams` | 팀 및 공식 채널 설정 |
| POST | `/teams/:id/invite` | 팀원 초대 요청 |
| PUT | `/teams/:id/consents/:studentId` | 동의 상태 기록 (감사 추적 필수) |
| POST | `/teams/:id/activate` | 동의·권한 확인 후 수집 활성화 |
| POST | `/slack/events` | 서명 검증 후 이벤트 수신 |
| POST | `/analysis-runs` | `{teamId,from,to}` 분석 수동 실행 |
| GET | `/analysis-runs/:id` | 상태·진행 단계 |
| GET | `/analysis-runs/:id/assessments` | 4역량 결과 및 근거 |
| POST | `/analysis-runs/:id/finalize` | 교수 수정·확정 |

## Analysis status

`queued → collecting → evidence_extraction → assessment → review → awaiting_professor → finalized`

Error states: `blocked_provider_billing`, `failed_provider_auth`, `rate_limited`, `failed_model`, `failed_data`, `cancelled`.

평가 저장·조회 시 `CompetencyAssessment`의 `limitations`와 `requiresHumanReview`도 보존한다. DB에는 각각 `limitations_json`, `requires_human_review`로 저장하며, 교수 수정값과 별도로 AI의 검토 필요 정보를 유지한다.

## 402 — supply-side billing, not app budget

```json
{
  "error": {
    "code": "OPENROUTER_BILLING_BLOCKED",
    "kind": "insufficient_credits",
    "source": "openrouter_credits",
    "providerStatus": 402,
    "retryable": false
  }
}
```

`kind` may also be `key_limit_exhausted` or `in_flight_budget`; the last can be transient if provider indicates `Retry-After`. Never interpret transient provider concurrency budget as app-level user spending cap. Do not automatically retry ordinary depleted-credit 402.
