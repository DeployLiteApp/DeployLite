import type { ProjectLaunchSummary } from "./project-launch-hub";

export const PROJECT_STATUS_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "not-run", label: "Not run" },
  { value: "queued", label: "queued" },
  { value: "running", label: "running" },
  { value: "succeeded", label: "succeeded" },
  { value: "failed", label: "failed" },
  { value: "canceled", label: "canceled" }
] as const;

export const PROJECT_RUNTIME_FILTER_OPTIONS = [
  { value: "all", label: "All" },
  { value: "configured", label: "Configured" },
  { value: "needs-command", label: "Needs command" }
] as const;

export type ProjectStatusFilter = (typeof PROJECT_STATUS_FILTER_OPTIONS)[number]["value"];
export type ProjectRuntimeFilter = (typeof PROJECT_RUNTIME_FILTER_OPTIONS)[number]["value"];

export type ProjectListFilterCriteria = {
  query: string;
  status: ProjectStatusFilter;
  runtime: ProjectRuntimeFilter;
};

export function isProjectStatusFilter(value: unknown): value is ProjectStatusFilter {
  return typeof value === "string" && PROJECT_STATUS_FILTER_OPTIONS.some((option) => option.value === value);
}

export function isProjectRuntimeFilter(value: unknown): value is ProjectRuntimeFilter {
  return typeof value === "string" && PROJECT_RUNTIME_FILTER_OPTIONS.some((option) => option.value === value);
}

export function parseProjectStatusFilter(value: unknown): ProjectStatusFilter {
  return isProjectStatusFilter(value) ? value : "all";
}

export function parseProjectRuntimeFilter(value: unknown): ProjectRuntimeFilter {
  return isProjectRuntimeFilter(value) ? value : "all";
}

export function filterProjectLaunchSummaries(rows: readonly ProjectLaunchSummary[], criteria: ProjectListFilterCriteria): ProjectLaunchSummary[] {
  const normalizedQuery = criteria.query.trim().toLowerCase();
  const status = parseProjectStatusFilter(criteria.status);
  const runtime = parseProjectRuntimeFilter(criteria.runtime);

  return rows.filter((row) => {
    const matchesQuery = normalizedQuery.length === 0 || [row.project.name, row.project.repoUrl, row.project.defaultBranch].some((value) => value.toLowerCase().includes(normalizedQuery));
    const matchesStatus = status === "all" || row.latest.statusLabel === (status === "not-run" ? "Not run" : status);
    const matchesRuntime = runtime === "all" || row.runtime.configured === (runtime === "configured");
    return matchesQuery && matchesStatus && matchesRuntime;
  });
}
