import { expect, test } from "bun:test";
import { resultFixture } from "./helpers/result";
import { ResultController } from "../apps/web/src/lib/results";
import { AnalysisHistory } from "../apps/web/src/components/ResultViewer";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resultResponseSchema } from "@teamplanet/contracts";

test("review history exposes original and corrected uncertainty with student and competency attribution", async () => {
  const f = await resultFixture();
  try {
    const result = resultResponseSchema.parse(await (await f.call(`analysis-runs/${f.run.id}/assessments`)).json()), a = result.artifacts;
    a.originalAssessment.assessments[0]!.limitations = ["원래 초안에만 기록된 한계"];
    a.firstReview.limitations = ["최초 검토에만 기록된 한계"];
    a.correction = { version: "analysis-stages-v1", iteration: 1, resolvedIssueIds: [], assessment: structuredClone(a.originalAssessment) };
    a.correction.assessment.overviews[0]!.limitations = ["수정 개요에만 기록된 한계"];
    a.finalReview = { ...a.finalReview, iteration: 1, decision: "human_review", requiresHumanReview: true, limitations: ["마지막 검토 한계"] };
    const html = renderToStaticMarkup(createElement(AnalysisHistory, { result }));
    for (const text of ["원래 초안에만 기록된 한계", "최초 검토에만 기록된 한계", "수정 개요에만 기록된 한계", "마지막 검토 한계", "사람 검토", "합성 학생"]) expect(html).toContain(text);
  } finally { f.sqlite.close(); }
});
test("viewer uses owned result/evidence/message contracts and clears stale content on revalidation failure", async () => {
  const f = await resultFixture();
  try {
    const controller = new ResultController(f.run.id, () => {}, ((url: string | URL | Request, init?: RequestInit) => f.app.request(`https://synthetic${url}`, init, f.env)) as unknown as typeof fetch);
    await controller.load(); expect(controller.getSnapshot().result?.artifacts.candidate.assessments).toHaveLength(1);
    await controller.openEvidence(f.artifacts.evidence[0]!.id); await controller.openMessage(f.artifacts.evidence[0]!.messageIds[0]!);
    expect(controller.getSnapshot().context?.messages[0]!.text).toBe(f.text);
    f.outage(); await controller.load(); expect(controller.getSnapshot().result).toBeNull(); expect(controller.getSnapshot().context).toBeNull(); expect(controller.getSnapshot().error).toContain("삭제로 판단하지 않았");
  } finally { f.sqlite.close(); }
});
test("unknown fetch error never exposes upstream tokens or source text", async () => {
  const controller = new ResultController("run_00000000-0000-4000-8000-000000000022", () => {}, (async () => { throw Error("secret raw source"); }) as unknown as typeof fetch);
  await controller.load(); expect(controller.getSnapshot().error).not.toContain("secret");
});
test("session loss cannot revive the viewer", async () => {
  let expired = false;
  const controller = new ResultController("run_00000000-0000-4000-8000-000000000022", () => { expired = true; }, (async () => Response.json({}, { status: 401 })) as unknown as typeof fetch);
  await controller.load(); expect(expired).toBe(true); expect(controller.getSnapshot().result).toBeNull();
});

