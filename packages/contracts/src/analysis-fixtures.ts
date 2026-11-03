import { analysisContractVersion, type EvidenceInput, type NormalizedEvidence } from "./analysis";
import { students } from "./fixtures";
export const analysisFixtureRunId = "run_00000000-0000-4000-8000-000000000016";
export const analysisFixtureMessageId = "message_00000000-0000-4000-8000-000000000016";
export const analysisFixtureEvidenceId = "evidence_00000000-0000-4000-8000-000000000016";
const text = "모바일 로그인 직후 빈 목록입니다. 새로고침하면 정상입니다.";
const partId = "part_00000000-0000-4000-8000-000000000016_0";
export const evidenceInputFixture: EvidenceInput = {
  version: analysisContractVersion, runId: analysisFixtureRunId, chunkId: "chunk_0",
  limitations: [],
  period: { from: "2026-11-01T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z", timezone: "Asia/Seoul" },
  selection: { rubricVersion: "communication-v1", selectedCompetencies: ["clarity"] },
  students: [{ id: students[0]!.id, displayName: "합성 학생 A" }], primaryPartIds: [partId],
  parts: [{ id: partId, messageId: analysisFixtureMessageId, start: 0, end: text.length, utf8Bytes: new TextEncoder().encode(text).length,
    imageIds: [], threadId: null, limitations: [], text, studentId: students[0]!.id, images: [], sentAt: "2026-11-01T00:00:01.000Z" }],
};
export const evidenceOutputFixture = { version: analysisContractVersion, processedPartIds: [partId], limitations: [], events: [{
  messageIds: [analysisFixtureMessageId], actorIds: [students[0]!.id], summary: "재현 조건과 관찰 결과를 구체화한 발화가 있다.", behaviorTags: ["clarity"], modality: "text",
  citations: [{ partId, start: 0, end: text.length, quote: text }], imageCitations: [], limitations: ["단일 합성 사건이다."], requiresHumanReview: false,
}] };
export const normalizedEvidenceFixture: NormalizedEvidence = { id: analysisFixtureEvidenceId, messageIds: [analysisFixtureMessageId], actorIds: [students[0]!.id],
  summary: "재현 조건과 관찰 결과를 구체화한 발화가 있다.", behaviorTags: ["clarity"], modality: "text", imageIds: [],
  citations: [{ messageId: analysisFixtureMessageId, start: 0, end: text.length, hash: "0".repeat(64) }], limitations: ["합성 지문이며 실제 검증 지문이 아니다."], requiresHumanReview: false };
export const assessmentInputFixture = { ...evidenceInputFixture, chunkId: undefined, primaryPartIds: undefined, evidence: [normalizedEvidenceFixture], correction: null };
// Strict contracts intentionally have no surplus A-only fields.
delete (assessmentInputFixture as Partial<typeof assessmentInputFixture>).chunkId;
delete (assessmentInputFixture as Partial<typeof assessmentInputFixture>).primaryPartIds;
export const assessmentOutputFixture = { version: analysisContractVersion, runId: analysisFixtureRunId,
  overviews: [{ studentId: students[0]!.id, summary: "관찰 가능한 재현 조건 설명 사례가 있다.", limitations: ["기간 전체 일반화 금지"], requiresHumanReview: false }],
  assessments: [{ studentId: students[0]!.id, key: "clarity", judgement: "observed_strength", narrative: "문제 조건을 구체화했다.",
    evidenceIds: [analysisFixtureEvidenceId], counterEvidenceIds: [], confidence: "medium", limitations: ["합성 자료"], requiresHumanReview: false }] };
export const reviewInputFixture = { ...assessmentInputFixture, assessment: assessmentOutputFixture, iteration: 0 };
export const reviewOutputFixture = { version: analysisContractVersion, runId: analysisFixtureRunId, iteration: 0, decision: "accept", issues: [], limitations: ["실제 모델 품질 검증 아님"], requiresHumanReview: false };
export const correctionRequestFixture = { ...reviewOutputFixture, decision: "request_correction", issues: [{ id: "issue_context", code: "context_missing", studentId: students[0]!.id,
  competency: "clarity", evidenceIds: [analysisFixtureEvidenceId], messageIds: [analysisFixtureMessageId], instruction: "단일 사건의 관찰 한계를 명시하세요." }] };
export const correctionOutputFixture = { version: analysisContractVersion, iteration: 1, resolvedIssueIds: ["issue_context"], assessment: assessmentOutputFixture };
export const analysisFailureFixtures = {
  fakeCitation: { ...evidenceOutputFixture, events: [{ ...evidenceOutputFixture.events[0]!, citations: [{ partId, start: 0, end: 3, quote: "가짜행위" }] }] },
  fakeActor: { ...evidenceOutputFixture, events: [{ ...evidenceOutputFixture.events[0]!, actorIds: [students[1]!.id] }] },
  missingStudent: { ...assessmentOutputFixture, assessments: [] },
  fakeEvidence: { ...assessmentOutputFixture, assessments: [{ ...assessmentOutputFixture.assessments[0]!, evidenceIds: ["evidence_00000000-0000-4000-8000-000000009999"] }] },
  secondCorrection: { ...correctionRequestFixture, iteration: 1 },
  error: { error: { code: "CONFLICT", message: "전체 기간 coverage 또는 현재 입력을 확인하세요.", requestId: "request_00000000-0000-4000-8000-000000000016", retryable: false } },
};
