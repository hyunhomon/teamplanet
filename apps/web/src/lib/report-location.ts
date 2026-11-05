import { runIdSchema, studentIdSchema } from "@teamplanet/contracts";
export type ReportLocation = { run: string; student: string };
export function readReportLocation(search: string, state: unknown): ReportLocation | null {
  const params = new URLSearchParams(search);
  const saved = state && typeof state === "object" && "teamplanetReport" in state ? state.teamplanetReport : null;
  const reference = params.has("run") || params.has("student") ? { run: params.get("run"), student: params.get("student") } : saved;
  if (!reference || typeof reference !== "object" || !("run" in reference) || !("student" in reference)) return null;
  const run = runIdSchema.safeParse(reference.run), student = studentIdSchema.safeParse(reference.student);
  return run.success && student.success ? { run: run.data, student: student.data } : null;
}
export function reportLocationState(state: unknown, location: ReportLocation | null) {
  return { ...(state && typeof state === "object" ? state : {}), teamplanetReport: location };
}
