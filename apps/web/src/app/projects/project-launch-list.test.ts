import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, expect, it } from "vitest";
import type { ProjectLaunchSummary } from "./project-launch-hub.js";
import { ProjectLaunchList } from "./project-launch-list.js";

function summary(id: string, status: ProjectLaunchSummary["latest"]["statusTone"] = "muted"): ProjectLaunchSummary {
  const deployed = status !== "muted";
  return {
    project: { id, name: `Project ${id}`, repoUrl: `https://github.com/example/${id}`, defaultBranch: "main", buildCommand: null, runCommand: "pnpm start", port: 3000, description: null, imageTag: null },
    runtime: { configured: true, label: "Configured", detail: "pnpm start → port 3000" },
    latest: { deployment: deployed ? { id: `${id}-deployment`, projectId: id, agentId: `${id}-agent`, status: "succeeded", commitSha: "abc", startedAt: "2026-08-02T12:00:00.000Z", finishedAt: null } : null, statusLabel: deployed ? "succeeded" : "Not run", statusTone: status },
    nextAction: { label: deployed ? "Inspect latest logs" : "Deploy latest", ctaKey: deployed ? "inspect-latest-logs" : "deploy-latest", href: `/projects/${id}#deploy-actions` },
    hasLatestDeployment: deployed,
    logsHref: deployed ? `/deployments/${id}-deployment` : null,
    configureHref: `/projects/${id}#env-metadata`,
    deployHref: `/projects/${id}#deploy-actions`
  };
}

describe("ProjectLaunchList", () => {
  it("renders rows in source order with runtime, latest status, and action links", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectLaunchList, { rows: [summary("first"), summary("second", "ready")] }));
    expect(html.indexOf('data-project-id="first"')).toBeLessThan(html.indexOf('data-project-id="second"'));
    expect(html).toContain("Configured");
    expect(html).toContain("Not run");
    expect(html).toContain("succeeded");
    expect(html).toContain('href="/projects/first#deploy-actions"');
    expect(html).toContain('href="/deployments/second-deployment"');
  });

  it("exposes stable row and action semantics for keyboard users", () => {
    const html = renderToStaticMarkup(React.createElement(ProjectLaunchList, { rows: [summary("one")] }));
    expect(html).toContain('data-testid="project-launch-row"');
    expect(html).toContain('data-testid="project-launch-actions"');
    expect(html).toContain('aria-label="Configure runtime for Project one"');
    expect(html).toContain('aria-label="Open deploy panel for Project one"');
  });
});
