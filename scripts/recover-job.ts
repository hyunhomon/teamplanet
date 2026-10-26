import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { jobRecoverySchema } from "../packages/contracts/src/jobs";
import { cloudflareRequest, PRODUCTION_DATABASE } from "./cloudflare";

const { values } = parseArgs({ options: {
  key: { type: "string" }, generation: { type: "string" }, reason: { type: "string" },
  local: { type: "boolean" }, remote: { type: "boolean" }, "persist-to": { type: "string" },
} });
if (values.local === values.remote) throw new Error("Choose exactly one of --local or --remote. Recovery is an explicit operator action on one dead job.");
const input = jobRecoverySchema.parse({ key: values.key, generation: Number(values.generation), reasonRef: values.reason });
const params = [input.key, input.generation + 1, input.reasonRef, Date.now()];
const sql = "INSERT INTO job_recoveries (job_key, generation, reason_ref, recorded_at) VALUES (?, ?, ?, ?) RETURNING generation";
if (values.remote) {
  const results = await cloudflareRequest()<{ success: boolean; results: { generation: number }[] }[]>(
    `/d1/database/${PRODUCTION_DATABASE}/query`, "POST", { sql, params });
  if (results[0]?.success !== true || results[0].results[0]?.generation !== input.generation + 1) throw new Error("JOB_RECOVERY_REJECTED_OR_UNAVAILABLE");
} else {
  const quote = (value: string | number) => typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;
  let index = 0;
  const localSql = sql.replace(/\?/g, () => quote(params[index++]!));
  const command = ["node", resolve(import.meta.dir, "../node_modules/wrangler/bin/wrangler.js"), "d1", "execute", "DB",
    "--config", resolve(import.meta.dir, "../apps/api/wrangler.jsonc"), "--local", "--command", localSql];
  if (values["persist-to"]) command.push("--persist-to", resolve(values["persist-to"]));
  const process = Bun.spawn(command, { stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  if (await process.exited !== 0) throw new Error("JOB_RECOVERY_REJECTED_OR_UNAVAILABLE");
}
console.log("Recovery recorded. The scheduled dispatcher will send the new generation; committed steps are preserved.");
