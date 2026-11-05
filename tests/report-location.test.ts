import { expect, test } from "bun:test";
import { readReportLocation, reportLocationState } from "../apps/web/src/lib/report-location";
const selected = { run: "run_00000000-0000-4000-8000-000000000001", student: "student_00000000-0000-4000-8000-000000000001" };
test("report refresh restores only validated references after the printable URL is cleaned", () => {
  const reference = readReportLocation(`?run=${selected.run}&student=${selected.student}`, null);
  const state = reportLocationState({ navigation: 1 }, reference);
  expect(state).toEqual(expect.objectContaining({ navigation: 1, teamplanetReport: selected }));
  expect(readReportLocation("", state)).toEqual(selected);
});
test("an explicit malformed or partial report link never falls back to a previously viewed student", () => {
  const state = reportLocationState(null, selected);
  expect(readReportLocation("?run=invalid", state)).toBeNull();
  expect(readReportLocation(`?student=${selected.student}`, state)).toBeNull();
  expect(readReportLocation("", { teamplanetReport: { run: selected.run, student: "invalid" } })).toBeNull();
});
