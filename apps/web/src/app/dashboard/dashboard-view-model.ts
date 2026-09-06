import type { Agent, Deployment, Project } from "@deploylite/contracts";

export type DashboardMetric = {
  label: string;
  value: number | null;
};

export type DashboardActivity = {
  id: string;
  projectName: string;
  status: Deployment["status"];
  startedAt: string;
};

export type DashboardStatusSummary = {
  label: "Successful" | "Failed" | "In progress" | "Cancelled";
  count: number;
  tone: "success" | "danger" | "info" | "warning";
};

export function getDashboardMetrics(projects: readonly Project[], deployments: readonly Deployment[], agents: readonly Agent[]): DashboardMetric[] {
  return [
    { label: "Projects", value: projects.length },
    { label: "Deployments", value: deployments.length },
    { label: "Servers", value: agents.length },
    { label: "Environments", value: null }
  ];
}

export function getDashboardActivity(deployments: readonly Deployment[], projects: readonly Project[], limit = 5): DashboardActivity[] {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  return [...deployments]
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, limit)
    .map((deployment) => ({
      id: deployment.id,
      projectName: projectNames.get(deployment.projectId) ?? "Project unavailable",
      status: deployment.status,
      startedAt: deployment.startedAt
    }));
}

export function summarizeDashboardStatuses(deployments: readonly Pick<Deployment, "status">[]): DashboardStatusSummary[] {
  return [
    { label: "Successful", count: deployments.filter(({ status }) => status === "succeeded").length, tone: "success" },
    { label: "Failed", count: deployments.filter(({ status }) => status === "failed").length, tone: "danger" },
    { label: "In progress", count: deployments.filter(({ status }) => status === "running" || status === "queued").length, tone: "info" },
    { label: "Cancelled", count: deployments.filter(({ status }) => status === "canceled").length, tone: "warning" }
  ];
}

export function formatRelativeTime(value: string, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (elapsedSeconds < 60) return "just now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
