import { trustedPriorExecutionReceiptSchema } from "./prior-execution-receipt.js";
import { describe, expect, it } from "vitest";
import { agentExecutionCommandSchema, agentExecutionReceiptSchema, agentReceiptQuerySchema, deploymentStopAgentCommandSchema, dockerImageExecutionReceiptSchema } from "./agent-transport.js";

const command = { agentId: "agent", commandId: "cmd", deploymentId: "execution", projectId: "project", snapshot: {}, snapshotHash: "a".repeat(64), requiredCapabilities: ["deploy.execute"], lease: { leaseId: "lease", deploymentId: "execution", fence: 1, expiresAt: 10 }, context: { requestId: "request", correlationId: "correlation" }, timeoutMs: 1000, cancellationRequested: false };
const receipt = { commandId: "cmd", deploymentId: "execution", terminalStatus: "succeeded" as const, health: "passed" as const, redacted: true as const, correlationId: "correlation", receipt: { deploymentId: "execution", effectiveImage: `registry.example/app@sha256:${"a".repeat(64)}`, runtimePort: 3000, runtimeConfig: { hostPort: 43000, containerPort: 3000, networkName: "deploylite" }, health: "passed" as const, terminalStatus: "succeeded" as const, rollback: { target: null, result: "not-required" as const }, proven: true as const } };

describe("agent transport wire versions", () => {
  it("keeps v1 unchanged and requires v2 for source identity", () => { const { sourceDeploymentId: _ignored, ...v1 } = { ...command, sourceDeploymentId: "source" }; expect(agentExecutionCommandSchema.parse({ ...v1, schemaVersion: 1 })).not.toHaveProperty("sourceDeploymentId"); expect(agentExecutionCommandSchema.parse({ ...v1, schemaVersion: 2, sourceDeploymentId: "source" })).toHaveProperty("sourceDeploymentId", "source"); expect(() => agentExecutionCommandSchema.parse({ ...v1, schemaVersion: 1, sourceDeploymentId: "source" })).toThrow(); });
   it("rejects unknown receipt versions and accepts both negotiated versions", () => { expect(agentExecutionReceiptSchema.parse({ ...receipt, schemaVersion: 1 })).toHaveProperty("schemaVersion", 1); expect(agentExecutionReceiptSchema.parse({ ...receipt, schemaVersion: 2, sourceDeploymentId: "source", snapshotHash: "a".repeat(64) })).toHaveProperty("schemaVersion", 2); expect(agentExecutionReceiptSchema.parse({ ...receipt, receipt: { ...receipt.receipt, runtimeConfig: undefined }, schemaVersion: 1 })).toHaveProperty("schemaVersion", 1); expect(() => agentExecutionReceiptSchema.parse({ ...receipt, schemaVersion: 3 })).toThrow(); });
});

function proofEnvelope(schemaVersion: 1 | 2 = 2, network: string | null = "deploylite") {
  const executionReceipt = trustedPriorExecutionReceiptSchema.parse({
    schemaVersion: 1, candidateId: "candidate", deploymentId: "execution", projectId: "project",
    snapshotOriginId: "origin", snapshotHash: "a".repeat(64), effectiveImageDigest: `sha256:${"a".repeat(64)}`,
    runtimeHost: "configured-agent", container: "deploylite-active", containerId: "observed-container-id",
    hostPort: 43000, containerPort: 3000, network
  });
  const inner = { ...receipt.receipt, candidateId: "candidate", executionReceipt,
    runtimeConfig: { hostPort: 43000, containerPort: 3000, ...(network === null ? {} : { networkName: network }) }
  };
  return { ...receipt, schemaVersion, receipt: inner,
    ...(schemaVersion === 2 ? { sourceDeploymentId: "previous-execution", snapshotHash: executionReceipt.snapshotHash } : {})
  };
}

describe("optional proof-bearing wire receipts", () => {
  it("accepts a successful v2 receipt carrying structurally valid aligned proof", () => {
    expect(agentExecutionReceiptSchema.safeParse(proofEnvelope()).success).toBe(true);
  });
});

describe("proof binding and legacy compatibility", () => {
  it.each([1, 2] as const)("preserves proof with a named or omitted default network in v%d", (schemaVersion) => {
    for (const network of ["deploylite", null]) {
      const input = proofEnvelope(schemaVersion, network);
      const parsed = agentExecutionReceiptSchema.safeParse(input);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.receipt.executionReceipt).toEqual(input.receipt.executionReceipt);
    }
  });

  it.each([
    { name: "missing candidate", patch: { candidateId: undefined } },
    { name: "different candidate", patch: { candidateId: "other-candidate" } },
    { name: "different execution", patch: { deploymentId: "other-execution" } },
    { name: "different immutable manifest digest", patch: { effectiveImage: `registry.example/app@sha256:${"b".repeat(64)}` } },
    { name: "different runtime container port", patch: { runtimePort: 8080 } },
    { name: "absent observed runtime configuration", patch: { runtimeConfig: undefined } },
    { name: "different configured host port", patch: { runtimeConfig: { hostPort: 44000, containerPort: 3000, networkName: "deploylite" } } },
    { name: "different configured container port", patch: { runtimeConfig: { hostPort: 43000, containerPort: 8080, networkName: "deploylite" } } },
    { name: "different named network", patch: { runtimeConfig: { hostPort: 43000, containerPort: 3000, networkName: "other-network" } } },
    { name: "omitted named network", patch: { runtimeConfig: { hostPort: 43000, containerPort: 3000 } } }
  ])("rejects proof with $name", ({ patch }) => {
    const input = proofEnvelope().receipt;
    expect(dockerImageExecutionReceiptSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  });

  it("rejects a default-network proof paired with an explicit named network", () => {
    const input = proofEnvelope().receipt;
    expect(dockerImageExecutionReceiptSchema.safeParse({ ...input, executionReceipt: { ...input.executionReceipt, network: null } }).success).toBe(false);
  });

  it.each(["failed", "canceled"] as const)("rejects success proof on an ordinary %s receipt", (terminalStatus) => {
    const input = proofEnvelope().receipt;
    expect(dockerImageExecutionReceiptSchema.safeParse({ ...input, terminalStatus, health: "failed", proven: false, rollback: { target: null, result: "not-available" } }).success).toBe(false);
  });

  it.each([
    { schemaVersion: 1 as const, name: "v1 execution", patch: { deploymentId: "other-execution" } },
    { schemaVersion: 2 as const, name: "v2 execution", patch: { deploymentId: "other-execution" } },
    { schemaVersion: 1 as const, name: "v1 terminal status", patch: { terminalStatus: "failed" } },
    { schemaVersion: 2 as const, name: "v2 terminal status", patch: { terminalStatus: "canceled" } },
    { schemaVersion: 1 as const, name: "v1 health", patch: { health: "failed" } },
    { schemaVersion: 2 as const, name: "v2 health", patch: { health: "failed" } },
    { schemaVersion: 2 as const, name: "v2 canonical hash", patch: { snapshotHash: "b".repeat(64) } }
  ])("rejects mismatched outer $name", ({ schemaVersion, patch }) => {
    expect(agentExecutionReceiptSchema.safeParse({ ...proofEnvelope(schemaVersion), ...patch }).success).toBe(false);
  });

  it.each(["previous-execution", "generation-2"])("retains canonical origin distinct from immediate source %s", (sourceDeploymentId) => {
    const input = { ...proofEnvelope(), sourceDeploymentId };
    const parsed = agentExecutionReceiptSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.schemaVersion === 2) {
      expect(parsed.data.sourceDeploymentId).toBe(sourceDeploymentId);
      expect(parsed.data.receipt.executionReceipt?.snapshotOriginId).toBe("origin");
      expect(parsed.data.receipt.executionReceipt?.containerId).toBe("observed-container-id");
    }
  });

  it.each([1, 2] as const)("keeps proof-less success/failure/cancellation readable in v%d", (schemaVersion) => {
    for (const terminalStatus of ["succeeded", "failed", "canceled"] as const) {
      const { executionReceipt: _proof, candidateId: _candidate, runtimeConfig: _config, ...legacy } = proofEnvelope(schemaVersion).receipt;
      const input = { ...proofEnvelope(schemaVersion), terminalStatus, health: terminalStatus === "succeeded" ? "passed" : "failed",
        receipt: { ...legacy, terminalStatus, health: terminalStatus === "succeeded" ? "passed" : "failed", proven: terminalStatus === "succeeded" }
      };
      const parsed = agentExecutionReceiptSchema.safeParse(input);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.receipt).not.toHaveProperty("executionReceipt");
    }
  });

  it.each([
    { name: "unknown observed field", patch: { imageId: "unbound-config-id" } },
    { name: "missing physical container ID", patch: { containerId: undefined } },
    { name: "unsupported proof version", patch: { schemaVersion: 2 } },
    { name: "malformed canonical hash", patch: { snapshotHash: "not-a-hash" } },
    { name: "nonimmutable image digest", patch: { effectiveImageDigest: "latest" } },
    { name: "malformed container name", patch: { container: "bad/name" } },
    { name: "omitted explicit proof network", patch: { network: undefined } }
  ])("keeps nested proof strict for $name", ({ patch }) => {
    const input = proofEnvelope();
    expect(agentExecutionReceiptSchema.safeParse({ ...input, receipt: { ...input.receipt, executionReceipt: { ...input.receipt.executionReceipt, ...patch } } }).success).toBe(false);
  });

  it("does not add outer project/agent fields or accept null runtimeConfig.networkName", () => {
    const input = proofEnvelope();
    expect(agentExecutionReceiptSchema.safeParse({ ...input, projectId: "project" }).success).toBe(false);
    expect(agentExecutionReceiptSchema.safeParse({ ...input, agentId: "configured-agent" }).success).toBe(false);
    expect(dockerImageExecutionReceiptSchema.safeParse({ ...input.receipt, runtimeConfig: { ...input.receipt.runtimeConfig, networkName: null } }).success).toBe(false);
  });
});


function authority(action: "deployment.redeploy" | "deployment.stop", executionId: string) {
  const lease = (deploymentId: string, suffix: string) => ({ deploymentId, leaseId: `cmd:${suffix}:2`, fence: 2, expiresAt: 120_000 });
  return { projectId: "project", commandId: "cmd", action, projectLease: lease("project", "project"), executionLease: lease(executionId, "execution"), ...(action === "deployment.redeploy" ? { sourceLease: lease("previous-execution", "source") } : {}) };
}
describe("optional coordinated replacement and stop wire authority", () => {
  it("retains explicit replacement policy, observed previous proof and coordinated leases in v2", () => {
    const prior = { ...proofEnvelope().receipt.executionReceipt, deploymentId: "previous-execution" };
    const body = { ...command, schemaVersion: 2, sourceDeploymentId: prior.deploymentId, lease: authority("deployment.redeploy", "execution").executionLease,
      authority: authority("deployment.redeploy", "execution"), replacement: { prior, effectiveImage: receipt.receipt.effectiveImage, policy: { maxOutageMs: 30_000, maxRecoveryMs: 60_000 } } };
    const parsed = agentExecutionCommandSchema.safeParse(body);
    expect(parsed.success).toBe(true); if (parsed.success) expect(parsed.data).toMatchObject({ authority: body.authority, replacement: body.replacement });
  });
  it("retains shared authority in an existing stop command without changing its version", () => {
    const body = { schemaVersion: 1, action: "deployment.stop", agentId: "agent", commandId: "cmd", projectId: "project", deploymentId: "previous-execution", candidateId: "previous-execution:candidate:prior", effectiveImage: receipt.receipt.effectiveImage, requiredCapabilities: ["deployment.stop"], lease: authority("deployment.stop", "previous-execution").executionLease, authority: authority("deployment.stop", "previous-execution"), context: command.context, timeoutMs: 1000, cancellationRequested: false };
    const parsed = deploymentStopAgentCommandSchema.safeParse(body);
    expect(parsed.success).toBe(true); if (parsed.success) expect(parsed.data).toHaveProperty("authority", body.authority);
  });
});


describe("explicit registry port wire compatibility", () => {
  const image = (port: string) => `127.0.0.1:${port}/deploylite-p2/fixture@sha256:${"a".repeat(64)}`;
  it("accepts source-compatible explicit ports on bound v1 and v2 proof receipts", () => {
    for (const port of ["1", "49172", "65535"]) for (const version of [1, 2] as const) {
      const input = proofEnvelope(version);
      expect(agentExecutionReceiptSchema.safeParse(input).success).toBe(true);
      const withPort = { ...input, receipt: { ...input.receipt, effectiveImage: image(port) } };
      const parsed = agentExecutionReceiptSchema.safeParse(withPort);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.receipt).toMatchObject({ effectiveImage: image(port), executionReceipt: input.receipt.executionReceipt });
    }
  });
  function shapes(effectiveImage: string) {
    const prior = proofEnvelope().receipt.executionReceipt;
    const stop = { schemaVersion: 1 as const, action: "deployment.stop" as const, agentId: "agent", commandId: "stop-command", projectId: "project", deploymentId: "execution", candidateId: "candidate", effectiveImage, containerId: prior.containerId, requiredCapabilities: ["deployment.stop"], lease: command.lease, context: command.context, timeoutMs: 1000, cancellationRequested: false };
    const query = { schemaVersion: 1 as const, action: "deployment.stop" as const, agentId: "agent", commandId: stop.commandId, projectId: stop.projectId, deploymentId: stop.deploymentId, candidateId: stop.candidateId, effectiveImage, containerId: stop.containerId, correlationId: command.context.correlationId, authority: null, timeoutMs: 1000 };
    const replacement = { ...command, schemaVersion: 2, sourceDeploymentId: "source", replacement: { prior, effectiveImage, policy: { maxOutageMs: 30_000, maxRecoveryMs: 60_000 } } };
    return [deploymentStopAgentCommandSchema.safeParse(stop), agentReceiptQuerySchema.safeParse(query), agentExecutionCommandSchema.safeParse(replacement)];
  }
  it("accepts the same immutable port pin in replacement Stop and cache-query shapes", () => {
    expect(shapes(receipt.receipt.effectiveImage).every((x) => x.success)).toBe(true);
    expect(shapes(image("49172")).every((x) => x.success)).toBe(true);
  });
  it("preserves rejection of invalid ports schemes credentials tags and malformed digests", () => {
    const invalid = [image("0"), image("65536"), image("999999"), image("-1"), image(""), image("abc"), image("49172").replace("127.0.0.1:", "https://127.0.0.1:"), image("49172").replace("127.0.0.1:", "user@127.0.0.1:"), image("49172").replace("fixture@", "fixture:latest@"), image("49172").replace("a".repeat(64), "a".repeat(63))];
    for (const effectiveImage of invalid) {
      expect(dockerImageExecutionReceiptSchema.safeParse({ ...receipt.receipt, effectiveImage }).success).toBe(false);
      expect(shapes(effectiveImage).some((x) => x.success)).toBe(false);
    }
  });
  it("retains proof digest and strict outer bindings when the image has a valid port", () => {
    const input = proofEnvelope();
    for (const patch of [{ effectiveImage: image("49172").replace("a".repeat(64), "b".repeat(64)) }, { effectiveImage: image("49172"), deploymentId: "other" }, { effectiveImage: image("49172"), runtimePort: 8080 }]) {
      expect(dockerImageExecutionReceiptSchema.safeParse({ ...input.receipt, ...patch }).success).toBe(false);
    }
  });
});
