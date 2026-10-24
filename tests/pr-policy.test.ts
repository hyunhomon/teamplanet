import { expect, test } from "bun:test";
import { checkPrPolicy } from "../.github/scripts/check-pr-policy";

const milestone = { number: 1, state: "open" };
const pr = { body: "Closes #12", base: { ref: "main" }, milestone };
const issue = { state: "open", milestone };

test("accepts real open issues in the PR milestone and deduplicates references", async () => {
  const fetched: number[] = [];
  const result = await checkPrPolicy({ ...pr, body: "Closes #12\r\nFixes #13\nResolves #12" }, async number => {
    fetched.push(number);
    return issue;
  });
  expect(result).toEqual([12, 13]);
  expect(fetched).toEqual([12, 13]);
});

test.each([
  null,
  "Closes #<issue-number>",
  "<!-- Closes #12 -->",
  "```text\nCloses #12\n```",
  "~~~text\nCloses #12\n~~~",
  "Closes other/repo#12",
  "Closes https://github.com/other/repo/issues/12",
])("rejects absent, example, or cross-repository references: %s", async body => {
  await expect(checkPrPolicy({ ...pr, body }, async () => issue)).rejects.toThrow("standalone Closes");
});

test("rejects a non-main base", async () => {
  await expect(checkPrPolicy({ ...pr, base: { ref: "release" } }, async () => issue)).rejects.toThrow("base must be main");
});

test("requires a PR milestone", async () => {
  await expect(checkPrPolicy({ ...pr, milestone: null }, async () => issue)).rejects.toThrow("milestone to the PR");
});

test("rejects a closed PR milestone", async () => {
  await expect(checkPrPolicy({ ...pr, milestone: { ...milestone, state: "closed" } }, async () => issue))
    .rejects.toThrow("milestone to the PR");
});

test("does not accept a PR number as the linked issue", async () => {
  await expect(checkPrPolicy(pr, async () => ({ ...issue, pull_request: { url: "pr-url" } })))
    .rejects.toThrow("not an issue");
});

test("requires the issue to be open", async () => {
  await expect(checkPrPolicy(pr, async () => ({ ...issue, state: "closed" }))).rejects.toThrow("must be open");
});

test("requires an issue milestone", async () => {
  await expect(checkPrPolicy(pr, async () => ({ ...issue, milestone: null }))).rejects.toThrow("milestone to issue");
});

test("rejects a closed issue milestone", async () => {
  await expect(checkPrPolicy(pr, async () => ({ ...issue, milestone: { ...milestone, state: "closed" } })))
    .rejects.toThrow("milestone to issue");
});

test("requires matching issue and PR milestones", async () => {
  await expect(checkPrPolicy(pr, async () => ({ ...issue, milestone: { ...milestone, number: 2 } })))
    .rejects.toThrow("same milestone");
});

test("fails when any linked issue is invalid", async () => {
  await expect(checkPrPolicy({ ...pr, body: "Closes #12\nCloses #13" }, async number => (
    number === 12 ? issue : { ...issue, milestone: null }
  ))).rejects.toThrow("issue #13");
});

test("does not swallow a GitHub API failure", async () => {
  await expect(checkPrPolicy(pr, async () => { throw new Error("HTTP 404"); })).rejects.toThrow("HTTP 404");
});
