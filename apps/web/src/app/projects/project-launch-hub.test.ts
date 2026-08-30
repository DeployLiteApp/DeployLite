import type { Deployment, Project } from "@deploylite/contracts";
import { describe, expect, it } from "vitest";
import {
  getLatestDeploymentForProject,
  orderProjectLaunchSummaries,
  summarizeProjectLaunch,
  summarizeProjectLatest,
  summarizeProjectNextAction,
  summarizeProjectRuntime
} from "./project-launch-hub.js";

const createProject = (overrides: Partial<Project> = {}): Project => ({
  id: "project-alpha",
  name: "Alpha",
  repoUrl: "https://github.com/example/alpha",
  defaultBranch: "main",
  buildCommand: "pnpm build",
  runCommand: "node server.js",
  port: 3000,
  description: null,
  imageTag: null,
  ...overrides
});

const createDeployment = (overrides: Partial<Deployment> = {}): Deployment => ({
  id: "deployment-alpha",
  projectId: "project-alpha",
  agentId: "agent-alpha",
  status: "queued",
  commitSha: "abcdef1",
  startedAt: "2026-05-01T09:00:00.000Z",
  finishedAt: null,
  ...overrides
});

describe("project launch hub helpers", () => {
  it("classifies valid, missing, and invalid runtime configuration", () => {
    expect(summarizeProjectRuntime(createProject())).toEqual({
      configured: true,
      label: "Configured",
      detail: "node server.js → port 3000"
    });

    expect(summarizeProjectRuntime(createProject({ runCommand: null, port: null }))).toEqual({
      configured: false,
      label: "Needs command",
      detail: "Set a run command and port before triggering useful deploys."
    });

    const expectedInvalidRuntime = {
      configured: false,
      label: "Needs command",
      detail: "Set a run command and port before triggering useful deploys."
    };

    expect(summarizeProjectRuntime(createProject({ runCommand: "", port: 3000 }))).toEqual(expectedInvalidRuntime);
    expect(summarizeProjectRuntime(createProject({ runCommand: "node server.js", port: 0 }))).toEqual(expectedInvalidRuntime);
    expect(summarizeProjectRuntime(createProject({ port: 65536 }))).toEqual(expectedInvalidRuntime);
  });

  it("selects the latest target-project deployment by actual start time", () => {
    const deployments = [
      createDeployment({ id: "other-newer", projectId: "project-other", startedAt: "2026-05-01T11:00:00.000Z" }),
      createDeployment({ id: "target-earlier", startedAt: "2026-05-01T10:00:00.000+02:00" }),
      createDeployment({ id: "target-latest", startedAt: "2026-05-01T09:30:00.000Z" })
    ];

    expect(getLatestDeploymentForProject(deployments, "project-alpha")).toBe(deployments[2]);
    expect(getLatestDeploymentForProject(deployments, "project-missing")).toBeNull();
  });

  it("maps absent, terminal, and active deployments to established statuses", () => {
    expect(summarizeProjectLatest(null)).toEqual({ deployment: null, statusLabel: "Not run", statusTone: "muted" });

    const cases: Array<[Deployment["status"], string, "ready" | "attention" | "active"]> = [
      ["succeeded", "succeeded", "ready"],
      ["failed", "failed", "attention"],
      ["canceled", "canceled", "attention"],
      ["queued", "queued", "active"],
      ["running", "running", "active"]
    ];

    for (const [status, statusLabel, statusTone] of cases) {
      const deployment = createDeployment({ id: `deployment-${status}`, status });
      expect(summarizeProjectLatest(deployment)).toEqual({ deployment, statusLabel, statusTone });
    }
  });

  it("selects configure, deploy, and inspect-log actions with exact targets", () => {
    const project = createProject();
    const failedDeployment = createDeployment({ id: "deployment-failed", status: "failed" });
    const canceledDeployment = createDeployment({ id: "deployment-canceled", status: "canceled" });

    expect(summarizeProjectNextAction(createProject({ runCommand: null }), failedDeployment)).toEqual({
      label: "Configure runtime",
      ctaKey: "configure-runtime",
      href: "/projects/project-alpha#env-metadata"
    });
    expect(summarizeProjectNextAction(project, null)).toEqual({
      label: "Deploy latest",
      ctaKey: "deploy-latest",
      href: "/projects/project-alpha#deploy-actions"
    });
    expect(summarizeProjectNextAction(project, failedDeployment)).toEqual({
      label: "Inspect latest logs",
      ctaKey: "inspect-latest-logs",
      href: "/deployments/deployment-failed"
    });
    expect(summarizeProjectNextAction(project, canceledDeployment)).toEqual({
      label: "Inspect latest logs",
      ctaKey: "inspect-latest-logs",
      href: "/deployments/deployment-canceled"
    });
  });

  it("composes the complete launch summary from independently constructed expected fields", () => {
    const project = createProject();
    const deployment = createDeployment({ id: "deployment-succeeded", status: "succeeded" });
    const deployments = [createDeployment({ id: "other", projectId: "project-other" }), deployment];
    const expectedRuntime = {
      configured: true,
      label: "Configured",
      detail: "node server.js → port 3000"
    };
    const expectedLatest = {
      deployment,
      statusLabel: "succeeded",
      statusTone: "ready" as const
    };
    const expectedNextAction = {
      label: "Inspect latest logs",
      ctaKey: "inspect-latest-logs" as const,
      href: "/deployments/deployment-succeeded"
    };
    const expectedSummary = {
      project,
      runtime: expectedRuntime,
      latest: expectedLatest,
      nextAction: expectedNextAction,
      hasLatestDeployment: true,
      logsHref: "/deployments/deployment-succeeded",
      configureHref: "/projects/project-alpha#env-metadata",
      deployHref: "/projects/project-alpha#deploy-actions"
    };

    expect(summarizeProjectLaunch(project, deployments)).toEqual(expectedSummary);
  });

  it("is deterministic, preserves input values, and has no transport dependency", () => {
    const project = createProject();
    const deployments = [
      createDeployment({ id: "deployment-one", startedAt: "2026-05-01T09:00:00.000Z" }),
      createDeployment({ id: "deployment-two", startedAt: "2026-05-01T10:00:00.000Z" })
    ];
    const originalProject = structuredClone(project);
    const originalDeployments = structuredClone(deployments);

    const first = {
      latest: getLatestDeploymentForProject(deployments, project.id),
      runtime: summarizeProjectRuntime(project),
      launch: summarizeProjectLaunch(project, deployments)
    };
    const second = {
      latest: getLatestDeploymentForProject(deployments, project.id),
      runtime: summarizeProjectRuntime(project),
      launch: summarizeProjectLaunch(project, deployments)
    };

    expect(second).toEqual(first);
    expect(project).toEqual(originalProject);
    expect(deployments).toEqual(originalDeployments);
  });
});

describe("orderProjectLaunchSummaries", () => {
  it("prioritizes missing runtime before failed or canceled deployments and ordinary rows", () => {
    const summaries = [
      summarizeProjectLaunch(createProject({ id: "ordinary" }), [createDeployment({ projectId: "ordinary", status: "succeeded" })]),
      summarizeProjectLaunch(createProject({ id: "failed" }), [createDeployment({ projectId: "failed", status: "failed" })]),
      summarizeProjectLaunch(createProject({ id: "needs-command", runCommand: null, port: null }), [createDeployment({ projectId: "needs-command", status: "failed" })]),
      summarizeProjectLaunch(createProject({ id: "canceled" }), [createDeployment({ projectId: "canceled", status: "canceled" })])
    ];

    expect(orderProjectLaunchSummaries(summaries).map(({ project }) => project.id)).toEqual([
      "needs-command", "failed", "canceled", "ordinary"
    ]);
  });

  it("preserves source order within every priority and does not mutate input", () => {
    const summaries = [
      summarizeProjectLaunch(createProject({ id: "ordinary-a" }), []),
      summarizeProjectLaunch(createProject({ id: "attention-a" }), [createDeployment({ projectId: "attention-a", status: "failed" })]),
      summarizeProjectLaunch(createProject({ id: "needs-command-a", runCommand: null, port: null }), []),
      summarizeProjectLaunch(createProject({ id: "ordinary-b" }), []),
      summarizeProjectLaunch(createProject({ id: "attention-b" }), [createDeployment({ projectId: "attention-b", status: "canceled" })]),
      summarizeProjectLaunch(createProject({ id: "needs-command-b", runCommand: null, port: null }), [])
    ];
    const original = [...summaries];

    const ordered = orderProjectLaunchSummaries(summaries);

    expect(ordered.map(({ project }) => project.id)).toEqual([
      "needs-command-a", "needs-command-b", "attention-a", "attention-b", "ordinary-a", "ordinary-b"
    ]);
    expect(ordered).not.toBe(summaries);
    expect(summaries).toEqual(original);
  });

  it("returns an empty array for empty input", () => {
    expect(orderProjectLaunchSummaries([])).toEqual([]);
  });
});
