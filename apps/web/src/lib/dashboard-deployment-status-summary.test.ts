import { describe, expect, it } from "vitest";
import { summarizeDeploymentStatuses } from "./dashboard-deployment-status-summary.js";

describe("summarizeDeploymentStatuses", () => {
  it("returns the five supported statuses in the contract order with mixed counts", () => {
    const deployments = [
      { status: "running" }, { status: "succeeded" }, { status: "running" },
      { status: "failed" }, { status: "queued" }, { status: "canceled" }
    ] as const;
    const before = [...deployments];

    expect(summarizeDeploymentStatuses(deployments)).toEqual([
      { status: "succeeded", label: "Succeeded", count: 1 },
      { status: "failed", label: "Failed", count: 1 },
      { status: "canceled", label: "Canceled", count: 1 },
      { status: "running", label: "Running", count: 2 },
      { status: "queued", label: "Queued", count: 1 }
    ]);
    expect(deployments).toEqual(before);
  });

  it("includes zero counts and ignores unknown runtime statuses", () => {
    const deployments = [{ status: "unknown" }, { status: "running" }] as readonly { status: string }[];
    expect(summarizeDeploymentStatuses(deployments as never)).toEqual([
      { status: "succeeded", label: "Succeeded", count: 0 },
      { status: "failed", label: "Failed", count: 0 },
      { status: "canceled", label: "Canceled", count: 0 },
      { status: "running", label: "Running", count: 1 },
      { status: "queued", label: "Queued", count: 0 }
    ]);
  });

  it("returns all zero counts when deployments are absent", () => {
    expect(summarizeDeploymentStatuses(undefined).map(({ count }) => count)).toEqual([0, 0, 0, 0, 0]);
  });
});
