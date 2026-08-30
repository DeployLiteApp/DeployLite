import type { Deployment } from "@deploylite/contracts";
import { describe, expect, it } from "vitest";
import { deploymentStatusFilterOptions, filterDeploymentsByStatus } from "./deployment-history-status-filter-model.js";

const statuses: Deployment["status"][] = ["queued", "running", "succeeded", "failed", "canceled"];
function deployment(id: string, status: Deployment["status"]): Deployment {
  return { id, projectId: `project-${id}`, agentId: "agent-1", status, commitSha: "abcdef1", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null };
}
const history = statuses.map((status, index) => deployment(`dep-${index + 1}`, status));

describe("deploymentStatusFilterOptions", () => {
  it("exposes All statuses followed by the complete contract vocabulary", () => {
    expect(deploymentStatusFilterOptions).toEqual([
      { value: "all", label: "All statuses" }, { value: "queued", label: "queued" },
      { value: "running", label: "running" }, { value: "succeeded", label: "succeeded" },
      { value: "failed", label: "failed" }, { value: "canceled", label: "canceled" }
    ]);
  });
});

describe("filterDeploymentsByStatus", () => {
  it("returns only exact matches for every supported status", () => {
    for (const status of statuses) expect(filterDeploymentsByStatus(history, status)).toEqual([history[statuses.indexOf(status)]]);
  });
  it("preserves relative order of interleaved matches", () => {
    const interleaved = [deployment("dep-1", "running"), deployment("dep-2", "failed"), deployment("dep-3", "running")];
    expect(filterDeploymentsByStatus(interleaved, "running").map(({ id }) => id)).toEqual(["dep-1", "dep-3"]);
  });
  it("returns a shallow copy for All statuses without mutating source", () => {
    const result = filterDeploymentsByStatus(history, "all");
    expect(result).toEqual(history);
    expect(result).not.toBe(history);
    result.reverse();
    expect(history.map(({ id }) => id)).toEqual(["dep-1", "dep-2", "dep-3", "dep-4", "dep-5"]);
  });
  it("does not mutate source rows when filters are selected repeatedly", () => {
    const before = history.map((row) => ({ ...row }));
    filterDeploymentsByStatus(history, "failed"); filterDeploymentsByStatus(history, "all"); filterDeploymentsByStatus(history, "queued");
    expect(history).toEqual(before);
    expect(filterDeploymentsByStatus(history, "failed")[0]).toBe(history[3]);
  });
});
