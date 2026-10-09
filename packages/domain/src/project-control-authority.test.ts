import { describe, expect, it } from "vitest";
import { deploymentSchema } from "@deploylite/contracts";
import { createControlCommand, resolveControlCommandInMemory, type ControlCommand } from "./control-plane.js";
import { claimDeploymentAuthority, claimProjectUpdateAuthority, validateDeploymentAuthority, validateInitialExecution, validateProjectUpdateAuthority } from "./deployment-contract/deployment-authority.js";

const projectId = "project-1";
const operation = { operation: "compose.resource.attachment", kind: "network", key: "backend", service: "api", attachmentAction: "attach", configDigest: "a".repeat(64), stateDigest: "b".repeat(64), containerId: "c".repeat(64) };
function projectCommand(id: string, idempotencyKey = id, expiresAt = 10_000): ControlCommand {
  return { ...createControlCommand({ actorId: "actor-1", action: "project.update", scope: { kind: "project", projectId }, input: operation, idempotencyKey, correlationId: id, expiresAt: new Date(expiresAt) }), id, status: "eligible" };
}
function deploymentCommand(id: string, fence: number, status: ControlCommand["status"] = "completed"): ControlCommand {
  const lease = { leaseId: `${id}:execution:${fence}`, deploymentId: "deployment-1", fence, expiresAt: 10_000 };
  return { ...createControlCommand({ actorId: "actor-1", action: "deployment.stop", scope: { kind: "deployment", projectId, deploymentId: "deployment-1" }, input: { id }, idempotencyKey: id, correlationId: id }), id, status,
    executionAuthority: { projectId, commandId: id, action: "deployment.stop", projectLease: { ...lease, deploymentId: projectId }, executionLease: lease } };
}

describe("project update command admission shares project fencing", () => {
  it("uses the existing actor/action/project idempotency ledger", () => {
    const ledger = new Map<string, ControlCommand>();
    const first = resolveControlCommandInMemory(ledger, projectCommand("first", "same-key"));
    const replay = resolveControlCommandInMemory(ledger, projectCommand("replay", "same-key"));
    expect(first.created).toBe(true);
    expect(replay).toMatchObject({ created: false, command: { id: "first", scope: { kind: "project", projectId } } });
    expect(ledger).toHaveLength(1);
  });

  it("allocates the next project fence after deployment control and validates current ownership", () => {
    const previous = deploymentCommand("stop-1", 4), current = projectCommand("attach-1");
    const authority = claimProjectUpdateAuthority([previous, current], current, 1_000);
    expect(authority).toMatchObject({ action: "project.update", projectId, commandId: current.id, inputDigest: current.inputDigest, projectLease: { projectId, fence: 5, expiresAt: 10_000 } });
    expect(current).toMatchObject({ status: "dispatching", projectExecutionAuthority: authority });
    expect(() => validateProjectUpdateAuthority([previous, current], authority!, 1_001)).not.toThrow();
  });

  it("allocates above INITIAL fence 1 and supersedes its stale execution", () => {
    const current = projectCommand("attach-1");
    const authority = claimProjectUpdateAuthority([current], current, 1_000)!;
    const deployment = deploymentSchema.parse({ id: "deployment-1", projectId, agentId: "agent-1", status: "running", commitSha: "abcdef1",
      startedAt: new Date(0).toISOString(), finishedAt: null, snapshotOriginId: "origin-1", snapshotHash: "b".repeat(64) });
    expect(authority.projectLease.fence).toBe(2);
    expect(() => validateInitialExecution([current], deployment, projectId, deployment.id,
      { snapshotOriginId: "origin-1", snapshotHash: "b".repeat(64), runtimeHost: "agent-1" }, 1_001)).toThrow();
  });

  it("shares the project lock with deployment claims in both directions", () => {
    const oldDeployment = deploymentCommand("stop-old", 4, "dispatching");
    oldDeployment.expiresAt = new Date(900);
    const current = projectCommand("attach-1"), projectAuthority = claimProjectUpdateAuthority([oldDeployment, current], current, 1_000)!;
    expect(() => validateDeploymentAuthority([oldDeployment, current], oldDeployment.executionAuthority!, 1_001)).toThrow();

    const nextStop = { ...createControlCommand({ actorId: "actor-1", action: "deployment.stop", scope: { kind: "deployment", projectId, deploymentId: "deployment-1" }, input: { stop: "next" }, idempotencyKey: "stop-next", correlationId: "stop-next" }), status: "eligible" as const };
    const blocked = claimDeploymentAuthority([current, nextStop], nextStop, "deployment-1", 1_002);
    expect(blocked).toBeNull();
    current.status = "completed";
    const claimed = claimDeploymentAuthority([current, nextStop], nextStop, "deployment-1", 1_003);
    expect(claimed?.projectLease.fence).toBe(projectAuthority.projectLease.fence + 1);
  });

  it("rejects overlapping project mutations, expired claims, and a superseded receipt", () => {
    const first = projectCommand("attach-1"), authority = claimProjectUpdateAuthority([first], first, 1_000)!;
    const competing = projectCommand("detach-1");
    expect(claimProjectUpdateAuthority([first, competing], competing, 1_001)).toBeNull();
    expect(claimProjectUpdateAuthority([projectCommand("expired", "expired", 1_000)], projectCommand("also-expired", "also-expired", 1_000), 1_000)).toBeNull();
    first.status = "completed";
    const next = projectCommand("next");
    expect(claimProjectUpdateAuthority([first, next], next, 1_002)?.projectLease.fence).toBe(authority.projectLease.fence + 1);
    expect(() => validateProjectUpdateAuthority([first, next], authority, 1_003)).toThrow();
  });
});
