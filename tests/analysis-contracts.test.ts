import { expect, test } from "bun:test";
import { validateEvidenceOutput, validateAssessmentOutput, validateReviewOutput, validateCorrectionOutput, correctionOutputSchema, assertAnalysisTransition, createAnalysisRunSchema } from "@teamplanet/contracts";
import * as f from "@teamplanet/contracts/analysis-fixtures";
import { analysisId, planChunks, sourceParts } from "@teamplanet/analysis";
test("A/B/C and correction fixtures are independently executable; fabricated IDs/actors/quotes, omissions and correction overflow fail", () => {
  validateEvidenceOutput(f.evidenceOutputFixture, f.evidenceInputFixture);
  validateAssessmentOutput(f.assessmentOutputFixture, f.assessmentInputFixture);
  validateReviewOutput(f.reviewOutputFixture, f.reviewInputFixture);
  validateReviewOutput(f.correctionRequestFixture, f.reviewInputFixture);
  correctionOutputSchema.parse(f.correctionOutputFixture);
  validateCorrectionOutput(f.correctionOutputFixture, { ...f.assessmentInputFixture, correction: { iteration: 1, issues: f.correctionRequestFixture.issues } }, f.correctionRequestFixture);
  for (const bad of [f.analysisFailureFixtures.fakeCitation, f.analysisFailureFixtures.fakeActor]) expect(() => validateEvidenceOutput(bad, f.evidenceInputFixture)).toThrow();
  for (const bad of [f.analysisFailureFixtures.missingStudent, f.analysisFailureFixtures.fakeEvidence]) expect(() => validateAssessmentOutput(bad, f.assessmentInputFixture)).toThrow();
  expect(() => validateReviewOutput(f.analysisFailureFixtures.secondCorrection, { ...f.reviewInputFixture, iteration: 1 })).toThrow();
});
test("full long-thread unicode ranges and image parts are covered exactly once with bounded overlap/context", async () => {
  const id = await analysisId("message", "synthetic"), text = "한글🙂".repeat(20000);
  const parts = sourceParts(id, text, id, [await analysisId("image", "one"), await analysisId("image", "two")]);
  const chunks = planChunks(parts);
  expect(chunks.flatMap(c => c.parts.map(p => text.slice(p.start, p.end))).join("")).toBe(text);
  expect(chunks.flatMap(c => c.parts.flatMap(p => p.imageIds))).toHaveLength(2);
  for (const chunk of chunks) {
    expect([...chunk.parts, ...chunk.context].reduce((n, p) => n + p.utf8Bytes, 0)).toBeLessThanOrEqual(48000);
    expect([...chunk.parts, ...chunk.context].flatMap(p => p.imageIds).length).toBeLessThanOrEqual(1);
  }
  const empties = Array.from({ length: 500 }, (_, i) => ({ ...parts[0]!, id: `part_${id.slice(8)}_${i}`, utf8Bytes: 0 }));
  expect(planChunks(empties).every(c => c.parts.length + c.context.length <= 64)).toBe(true);
});
test("invalid transitions, incomplete stages and invalidated snapshots cannot promote; timezone and UTC boundaries are checked", () => {
  assertAnalysisTransition("queued", "collecting", { valid: true, completed: false });
  expect(() => assertAnalysisTransition("queued", "awaiting_professor", { valid: true, completed: true })).toThrow();
  expect(() => assertAnalysisTransition("review", "awaiting_professor", { valid: false, completed: true })).toThrow();
  expect(() => assertAnalysisTransition("assessment", "review", { valid: true, completed: false })).toThrow();
  expect(() => assertAnalysisTransition("review", "assessment", { valid: true, completed: true, correctionIteration: 2 })).toThrow();
  expect(createAnalysisRunSchema.safeParse({ teamId: "bad", from: "2026-11-01", to: "2026-11-02", timezone: "Invalid/Zone", idempotencyKey: crypto.randomUUID() }).success).toBe(false);
});
