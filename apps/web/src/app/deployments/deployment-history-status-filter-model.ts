import type { Deployment } from "@deploylite/contracts";

export type DeploymentStatusFilter = "all" | Deployment["status"];

export const deploymentStatusFilterOptions = [
  { value: "all", label: "All statuses" },
  { value: "queued", label: "queued" },
  { value: "running", label: "running" },
  { value: "succeeded", label: "succeeded" },
  { value: "failed", label: "failed" },
  { value: "canceled", label: "canceled" }
] as const satisfies ReadonlyArray<{ value: DeploymentStatusFilter; label: string }>;

export function filterDeploymentsByStatus(
  deployments: readonly Deployment[],
  filter: DeploymentStatusFilter
): Deployment[] {
  if (filter === "all") return [...deployments];
  return deployments.filter((deployment) => deployment.status === filter);
}
