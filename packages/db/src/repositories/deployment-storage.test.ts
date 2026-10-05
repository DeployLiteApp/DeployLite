import { getTableColumns } from "drizzle-orm";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createDeploymentSnapshot, createSourceIntent, type Deployment, type TrustedPriorExecutionReceiptV1 } from "@deploylite/contracts";
import { createDbClient } from "../client.js";
import { deployments, type DeploymentRow } from "../schema.js";
import { DbDeploymentRepository, toDeployment } from "./deployment-data.js";

const startedAt = "2026-01-01T00:00:00.000Z";
const hash = "a".repeat(64);
const proof: TrustedPriorExecutionReceiptV1 = {
  schemaVersion: 1, candidateId: "candidate-2", deploymentId: "dep-2", projectId: "project-1",
  snapshotOriginId: "dep-origin", snapshotHash: hash, effectiveImageDigest: `sha256:${"b".repeat(64)}`,
  runtimeHost: "agent-1", container: "deploylite-dep-2", containerId: "container-2",
  hostPort: 43000, containerPort: 3000, network: null
};
const deployment: Deployment = {
  id: "dep-2", projectId: "project-1", agentId: "agent-1", status: "succeeded", commitSha: "abcdef1",
  startedAt, finishedAt: startedAt, sourceDeploymentId: "dep-parent", snapshotOriginId: "dep-origin",
  snapshotHash: hash, executionReceipt: proof
};
const row: DeploymentRow = {
  id: deployment.id, projectId: deployment.projectId, agentId: deployment.agentId, status: deployment.status,
  commitSha: deployment.commitSha, snapshotHash: hash, snapshotEvidence: null, executionReceipt: proof,
  startedAt: new Date(startedAt), finishedAt: new Date(startedAt), createdAt: new Date(startedAt), updatedAt: new Date(startedAt),
  metadata: { sourceDeploymentId: "dep-parent", snapshotOriginId: "dep-origin", owner: "keep" }
};

// Exercises actual Drizzle SQL generation; this client never connects or evaluates PostgreSQL predicates.
function recordingRepository(rows: DeploymentRow[] = []) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(query: { text: string }, values: unknown[]) {
      queries.push({ text: query.text, values });
      return { rows: rows.map((value) => Object.keys(getTableColumns(deployments)).map((key) => value[key as keyof DeploymentRow])) };
    }
  };
  return { repository: new DbDeploymentRepository(createDbClient(client as unknown as Pool)), queries };
}

function assertImmutableWriteGuard(text: string) {
  const where = text.slice(text.lastIndexOf(" where "));
  for (const column of ["project_id", "agent_id", "commit_sha", "started_at", "execution_receipt", "status", "finished_at"]) {
    expect(where).toContain(`"deployments"."${column}"`);
  }
  expect(where).toContain("sourceDeploymentId");
  expect(where).toContain("snapshotOriginId");
  expect(where).toContain("stopTarget");
  expect(where).toContain("is not distinct from");
}

describe("deployment storage SQL contract", () => {
  it("round-trips receipt and origin through the real insert mapper", async () => {
    const { repository, queries } = recordingRepository([row]);
    expect(await repository.save(deployment)).toEqual(deployment);
    expect(queries[0]?.values).toContain(JSON.stringify(proof));
    expect(queries[0]?.values).toContain(JSON.stringify({ sourceDeploymentId: "dep-parent", snapshotOriginId: "dep-origin" }));
  });

  it("guards upserts against immutable identity, proof, and terminal overwrites", async () => {
    const { repository, queries } = recordingRepository();
    await expect(repository.save(deployment)).rejects.toThrow("immutable");
    assertImmutableWriteGuard(queries[0]?.text ?? "");
    expect(queries[0]?.text).toContain('"deployments"."snapshot_hash"');
  });

  it("guards status compare-and-set with the same immutable fields", async () => {
    const { repository, queries } = recordingRepository();
    expect(await repository.saveIfStatus(deployment, "running")).toBeNull();
    assertImmutableWriteGuard(queries[0]?.text ?? "");
    expect(queries[0]?.values).toContain("running");
  });

  it("permits only initial or equal snapshot evidence attached to its project", async () => {
    const snapshot = createDeploymentSnapshot({
      deploymentId: "dep-origin", projectId: "project-1", agentId: "agent-1", commitSha: "abcdef1",
      source: createSourceIntent({ sourceMode: "build", sourceRevision: "abcdef1", buildProfileId: "profile-1" }),
      configRevision: "config-1", runtimeRevision: "runtime-1", runtimePort: 3000,
      secretRefs: [], policyVersion: "policy-1", schemaVersion: 1
    }, { sha256: () => hash });
    const { repository, queries } = recordingRepository();
    await expect(repository.saveSnapshot(snapshot)).rejects.toThrow("immutable");
    const where = queries[0]?.text.slice(queries[0].text.lastIndexOf(" where ")) ?? "";
    expect(where).toContain('"deployments"."project_id"');
    expect(where).toContain('"deployments"."snapshot_hash"');
    expect(where).toContain('"deployments"."snapshot_evidence"');
    expect(where).toContain('"deployments"."execution_receipt"');
    expect(where).toContain("is null");
    expect(queries[0]?.values).toContain(snapshot.projectId);
    expect(queries[0]?.values).toContain(snapshot.canonicalJson);
  });

  it("isolates mapped receipt and stop-target references from the stored row", () => {
    const stored = structuredClone({ ...row, metadata: { ...row.metadata, stopTarget: { candidateId: "candidate-2", effectiveImage: `registry.example.com/app@sha256:${"b".repeat(64)}` } } });
    const mapped = toDeployment(stored);
    if (!mapped?.executionReceipt || !mapped.stopTarget) throw new Error("Expected stored execution evidence");
    mapped.executionReceipt.containerId = "mutated-output";
    mapped.stopTarget.candidateId = "mutated-target";
    expect(toDeployment(stored)).toMatchObject({ executionReceipt: { containerId: "container-2" }, stopTarget: { candidateId: "candidate-2" } });
  });

  it("preserves snapshot evidence omitted by legacy lifecycle updates", async () => {
    const legacy = { ...row, status: "running", executionReceipt: null, metadata: {} };
    const { repository, queries } = recordingRepository([legacy]);
    const input: Deployment = { id: deployment.id, projectId: deployment.projectId, agentId: deployment.agentId, status: "running", commitSha: deployment.commitSha, startedAt, finishedAt: null };
    expect(await repository.save(input)).toMatchObject({ status: "running", snapshotHash: hash });
    const update = queries[0]?.text.split("do update set ")[1]?.split(" where ")[0] ?? "";
    expect(update).not.toMatch(/"(snapshot_hash|execution_receipt|project_id|agent_id|commit_sha|started_at)"/);
  });

  it.each(["failed", "canceled"] as const)("persists ordinary %s outcomes without manufacturing proof", async (status) => {
    const legacy = { ...row, status, executionReceipt: null, metadata: {} };
    const { repository, queries } = recordingRepository([legacy]);
    const input: Deployment = { id: deployment.id, projectId: deployment.projectId, agentId: deployment.agentId, status, commitSha: deployment.commitSha, startedAt, finishedAt: startedAt };
    expect(await repository.saveIfStatus(input, "running")).toEqual({ ...input, snapshotHash: hash });
    assertImmutableWriteGuard(queries[0]?.text ?? "");
  });

  it.each(["failed", "canceled", "succeeded"] as const)("keeps legacy %s rows readable without proof", (status) => {
    const legacy = { ...row, status, executionReceipt: null, metadata: {} };
    expect(toDeployment(legacy)).toEqual({
      id: deployment.id, projectId: deployment.projectId, agentId: deployment.agentId, status,
      commitSha: deployment.commitSha, startedAt, finishedAt: startedAt, snapshotHash: hash
    });
  });
});
