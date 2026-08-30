import { describe, expect, it } from "vitest";
import type { ProjectLaunchSummary } from "./project-launch-hub";
import { PROJECT_RUNTIME_FILTER_OPTIONS, PROJECT_STATUS_FILTER_OPTIONS, filterProjectLaunchSummaries, isProjectRuntimeFilter, isProjectStatusFilter, parseProjectRuntimeFilter, parseProjectStatusFilter } from "./project-list-filters";

type Overrides = { name?: string; repoUrl?: string; defaultBranch?: string; status?: Exclude<(typeof PROJECT_STATUS_FILTER_OPTIONS)[number]["value"], "all">; configured?: boolean };

function createSummary(id: string, overrides: Overrides = {}): ProjectLaunchSummary {
  const status = overrides.status ?? "not-run";
  const configured = overrides.configured ?? true;
  const hasLatestDeployment = status !== "not-run";
  return {
    project: { id, name: overrides.name ?? `Project ${id}`, repoUrl: overrides.repoUrl ?? `https://github.com/example/${id}`, defaultBranch: overrides.defaultBranch ?? "main", buildCommand: null, runCommand: configured ? "pnpm start" : null, port: configured ? 3000 : null, description: null, imageTag: null },
    runtime: { configured, label: configured ? "Configured" : "Needs command", detail: configured ? "pnpm start → port 3000" : "Set a run command and port before triggering useful deploys." },
    latest: { deployment: hasLatestDeployment ? { id: `${id}-deployment`, projectId: id, agentId: `${id}-agent`, status, commitSha: "abcdef1", startedAt: "2026-08-02T12:00:00.000Z", finishedAt: null } : null, statusLabel: status === "not-run" ? "Not run" : status, statusTone: status === "not-run" ? "muted" : status === "succeeded" ? "ready" : "attention" },
    nextAction: { label: configured ? "Deploy latest" : "Configure runtime", ctaKey: configured ? "deploy-latest" : "configure-runtime", href: `/projects/${id}` },
    hasLatestDeployment, logsHref: hasLatestDeployment ? `/deployments/${id}-deployment` : null, configureHref: `/projects/${id}#env-metadata`, deployHref: `/projects/${id}#deploy-actions`
  };
}

describe("filterProjectLaunchSummaries", () => {
  it("returns every loaded row for blank and All criteria", () => {
    const rows = [createSummary("one"), createSummary("two", { configured: false })];
    expect(filterProjectLaunchSummaries(rows, { query: "   ", status: "all", runtime: "all" })).toEqual(rows);
  });

  it.each([["name", { name: "Alpha Console" }], ["repository URL", { repoUrl: "https://github.com/Example/ALPHA" }], ["default branch", { defaultBranch: "release/Alpha" }]] as const)("matches trimmed case-insensitive text in the %s", (_field, override) => {
    const row = createSummary("alpha", override);
    expect(filterProjectLaunchSummaries([row], { query: "  aLpHa  ", status: "all", runtime: "all" })).toEqual([row]);
  });

  it.each(PROJECT_STATUS_FILTER_OPTIONS)("supports the %s status option", ({ value }) => {
    const rows = PROJECT_STATUS_FILTER_OPTIONS.slice(1).map(({ value: status }) => createSummary(status, { status: status as Exclude<typeof status, "all"> }));
    expect(filterProjectLaunchSummaries(rows, { query: "", status: value, runtime: "all" })).toEqual(value === "all" ? rows : [rows.find((row) => row.project.id === value)]);
  });

  it.each(PROJECT_RUNTIME_FILTER_OPTIONS)("supports the %s runtime option", ({ value }) => {
    const configured = createSummary("configured", { configured: true });
    const needsCommand = createSummary("needs-command", { configured: false });
    expect(filterProjectLaunchSummaries([configured, needsCommand], { query: "", status: "all", runtime: value })).toEqual(value === "all" ? [configured, needsCommand] : value === "configured" ? [configured] : [needsCommand]);
  });

  it("combines all predicates with AND semantics and preserves source order", () => {
    const matching = createSummary("matching", { name: "Alpha API", status: "succeeded", configured: true });
    const rows = [matching, createSummary("wrong-status", { name: "Alpha API", status: "failed" }), createSummary("wrong-runtime", { name: "Alpha API", status: "succeeded", configured: false }), createSummary("wrong-query", { name: "Beta API", status: "succeeded" })];
    expect(filterProjectLaunchSummaries(Object.freeze(rows), { query: " alpha ", status: "succeeded", runtime: "configured" })).toEqual([matching]);
    expect(filterProjectLaunchSummaries(rows, { query: "missing", status: "all", runtime: "all" })).toEqual([]);
  });
});

describe("project filter value adapters", () => {
  it("guards every finite status and runtime value and falls back independently", () => {
    for (const option of PROJECT_STATUS_FILTER_OPTIONS) { expect(isProjectStatusFilter(option.value)).toBe(true); expect(parseProjectStatusFilter(option.value)).toBe(option.value); }
    for (const option of PROJECT_RUNTIME_FILTER_OPTIONS) { expect(isProjectRuntimeFilter(option.value)).toBe(true); expect(parseProjectRuntimeFilter(option.value)).toBe(option.value); }
    expect(isProjectStatusFilter("unexpected")).toBe(false); expect(isProjectRuntimeFilter("unexpected")).toBe(false);
    expect(parseProjectStatusFilter("unexpected")).toBe("all"); expect(parseProjectRuntimeFilter("unexpected")).toBe("all");
  });
});
