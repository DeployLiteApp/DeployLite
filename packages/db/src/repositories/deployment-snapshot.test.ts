import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createDeploymentSnapshot, createSourceIntent, type DeploymentSnapshotInputV1 } from "@deploylite/contracts";
import { createDbClient } from "../client.js";
import { DbDeploymentRepository } from "./deployment-data.js";

function snapshot(deploymentId = "origin-1", projectId = "project-1", changes: Partial<DeploymentSnapshotInputV1> = {}) {
  return createDeploymentSnapshot({
    deploymentId, projectId, agentId: "agent-1", commitSha: "abcdef1",
    source: createSourceIntent({ sourceMode: "build", sourceRevision: "abcdef1", buildProfileId: "profile-1" }),
    configRevision: "config-1", runtimeRevision: "runtime-1", runtimePort: 3000,
    secretRefs: [{ secretRefId: "TOKEN", version: 1 }], policyVersion: "policy-1", schemaVersion: 1, ...changes
  }, { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
}

const canonical = snapshot();
const originRow = {
  id: canonical.deploymentId, project_id: canonical.projectId, agent_id: canonical.agentId,
  commit_sha: canonical.commitSha, snapshot_hash: canonical.hash, snapshot_evidence: canonical.canonicalJson
};

// Records actual Drizzle SQL; this small projection/filter model is not a PostgreSQL engine.
type SnapshotRow = { id: string; project_id: string; agent_id: string | null | undefined; commit_sha: string | undefined; snapshot_hash: string; snapshot_evidence: string | null };

function recordingRepository(rows: SnapshotRow[] = [originRow]) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(query: { text: string }, values: unknown[]) {
      queries.push({ text: query.text, values });
      const columns = [...query.text.slice(0, query.text.indexOf(" from ")).matchAll(/"([^"]+)"/g)]
        .map((match) => match[1]).filter((column) => column !== "deployments");
      const eligible = query.text.includes('"snapshot_evidence" is not null')
        ? rows.filter((row) => row.snapshot_evidence !== null) : rows;
      return { rows: eligible.slice(0, 1).map((row) => columns.map((column) => row[column as keyof typeof row])) };
    }
  };
  return { repository: new DbDeploymentRepository(createDbClient(client as unknown as Pool)), queries };
}

describe("snapshot evidence lookup", () => {
  it("reconstitutes real canonical data, hash, bytes, and immutable origin", async () => {
    const { repository } = recordingRepository();
    const found = await repository.findByHash(canonical.hash);
    expect(found).toMatchObject({ hash: canonical.hash, canonicalJson: canonical.canonicalJson, deploymentId: "origin-1" });
    expect(found?.canonicalBytes).toEqual(canonical.canonicalBytes);
    expect(found).toEqual(canonical);
  });

  it("skips a redeploy execution lacking evidence before selecting the canonical origin", async () => {
    const { repository, queries } = recordingRepository([{ ...originRow, id: "execution-2", snapshot_evidence: null }, originRow]);
    expect(await repository.findByHash(canonical.hash)).toEqual(canonical);
    expect(queries[0]?.text).toContain('"deployments"."snapshot_evidence" is not null');
    expect(queries[0]?.values).toEqual([canonical.hash, 1]);
  });

  it.each([{ rows: [] }, { rows: [{ ...originRow, snapshot_evidence: null }] }])("returns null when no canonical evidence exists", async ({ rows }) => {
    expect(await recordingRepository(rows).repository.findByHash(canonical.hash)).toBeNull();
  });

  it("reconstitutes a different origin/project and leaves optional legacy fields absent", async () => {
    const other = snapshot("origin-2", "project-2", { agentId: undefined, commitSha: undefined, runtimePort: null });
    const otherRow = { id: other.deploymentId, project_id: other.projectId, agent_id: null, commit_sha: "legacy", snapshot_hash: other.hash, snapshot_evidence: other.canonicalJson };
    expect(await recordingRepository([otherRow]).repository.findByHash(other.hash)).toEqual(other);
  });

  it.each([
    ["origin", { id: "wrong-origin" }],
    ["project", { project_id: "wrong-project" }],
    ["configured agent", { agent_id: "wrong-agent" }],
    ["commit", { commit_sha: "wrong-commit" }],
    ["stored hash", { snapshot_hash: "a".repeat(64) }]
  ])("rejects a mismatched %s binding", async (_name, changes) => {
    await expect(recordingRepository([{ ...originRow, ...changes }]).repository.findByHash(canonical.hash)).rejects.toThrow("snapshot evidence");
  });

  it.each([
    ["noncanonical whitespace", `${canonical.canonicalJson} `],
    ["changed canonical configuration", canonical.canonicalJson.replace("config-1", "config-2")],
    ["embedded derived hash", canonical.canonicalJson.replace('{', '{"hash":"fabricated",')],
    ["unsupported evidence version", canonical.canonicalJson.replace('"schemaVersion":1', '"schemaVersion":2')],
    ["missing source", JSON.stringify({ ...JSON.parse(canonical.canonicalJson), source: undefined })],
    ["missing runtime port", JSON.stringify({ ...JSON.parse(canonical.canonicalJson), runtimePort: undefined })]
  ])("rejects %s rather than manufacturing a snapshot", async (_name, evidence) => {
    await expect(recordingRepository([{ ...originRow, snapshot_evidence: evidence }]).repository.findByHash(canonical.hash)).rejects.toThrow("snapshot evidence");
  });

  it.each(["digest", "tag"] as const)("preserves the declared %s image and resolved digest", async (kind) => {
    const digest = `sha256:${"b".repeat(64)}`;
    const source = createSourceIntent({
      sourceMode: "image", requestedReference: kind === "digest" ? `registry.example.com/app@${digest}` : "registry.example.com/app:stable"
    }, { policyVersion: "policy-1", trustedHosts: ["registry.example.com"], allowTags: true, allowDigests: true });
    const image = snapshot("image-origin", "project-1", { source, ...(kind === "tag" ? { resolvedDigest: digest } : {}) });
    const imageRow = { ...originRow, id: image.deploymentId, snapshot_hash: image.hash, snapshot_evidence: image.canonicalJson };
    expect(await recordingRepository([imageRow]).repository.findByHash(image.hash)).toEqual(image);
  });

  it.each(["null", "{}", "not JSON", ""])("fails closed on malformed stored evidence %s", async (evidence) => {
    await expect(recordingRepository([{ ...originRow, snapshot_evidence: evidence }]).repository.findByHash(canonical.hash)).rejects.toThrow("snapshot evidence");
  });

  it("isolates returned canonical bytes and nested references across reads", async () => {
    const { repository } = recordingRepository();
    const found = await repository.findByHash(canonical.hash);
    if (!found) throw new Error("Expected canonical snapshot");
    expect(Object.isFrozen(found.source)).toBe(true);
    expect(() => { (found.secretRefs as Array<{ secretRefId: string; version: number }>)[0]!.version = 2; }).toThrow();
    const bytes = found.canonicalBytes;
    bytes.fill(0);
    expect(found.canonicalBytes).toEqual(canonical.canonicalBytes);
    expect(await repository.findByHash(canonical.hash)).toEqual(canonical);
  });
});
