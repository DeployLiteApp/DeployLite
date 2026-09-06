import type { Agent, Deployment, Project } from "@deploylite/contracts";
import { describe, expect, it } from "vitest";
import { formatRelativeTime, getDashboardActivity, getDashboardMetrics, summarizeDashboardStatuses } from "./dashboard-view-model.js";

const project = { id: "project-1", name: "DeployLite" } as Project;
const agent = { id: "agent-1" } as Agent;
const deployment = (id: string, status: Deployment["status"], startedAt: string): Deployment => ({ id, projectId: "project-1", agentId: "agent-1", status, commitSha: "abcdef1", startedAt, finishedAt: null });

describe("dashboard view model", () => {
  it("uses loaded collections and leaves unavailable environments explicit", () => {
    expect(getDashboardMetrics([project], [deployment("dep-1", "running", "2026-01-01T00:00:00.000Z")], [agent]).map(({ value }) => value)).toEqual([1, 1, 1, null]);
  });

  it("sorts activity by loaded deployment time and groups queued work as in progress", () => {
    const rows = [deployment("old", "succeeded", "2026-01-01T00:00:00.000Z"), deployment("new", "queued", "2026-01-02T00:00:00.000Z")];
    expect(getDashboardActivity(rows, [project]).map(({ id }) => id)).toEqual(["new", "old"]);
    expect(summarizeDashboardStatuses(rows)).toEqual([
      { label: "Successful", count: 1, tone: "success" }, { label: "Failed", count: 0, tone: "danger" },
      { label: "In progress", count: 1, tone: "info" }, { label: "Cancelled", count: 0, tone: "warning" }
    ]);
  });

  it("formats honest relative timestamps without fabricating data", () => {
    expect(formatRelativeTime("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T01:02:00.000Z"))).toBe("1h ago");
    expect(getDashboardActivity([deployment("missing", "failed", "2026-01-01T00:00:00.000Z")], []) [0]?.projectName).toBe("Project unavailable");
  });
});
