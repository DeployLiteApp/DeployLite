import { describe, expect, it } from "vitest";

import type { DeploymentLogRow, DeploymentRow } from "../schema.js";
import { toDeployment, toOrderedLogEvents } from "./deployment-data.js";

const now = new Date("2026-01-01T00:00:00.000Z");

function deploymentRow(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    id: "dep-1",
    projectId: "project-1",
    agentId: "agent-1",
    status: "running",
    commitSha: "abcdef1",
    snapshotHash: null,
    snapshotEvidence: null,
    executionReceipt: null,
    startedAt: now,
    finishedAt: null,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function logRow(sequence: number): DeploymentLogRow {
  return {
    id: `log-${sequence}`,
    deploymentId: "dep-1",
    sequence,
    level: "info",
    message: `Log ${sequence}`,
    redactionApplied: true,
    requestId: "req-1",
    correlationId: "req-1",
    createdAt: new Date(now.getTime() + sequence)
  };
}

describe("deployment metadata persistence mapping", () => {
  it("retains the immutable snapshot origin and execution receipt when reading a redeploy", () => {
    const receipt = {
      schemaVersion: 1 as const,
      candidateId: "candidate-2",
      deploymentId: "dep-1",
      projectId: "project-1",
      snapshotOriginId: "dep-origin",
      snapshotHash: "a".repeat(64),
      effectiveImageDigest: `sha256:${"b".repeat(64)}`,
      runtimeHost: "agent-1",
      container: "deploylite-dep-1",
      containerId: "container-2",
      hostPort: 43000,
      containerPort: 3000,
      network: null
    };
    const row = {
      ...deploymentRow({ status: "succeeded", snapshotHash: receipt.snapshotHash, metadata: { sourceDeploymentId: "dep-parent", snapshotOriginId: "dep-origin" } }),
      executionReceipt: receipt
    };

    expect(toDeployment(row)).toMatchObject({
      sourceDeploymentId: "dep-parent",
      snapshotOriginId: "dep-origin",
      snapshotHash: receipt.snapshotHash,
      executionReceipt: receipt
    });
  });

  it("maps attached deployments without manufacturing empty agent IDs", () => {
    expect(toDeployment(deploymentRow({ snapshotHash: "a".repeat(64) }))).toEqual({
      id: "dep-1",
      projectId: "project-1",
      agentId: "agent-1",
      status: "running",
      commitSha: "abcdef1",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: null,
      snapshotHash: "a".repeat(64)
    });

    expect(toDeployment(deploymentRow({ agentId: null }))).toBeNull();
  });

  it("returns log events ordered by sequence", () => {
    expect(toOrderedLogEvents([logRow(3), logRow(1), logRow(2)]).map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("reconstitutes the stop target while retaining unrelated metadata in the row", () => {
    expect(toDeployment(deploymentRow({ metadata: { owner: "keep", stopTarget: { candidateId: "candidate-1", effectiveImage: `registry.example.com/team/app@sha256:${"a".repeat(64)}` } } }))).toMatchObject({ stopTarget: { candidateId: "candidate-1" } });
  });
});
