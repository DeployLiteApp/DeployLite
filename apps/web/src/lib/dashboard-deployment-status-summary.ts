import type { Deployment } from "@deploylite/contracts";

export type DeploymentStatusSummaryItem = {
  status: Deployment["status"];
  label: string;
  count: number;
};

const statusMetadata = [
  { status: "succeeded", label: "Succeeded" },
  { status: "failed", label: "Failed" },
  { status: "canceled", label: "Canceled" },
  { status: "running", label: "Running" },
  { status: "queued", label: "Queued" }
] as const satisfies readonly Pick<DeploymentStatusSummaryItem, "status" | "label">[];

export function summarizeDeploymentStatuses(
  deployments?: readonly Pick<Deployment, "status">[]
): readonly DeploymentStatusSummaryItem[] {
  const counts = new Map<string, number>(statusMetadata.map(({ status }) => [status, 0]));

  for (const deployment of deployments ?? []) {
    if (counts.has(deployment.status)) {
      counts.set(deployment.status, (counts.get(deployment.status) ?? 0) + 1);
    }
  }

  return statusMetadata.map(({ status, label }) => ({
    status,
    label,
    count: counts.get(status) ?? 0
  }));
}
