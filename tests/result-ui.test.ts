import { expect, test } from "bun:test";
import { resultFixture } from "./helpers/result";
import { ResultController } from "../apps/web/src/lib/results";
test("viewer uses owned result/evidence/message contracts and clears stale content on revalidation failure", async () => {
  const f = await resultFixture();
  try {
    const controller = new ResultController(f.run.id, () => {}, ((url, init) => f.app.request(`https://synthetic${url}`, init, f.env)) as unknown as typeof fetch);
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

