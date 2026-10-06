import { describe, expect, it } from "vitest";
import { deploymentRollbackCommandResultSchema, deploymentRollbackCommandRequestSchema, agentExecutionReceiptSchema, controlPlaneActionSchema, controlCommandRequestSchema, deploymentSchema, agentExecutionCommandSchema, agentReceiptQuerySchema, deploymentExecutionAuthoritySchema, trustedPriorExecutionReceiptSchema } from "../index.js";

const hash = "a".repeat(64);
const lease = (deploymentId: string) => ({ deploymentId, fence: 2, leaseId: `${deploymentId}:lease`, expiresAt: 200_000 });
const authority = { projectId: "project", commandId: "control", action: "deployment.rollback", projectLease: lease("project"), executionLease: lease("R"), sourceLease: lease("A") };
const prior = { schemaVersion: 1, candidateId: "A:candidate:old", deploymentId: "A", projectId: "project", snapshotOriginId: "origin-A", snapshotHash: "b".repeat(64), effectiveImageDigest: `sha256:${"c".repeat(64)}`, runtimeHost: "agent", container: "active-A", containerId: "1".repeat(64), hostPort: 43000, containerPort: 3000, network: null };
const replacement = { prior, effectiveImage: `registry.example.com/team/app@sha256:${"c".repeat(64)}`, policy: { maxOutageMs: 30_000, maxRecoveryMs: 60_000 } };
const command = { schemaVersion: 2, agentId: "agent", commandId: "deploy_R", deploymentId: "R", projectId: "project", sourceDeploymentId: "H", activeDeploymentId: "A", snapshot: {}, snapshotHash: hash, requiredCapabilities: ["deploy.execute"], lease: lease("R"), authority, replacement, context: { requestId: "request", correlationId: "correlation" }, timeoutMs: 30_000, cancellationRequested: false };

describe("rollback role contracts", () => {
  it("admits rollback through the existing control action and command request", () => {
    expect(controlPlaneActionSchema.safeParse("deployment.rollback").success).toBe(true);
    expect(controlCommandRequestSchema.safeParse({ action: "deployment.rollback", scope: { kind: "deployment", projectId: "project", deploymentId: "A" }, inputDigest: hash, idempotencyKey: "key", correlationId: "correlation" }).success).toBe(true);
  });
  it("retains active A independently of historical H lineage in public execution data", () => {
    const result = deploymentSchema.safeParse({ id: "R", projectId: "project", agentId: "agent", status: "queued", commitSha: "abcdef1", startedAt: "2026-01-01T00:00:00.000Z", finishedAt: null, sourceDeploymentId: "H", snapshotOriginId: "origin-H", snapshotHash: hash, activeDeploymentId: "A" });
    expect(result.success).toBe(true);
    expect(result.success && result.data).toMatchObject({ activeDeploymentId: "A", sourceDeploymentId: "H", snapshotOriginId: "origin-H" });
  });
  it("admits independent active A and new R authority without fencing historical H", () => {
    expect(deploymentExecutionAuthoritySchema.safeParse(authority).success).toBe(true);
  });
  it("parses the existing v2 execution with A replacement and H desired lineage", () => {
    expect(trustedPriorExecutionReceiptSchema.safeParse(prior).success).toBe(true);
    expect(agentExecutionCommandSchema.safeParse(command).success).toBe(true);
  });
  it("parses the exact cache-only query for the same rollback command", () => {
    const query = { schemaVersion: 1, action: "deploy.execute", agentId: "agent", commandId: "deploy_R", projectId: "project", deploymentId: "R", sourceDeploymentId: "H", activeDeploymentId: "A", snapshot: {}, snapshotHash: hash, correlationId: "correlation", authority, replacement, timeoutMs: 30_000 };
    expect(agentReceiptQuerySchema.safeParse(query).success).toBe(true);
  });
});


describe("rollback role primitive and binding guards", () => {
  it("exposes a strictly bound reserved result before confirmation", () => {
    const result = { commandId: "control", action: "deployment.rollback", projectId: "project", activeDeploymentId: "A", sourceDeploymentId: "H", deploymentId: "00000000-0000-4000-8000-000000000003", snapshotHash: hash, status: "pending_confirmation", correlationId: "correlation", reason: null };
    expect(deploymentRollbackCommandResultSchema.safeParse(result).success).toBe(true);
    expect(deploymentRollbackCommandRequestSchema.safeParse({ action: "deployment.rollback", scope: { kind: "deployment", projectId: "project", deploymentId: "A" }, inputDigest: hash, idempotencyKey: "key", correlationId: "correlation" }).success).toBe(true);
  });
  it("returns explicit active A alongside the existing R/H proof-bearing v2 receipt", () => {
    const proof = { ...prior, deploymentId: "R", candidateId: "R:candidate:deploy_R", snapshotOriginId: "origin-H", snapshotHash: hash, effectiveImageDigest: `sha256:${"d".repeat(64)}` };
    const receipt = { deploymentId: "R", candidateId: proof.candidateId, effectiveImage: `registry.example.com/team/app@${proof.effectiveImageDigest}`, runtimePort: 3000, runtimeConfig: { hostPort: 43000, containerPort: 3000 }, health: "passed", terminalStatus: "succeeded", rollback: { target: null, result: "not-required" }, proven: true, executionReceipt: proof };
    expect(agentExecutionReceiptSchema.safeParse({ schemaVersion: 2, commandId: "deploy_R", deploymentId: "R", sourceDeploymentId: "H", activeDeploymentId: "A", snapshotHash: hash, correlationId: "correlation", terminalStatus: "succeeded", health: "passed", redacted: true, receipt }).success).toBe(true);
  });
  it.each(["active", "missing-active", "prior", "source-R", "active-R", "source-lease", "execution-lease", "redeploy-active"])("rejects signed execution role mismatch %s", (variant) => {
    const value = structuredClone(command) as Record<string, any>;
    if (variant === "active") value.activeDeploymentId = "other";
    if (variant === "missing-active") delete value.activeDeploymentId;
    if (variant === "prior") value.replacement.prior.deploymentId = "other";
    if (variant === "source-R") value.sourceDeploymentId = "R";
    if (variant === "active-R") { value.activeDeploymentId = "R"; value.replacement.prior.deploymentId = "R"; value.authority.sourceLease = lease("R"); }
    if (variant === "source-lease") value.authority.sourceLease = lease("H");
    if (variant === "execution-lease") value.authority.executionLease = lease("H");
    if (variant === "redeploy-active") value.authority.action = "deployment.redeploy";
    expect(agentExecutionCommandSchema.safeParse(value).success).toBe(false);
  });
  it.each(["active", "missing-active", "source-R", "source-lease"])("rejects cached-query role mismatch %s", (variant) => {
    const value = { schemaVersion: 1, action: "deploy.execute", agentId: "agent", commandId: "deploy_R", projectId: "project", deploymentId: "R", sourceDeploymentId: "H", activeDeploymentId: "A", snapshot: {}, snapshotHash: hash, correlationId: "correlation", authority: structuredClone(authority), replacement: structuredClone(replacement), timeoutMs: 30_000 } as Record<string, any>;
    if (variant === "active") value.activeDeploymentId = "other";
    if (variant === "missing-active") delete value.activeDeploymentId;
    if (variant === "source-R") value.sourceDeploymentId = "R";
    if (variant === "source-lease") value.authority.sourceLease = lease("H");
    expect(agentReceiptQuerySchema.safeParse(value).success).toBe(false);
  });
});
