import { test } from "node:test";
import assert from "node:assert/strict";
import { validateUnitReport } from "./unit-report-acceptance.mjs";
const complete = () => ({ success: true, numTotalTests: 1, numPassedTests: 1, numPendingTests: 0, numFailedTests: 0, testResults: [{ assertionResults: [{ status: "passed" }] }] });
test("accepts a fully executed report", () => assert.doesNotThrow(() => validateUnitReport(complete(), "fixture")));
for (const [name, change] of [
  ["skipped", r => { r.numPendingTests = 1; }],
  ["failed", r => { r.numFailedTests = 1; }],
  ["unsuccessful", r => { r.success = false; }],
  ["empty", r => { r.numTotalTests = 0; r.numPassedTests = 0; r.testResults = []; }],
  ["missing case", r => { r.testResults = []; }],
  ["unexecuted case hidden by totals", r => { r.testResults[0].assertionResults[0].status = "pending"; }],
  ["inconsistent passed total", r => { r.numPassedTests = 0; }],
]) test(`rejects ${name}`, () => { const report = complete(); change(report); assert.throws(() => validateUnitReport(report, "fixture"), /Incomplete unit execution/); });
