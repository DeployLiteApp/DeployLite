import type { Deployment, Project } from "@deploylite/contracts";
import { describe, expect, it } from "vitest";
import {
  orderProjectLaunchSummaries,
  summarizeProjectLaunch,
  type ProjectLaunchSummary
} from "./project-launch-hub.js";

describe("orderProjectLaunchSummaries", () => {
  it("prioritizes missing runtime before failed or canceled deployments and ordinary rows", () => {
    const summaries = [
      createSummary("ordinary", { status: "succeeded" }),
      createSummary("failed", { status: "failed" }),
      createSummary("needs-command", { configured: false, status: "failed" }),
      createSummary("canceled", { status: "canceled" })
    ];

    expect(orderProjectLaunchSummaries(summaries).map((summary) => summary.project.id)).toEqual([
      "needs-command",
      "failed",
      "canceled",
      "ordinary"
    ]);
  });

  it("preserves source order within every priority", () => {
    const summaries = [
      createSummary("ordinary-a", { status: "succeeded" }),
      createSummary("attention-a", { status: "failed" }),
      createSummary("needs-command-a", { configured: false }),
      createSummary("ordinary-b"),
      createSummary("attention-b", { status: "canceled" }),
      createSummary("needs-command-b", { configured: false })
    ];

    expect(orderProjectLaunchSummaries(summaries).map((summary) => summary.project.id)).toEqual([
      "needs-command-a",
      "needs-command-b",
      "attention-a",
      "attention-b",
      "ordinary-a",
      "ordinary-b"
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(orderProjectLaunchSummaries([])).toEqual([]);
  });

  it("does not mutate the input array or its summaries", () => {
    const summaries = [
      createSummary("ordinary", { status: "succeeded" }),
      createSummary("needs-command", { configured: false })
    ];
    const originalSummaries = structuredClone(summaries);

    const ordered = orderProjectLaunchSummaries(summaries);

    expect(ordered).not.toBe(summaries);
    expect(summaries).toEqual(originalSummaries);
    expect(ordered[0]).toBe(summaries[1]);
    expect(ordered[1]).toBe(summaries[0]);
  });
});

type SummaryOptions = { configured?: boolean; status?: Deployment["status"] };

function createSummary(id: string, options: SummaryOptions = {}): ProjectLaunchSummary {
  const configured = options.configured ?? true;
  const project: Project = {
    ...projectFixture,
    id,
    name: id,
    runCommand: configured ? projectFixture.runCommand : null,
    port: configured ? projectFixture.port : null
  };
  const deployments: Deployment[] = options.status
    ? [{ ...deploymentFixture, id: `deployment-${id}`, projectId: id, status: options.status }]
    : [];

  return summarizeProjectLaunch(project, deployments);
}

const projectFixture: Project = {
  id: "project-fixture",
  name: "Project fixture",
  repoUrl: "https://github.com/example/project-fixture",
  defaultBranch: "main",
  buildCommand: "pnpm build",
  runCommand: "node server.js",
  port: 3000,
  description: null,
  imageTag: null
};

const deploymentFixture: Deployment = {
  id: "deployment-fixture",
  projectId: "project-fixture",
  agentId: "agent-fixture",
  status: "running",
  commitSha: "abcdef1",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null
};
