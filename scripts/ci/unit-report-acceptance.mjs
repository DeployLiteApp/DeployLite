import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validateUnitReport(report, label) {
  const cases = report?.testResults?.flatMap(result => result.assertionResults ?? []) ?? [];
  if (report?.success !== true || !Number.isSafeInteger(report.numTotalTests) || report.numTotalTests < 1
      || report.numTotalTests !== report.numPassedTests || report.numPendingTests !== 0 || report.numFailedTests !== 0
      || cases.length !== report.numTotalTests || cases.some(result => result.status !== "passed")) {
    throw new Error(`Incomplete unit execution: ${label}`);
  }
  return report.numPassedTests;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let projects = 0, passed = 0;
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(group, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = `${group}/${entry.name}`;
      if (!existsSync(`${directory}/vitest.config.ts`)) continue;
      const pkg = JSON.parse(readFileSync(`${directory}/package.json`, "utf8"));
      if (!pkg.scripts?.test) throw new Error(`Missing unit test command: ${directory}`);
      passed += validateUnitReport(JSON.parse(readFileSync(`${directory}/.ci-unit-report.json`, "utf8")), directory);
      projects += 1;
    }
  }
  if (projects === 0) throw new Error("Missing unit projects");
  process.stdout.write(`Verified ${projects} unit projects, ${passed} passed, zero skipped or failed.\n`);
}
