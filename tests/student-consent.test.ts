import { expect, test } from "bun:test";
import { StudentConsentController } from "../apps/web/src/lib/student-consent";
const token = "A".repeat(43);
const info = { courseName: "합성 수업", teamName: "합성 팀", studentDisplayName: "합성 학생", version: "synthetic-v1", professorEmail: "prof@example.invalid", expiresAt: "2027-01-01T00:00:00.000Z", confirmedAt: null as string | null };
function harness(fragment = `#${token}`) {
  const calls: { url: string; init: RequestInit }[] = [];
  let confirmed = false, blocked = false;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    if (blocked) return Response.json({}, { status: 404 });
    if (String(url).endsWith("/confirm")) { confirmed = true; return Response.json({ confirmedAt: "2026-11-02T00:00:00.000Z" }); }
    return Response.json({ ...info, confirmedAt: confirmed ? "2026-11-02T00:00:00.000Z" : null });
  }) as typeof fetch;
  return { controller: new StudentConsentController(fragment, fetcher, () => Date.parse("2026-11-02T00:00:00.000Z")), calls, block: () => { blocked = true; } };
}
test("missing/forged fragment causes no network request or grant", async () => {
  for (const fragment of ["", "#wrong", "#" + token + "?student=other"]) {
    const h = harness(fragment); await h.controller.lookup(); await h.controller.confirm(true);
    expect(h.calls).toHaveLength(0); expect(h.controller.getSnapshot().phase).toBe("blocked");
  }
});
test("lookup never grants consent; unchecked submit cannot send and successful submit is revalidated", async () => {
  const h = harness(); await h.controller.lookup(); await h.controller.confirm(false);
  expect(h.calls).toHaveLength(1); expect(h.controller.getSnapshot().phase).toBe("review");
  await h.controller.confirm(true);
  expect(h.controller.getSnapshot().phase).toBe("confirmed");
  expect(h.calls.map(c => c.url)).toEqual(["/v1/consent-confirmations/lookup", "/v1/consent-confirmations/confirm", "/v1/consent-confirmations/lookup"]);
  for (const call of h.calls) {
    expect(call.url).not.toContain(token); expect(call.init.credentials).toBe("omit"); expect(call.init.cache).toBe("no-store");
  }
  expect(JSON.parse(String(h.calls[1]!.init.body))).toEqual({ token, confirmed: true });
  await h.controller.confirm(true); expect(h.calls).toHaveLength(3);
});
test("revoked or expired links remove identity and cannot show success", async () => {
  const h = harness(); await h.controller.lookup(); h.block(); await h.controller.confirm(true);
  expect(h.controller.getSnapshot().phase).toBe("blocked"); expect(h.controller.getSnapshot().details).toBeNull();
});
test("disposing prevents a late lookup from rendering identity or allowing a submit", async () => {
  let resolve!: (r: Response) => void;
  const fetcher = (() => new Promise<Response>(done => { resolve = done; })) as unknown as typeof fetch;
  const controller = new StudentConsentController(`#${token}`, fetcher);
  const pending = controller.lookup(); controller.dispose(); resolve(Response.json(info)); await pending;
  expect(controller.getSnapshot().details).toBeNull();
});

test("malformed success and transport errors never expose a token or fabricate confirmation", async () => {
  for (const fetcher of [async () => Response.json({ ...info, professorEmail: undefined }), async () => { throw new Error(token); }]) {
    const controller = new StudentConsentController(`#${token}`, fetcher);
    await controller.lookup();
    expect(controller.getSnapshot().phase).toBe("blocked"); expect(controller.getSnapshot().details).toBeNull();
    expect(controller.getSnapshot().error).not.toContain(token);
  }
});
