import { expect, test } from "bun:test";
import { inspectAnalysisSecretNames } from "../scripts/analysis-secret-status";
const env = { CLOUDFLARE_ACCOUNT_ID: "d09b11497e0618d6dceff0559855a7b2", CLOUDFLARE_API_TOKEN: "synthetic-token" };
test("CD reports only required secret names and never claims to validate their values", async () => {
  const status = await inspectAnalysisSecretNames(env, async () => Response.json({ success: true, result: [{ name: "SLACK_TOKEN_KEY" }, { name: "OPENROUTER_API_KEY", value: "synthetic-must-not-escape" }] }));
  expect(status).toEqual({ status: "names_present", missing: [] }); expect(JSON.stringify(status)).not.toContain("synthetic");
  expect(await inspectAnalysisSecretNames(env, async () => Response.json({ success: true, result: [{ name: "SLACK_TOKEN_KEY" }] }))).toEqual({ status: "missing", missing: ["OPENROUTER_API_KEY"] });
});
test("authorization, malformed metadata and wrong account are unverified rather than missing", async () => {
  expect(await inspectAnalysisSecretNames(env, async () => new Response("synthetic-private-body", { status: 403 }))).toEqual({ status: "unverified", missing: [], httpStatus: 403 });
  expect(await inspectAnalysisSecretNames(env, async () => Response.json({ success: false }))).toEqual({ status: "unverified", missing: [] });
  expect(await inspectAnalysisSecretNames(env, async () => Response.json({ success: true, result: [null] }))).toEqual({ status: "unverified", missing: [] });
  let fetched = false;
  await inspectAnalysisSecretNames({ ...env, CLOUDFLARE_ACCOUNT_ID: "wrong-account" }, async () => { fetched = true; throw Error("must not fetch"); });
  expect(fetched).toBe(false);
});
