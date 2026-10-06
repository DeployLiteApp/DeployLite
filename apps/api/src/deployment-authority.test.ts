import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createControlCommand } from "@deploylite/domain";
import { createInMemoryExecutionRepositories } from "./app.js";

const epoch = Date.parse("2026-10-04T18:00:00Z");
async function fixture() {
  const lane = createInMemoryExecutionRepositories();
  const command = async (id: string, action: "deployment.stop" | "deployment.redeploy", sourceId = "A", executionId = "B", projectId = "project") => {
    const value = { ...createControlCommand({ actorId: "actor", action, scope: { kind: "deployment", projectId, deploymentId: sourceId }, input: { sourceId, executionId }, idempotencyKey: id, correlationId: id, expiresAt: new Date(Date.now() + 120_000) }), id, status: "eligible" as const,
      ...(action === "deployment.redeploy" ? { result: { commandId: id, action, projectId, sourceDeploymentId: sourceId, deploymentId: executionId, snapshotHash: "a".repeat(64), status: "eligible" as const, correlationId: id, reason: null } } : {}) };
    await lane.controls.resolve(value);
    if (action === "deployment.redeploy") await lane.deployments.save({ id: executionId, projectId, agentId: "agent", status: "queued", commitSha: "abcdef1", startedAt: new Date(epoch).toISOString(), finishedAt: null, sourceDeploymentId: sourceId, snapshotOriginId: "A", snapshotHash: "a".repeat(64) });
    return value;
  };
  return { ...lane, command };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(epoch); });
afterEach(() => vi.useRealTimers());
describe("shared project execute-stop authority", () => {
  it("excludes stop A while replacement B holds authority, independently of execution identity", async () => {
    const lane = await fixture(); const replace = await lane.command("replace", "deployment.redeploy"); const stop = await lane.command("stop", "deployment.stop");
    const first = await lane.controls.claimDeploymentRedeploy(replace);
    const second = await lane.controls.claimDeploymentStop(stop);
    expect(first.claimed).toBe(true); expect(second.claimed).toBe(false);
    expect(second.command.status).toBe("eligible");
  });
  it("excludes another replacement with a different source in the same project, preserving other projects", async () => {
    const lane = await fixture(); const a = await lane.command("a", "deployment.redeploy", "A", "B"); const b = await lane.command("b", "deployment.redeploy", "C", "D"); const other = await lane.command("other", "deployment.redeploy", "X", "Y", "other-project");
    const [first, second, independent] = await Promise.all([lane.controls.claimDeploymentRedeploy(a), lane.controls.claimDeploymentRedeploy(b), lane.controls.claimDeploymentRedeploy(other)]);
    expect([first.claimed, second.claimed]).toEqual([true, false]); expect(independent.claimed).toBe(true);
  });
  it("allocates monotonic project, immediate-source and execution leases after completed stop", async () => {
    const lane = await fixture(); const stop = await lane.command("stop", "deployment.stop"); const first = await lane.controls.claimDeploymentStop(stop);
    expect(first).toMatchObject({ authority: { commandId: stop.id, projectId: "project", projectLease: { fence: 2 }, executionLease: { deploymentId: "A", fence: 2 } } });
    await lane.controls.completeDeploymentStop(first.command, { commandId: stop.id, action: "deployment.stop", projectId: "project", deploymentId: "A", status: "completed", correlationId: stop.id, reason: "stopped" });
    const replace = await lane.command("replace", "deployment.redeploy");
    const second = await lane.controls.claimDeploymentRedeploy(replace);
    expect(second).toMatchObject({ claimed: true, authority: { commandId: replace.id, projectLease: { fence: 3 }, sourceLease: { deploymentId: "A", fence: 3 }, executionLease: { deploymentId: "B", fence: 3 } } });
  });
});


describe("authority loss before effects", () => {
  it("rejects allocation after the existing command expiry", async () => {
    const lane = await fixture(); const command = await lane.command("expired", "deployment.stop");
    vi.setSystemTime(epoch + 120_000);
    expect((await lane.controls.claimDeploymentStop(command)).claimed).toBe(false);
  });
  it.each(["project", "execution", "lease-owner", "command", "source"])("rejects changed %s against persisted bindings", async (field) => {
    const lane = await fixture(); const command = await lane.command("replace", "deployment.redeploy"); const claim = await lane.controls.claimDeploymentRedeploy(command);
    const authority = structuredClone(claim.authority!);
    if (field === "project") authority.projectId = "other";
    if (field === "execution") authority.executionLease.deploymentId = "other";
    if (field === "lease-owner") authority.projectLease.leaseId = "same-fence-other-owner";
    if (field === "command") authority.commandId = "missing";
    if (field === "source") authority.sourceLease!.deploymentId = "other";
    await expect(lane.controls.validateDeploymentAuthority(authority)).rejects.toThrow();
  });
  it("rejects expired and superseded authority without refreshing its recovery lease", async () => {
    const lane = await fixture(); const a = await lane.command("a", "deployment.redeploy"); const first = await lane.controls.claimDeploymentRedeploy(a);
    vi.setSystemTime(epoch + 120_000);
    await expect(lane.controls.validateDeploymentAuthority(first.authority!)).rejects.toThrow();
    const stop = await lane.command("stop", "deployment.stop"); const second = await lane.controls.claimDeploymentStop(stop);
    expect(second).toMatchObject({ claimed: true, authority: { projectLease: { fence: 3 } } });
    await expect(lane.controls.validateDeploymentAuthority(first.authority!, epoch + 1)).rejects.toThrow();
  });
});


describe("Stop terminal authority CAS", () => {
  it.each(["expired", "superseded", "changed-owner"])("rejects %s authority instead of completing Stop", async (fault) => {
    const lane = await fixture(), command = await lane.command("stop", "deployment.stop"), claim = await lane.controls.claimDeploymentStop(command);
    const submitted = structuredClone(claim.command), result = { commandId: "stop", action: "deployment.stop" as const, projectId: "project", deploymentId: "A", status: "completed" as const, correlationId: "stop", reason: "stopped" };
    if (fault === "expired") vi.setSystemTime(claim.authority!.projectLease.expiresAt);
    if (fault === "changed-owner") submitted.executionAuthority!.projectLease.leaseId = "another-owner";
    if (fault === "superseded") lane.completion.commands.set("newer", { ...structuredClone(claim.command), id: "newer", executionAuthority: { ...structuredClone(claim.authority!), commandId: "newer", projectLease: { ...claim.authority!.projectLease, fence: claim.authority!.projectLease.fence + 1 } } });
    await expect(lane.controls.completeDeploymentStop(submitted, result)).rejects.toThrow();
    expect([...lane.completion.commands.values()].find((value) => value.id === "stop")?.status).toBe("dispatching"); expect([...lane.completion.commands.values()].find((value) => value.id === "stop")?.result).toBeUndefined();
  });
  it("replays equal completed Stop before expiry but rejects changed terminal input", async () => {
    const lane = await fixture(), command = await lane.command("stop", "deployment.stop"), claim = await lane.controls.claimDeploymentStop(command);
    const result = { commandId: "stop", action: "deployment.stop" as const, projectId: "project", deploymentId: "A", status: "completed" as const, correlationId: "stop", reason: "stopped" };
    const first = await lane.controls.completeDeploymentStop(claim.command, result); vi.setSystemTime(claim.authority!.projectLease.expiresAt);
    expect(await lane.controls.completeDeploymentStop(claim.command, result)).toEqual(first);
    await expect(lane.controls.completeDeploymentStop(claim.command, { ...result, reason: "different" })).rejects.toThrow();
  });
});
