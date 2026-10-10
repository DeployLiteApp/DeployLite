import { transportPortApplyAgentCommandSchema, trustedPriorExecutionReceiptSchema } from "@deploylite/contracts";
import { claimProjectUpdateAuthority, createControlCommand } from "@deploylite/domain";
import { describe, expect, it, vi } from "vitest";
import { DockerTransportPortExecutor } from "./docker-transport-port-executor.js";

const projectId = "project-1", deploymentId = "deployment-1", agentId = "agent-1";
const effectiveImage = `registry.example.com/team/app@sha256:${"b".repeat(64)}`;
const route = { schemaVersion: 1 as const, projectId, deploymentId, protocol: "udp" as const, publishedPort: 19132, targetPort: 19132 };
type TransferFixtureContainer = { id: string; name: string; state: "running" | "exited"; running: boolean; health: string | null; owner: string;
  projectId: string; deploymentId: string; candidateId: string; effectiveImage: string; hostBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>; networkMode: string };
const proof = trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1, candidateId: `${deploymentId}:candidate:command-1`, deploymentId, projectId,
  snapshotOriginId: deploymentId, snapshotHash: "a".repeat(64), effectiveImageDigest: `sha256:${"b".repeat(64)}`, runtimeHost: agentId,
  container: `deploylite-active-${deploymentId}`, containerId: "c".repeat(64), hostPort: 43000, containerPort: 3000, network: null });

function command(previousBindings = [{ protocol: route.protocol, publishedPort: route.publishedPort, targetPort: route.targetPort }], portTransfer?: {
  sourceDeploymentId: string; sourceContainerId: string; sourceBindings: { protocol: "tcp" | "udp"; publishedPort: number; targetPort: number }[];
  sourcePreviousBindings: { protocol: "tcp" | "udp"; publishedPort: number; targetPort: number }[];
  sourceExecutionReceipt: ReturnType<typeof trustedPriorExecutionReceiptSchema.parse>; sourceEffectiveImage: string;
}) {
  const operation = "apply" as const, rollbackRevisionId = null;
  const input = { route, executionReceipt: proof, effectiveImage, operation, rollbackRevisionId, ...(portTransfer ? { portTransfer } : {}) };
  const now = Date.now(), control = { ...createControlCommand({ actorId: "actor-1", action: "project.update", scope: { kind: "project", projectId },
    input, idempotencyKey: "port-command-1", correlationId: "correlation-1", expiresAt: new Date(now + 30_000) }), status: "eligible" as const };
  const authority = claimProjectUpdateAuthority([control], control, now)!;
  return transportPortApplyAgentCommandSchema.parse({ schemaVersion: 1, action: "transport.port.apply", agentId, commandId: control.id, projectId,
    idempotencyKey: control.idempotencyKey, inputDigest: control.inputDigest, operation, rollbackRevisionId, route,
    currentContainerId: proof.containerId,
    bindings: [{ protocol: route.protocol, publishedPort: route.publishedPort, targetPort: route.targetPort }],
    previousBindings,
    ...(portTransfer ? { portTransfer } : {}), executionReceipt: proof, effectiveImage,
    requiredCapabilities: portTransfer ? ["docker.transport.port.apply.v1", "docker.transport.port.transfer.v1"] : ["docker.transport.port.apply.v1"], authority, lease: authority.projectLease,
    context: { requestId: "request-1", correlationId: control.correlationId }, timeoutMs: 30_000, cancellationRequested: false });
}

function activeInspect(bindings: Record<string, Array<{ HostIp: string; HostPort: string }>>) {
  return JSON.stringify({ id: "c".repeat(64), name: `/deploylite-active-${deploymentId}`, state: "running", running: true, health: "healthy",
    owner: "deploylite", projectId, deploymentId, candidateId: proof.candidateId, effectiveImage, hostBindings: bindings, networkMode: "default" });
}

describe("Docker transport port executor", () => {
  it("preflights on an ephemeral loopback port, replaces only the trusted container, and verifies the mapped UDP port", async () => {
    const containers = new Map<string, { id: string; name: string; state: "running" | "exited"; running: boolean; health: string; owner: string;
      projectId: string; deploymentId: string; candidateId: string; effectiveImage: string; hostBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>; networkMode: string }>();
    const original = { id: proof.containerId, name: `/deploylite-active-${deploymentId}`, state: "running" as const, running: true, health: "healthy",
      owner: "deploylite", projectId, deploymentId, candidateId: proof.candidateId, effectiveImage,
      hostBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }] }, networkMode: "default" };
    containers.set(`deploylite-active-${deploymentId}`, original);
    let createdId = "d".repeat(64);
    const runner = { run: vi.fn(async (argv: readonly string[]) => {
      if (argv[1] === "container" && argv[2] === "inspect") {
        const value = containers.get(argv.at(-1)!);
        return value ? { exitCode: 0, signal: null, stdout: JSON.stringify(value), stderr: "" }
          : { exitCode: 1, signal: null, stdout: "", stderr: "Error: No such object" };
      }
      if (argv[1] === "inspect") return { exitCode: 0, signal: null, stdout: "healthy", stderr: "" };
      if (argv[1] === "run") {
        const name = argv[argv.indexOf("--name") + 1]!;
        const hostBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = argv.includes("--publish") && argv.some(value => value.startsWith("127.0.0.1::"))
          ? { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43555" }] }
          : { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }], "19132/udp": [{ HostIp: "0.0.0.0", HostPort: "19132" }] };
        containers.set(name, { ...original, id: createdId, name: `/${name}`, state: "running", running: true, hostBindings });
        return { exitCode: 0, signal: null, stdout: createdId, stderr: "" };
      }
      if (argv[1] === "stop") {
        for (const value of containers.values()) if (value.id === argv.at(-1)) { value.state = "exited"; value.running = false; }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (argv[1] === "rename") {
        const value = containers.get(argv[2]!); containers.delete(argv[2]!);
        if (value) { value.name = `/${argv[3]}`; containers.set(argv[3]!, value); }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (argv[1] === "rm") { containers.delete(argv.at(-1)!); return { exitCode: 0, signal: null, stdout: "", stderr: "" }; }
      if (argv[1] === "start") {
        const value = containers.get(argv.at(-1)!); if (value) { value.state = "running"; value.running = true; }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 1, signal: null, stdout: "", stderr: "unexpected Docker command" };
    }) };
    const executor = new DockerTransportPortExecutor({ runner, agentId, owner: "deploylite" }), applyCommand = command([]);
    const result = await executor.execute(applyCommand, { assertValid: async () => {} }, new AbortController().signal);
    expect(result, JSON.stringify({ result, calls: runner.run.mock.calls.map(([argv]) => argv) })).toMatchObject({ state: "updated", containerId: createdId, protocol: "udp", publishedPort: 19132 });
    const runs = runner.run.mock.calls.filter(([argv]) => argv[1] === "run");
    expect(runs).toHaveLength(2);
    expect(runs[0]?.[0]).toContain("127.0.0.1::3000/tcp");
    expect(runs[0]?.[0]).not.toContain("127.0.0.1:43000:3000/tcp");
    expect(runs[1]?.[0]).toContain("19132:19132/udp");
    expect(containers.get(`deploylite-active-${deploymentId}`)?.id).toBe(createdId);
    expect(containers.has(`deploylite-port-prior-${applyCommand.commandId}`)).toBe(false);
  });

  it("restores the exact prior container if Docker rejects the requested published port", async () => {
    const containers = new Map<string, { id: string; name: string; state: "running" | "exited"; running: boolean; health: string; owner: string;
      projectId: string; deploymentId: string; candidateId: string; effectiveImage: string; hostBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>; networkMode: string }>();
    const original = { id: proof.containerId, name: `/deploylite-active-${deploymentId}`, state: "running" as const, running: true, health: "healthy",
      owner: "deploylite", projectId, deploymentId, candidateId: proof.candidateId, effectiveImage,
      hostBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }] }, networkMode: "default" };
    containers.set(`deploylite-active-${deploymentId}`, original);
    const runner = { run: vi.fn(async (argv: readonly string[]) => {
      if (argv[1] === "container" && argv[2] === "inspect") {
        const value = containers.get(argv.at(-1)!);
        return value ? { exitCode: 0, signal: null, stdout: JSON.stringify(value), stderr: "" }
          : { exitCode: 1, signal: null, stdout: "", stderr: "Error: No such object" };
      }
      if (argv[1] === "inspect") return { exitCode: 0, signal: null, stdout: "healthy", stderr: "" };
      if (argv[1] === "run" && argv.includes("19132:19132/udp")) return { exitCode: 125, signal: null, stdout: "", stderr: "port is already allocated" };
      if (argv[1] === "run") {
        const name = argv[argv.indexOf("--name") + 1]!;
        containers.set(name, { ...original, id: "d".repeat(64), name: `/${name}`, state: "running", running: true,
          hostBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43555" }] } });
        return { exitCode: 0, signal: null, stdout: "d".repeat(64), stderr: "" };
      }
      if (argv[1] === "stop") {
        for (const value of containers.values()) if (value.id === argv.at(-1)) { value.state = "exited"; value.running = false; }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (argv[1] === "rename") {
        const value = containers.get(argv[2]!); containers.delete(argv[2]!);
        if (value) { value.name = `/${argv[3]}`; containers.set(argv[3]!, value); }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (argv[1] === "rm") { containers.delete(argv.at(-1)!); return { exitCode: 0, signal: null, stdout: "", stderr: "" }; }
      if (argv[1] === "start") {
        const value = containers.get(argv.at(-1)!); if (value) { value.state = "running"; value.running = true; }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 1, signal: null, stdout: "", stderr: "unexpected Docker command" };
    }) };
    const executor = new DockerTransportPortExecutor({ runner, agentId, owner: "deploylite" });
    const result = await executor.execute(command([]), { assertValid: async () => {} }, new AbortController().signal);
    expect(result).toMatchObject({ state: "failed", failureReason: "port-conflict", containerId: null });
    expect(containers.get(`deploylite-active-${deploymentId}`)).toMatchObject({ id: proof.containerId, running: true });
    expect([...containers.keys()]).toEqual([`deploylite-active-${deploymentId}`]);
  });

  it("recognizes an already-applied exact binding without restarting the app", async () => {
    const runner = { run: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: activeInspect({
      "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }],
      "19132/udp": [{ HostIp: "0.0.0.0", HostPort: "19132" }]
    }), stderr: "" })) };
    const result = await new DockerTransportPortExecutor({ runner, agentId, owner: "deploylite" })
      .execute(command(), { assertValid: async () => {} }, new AbortController().signal);
    expect(result).toMatchObject({ state: "unchanged", containerId: proof.containerId, protocol: "udp", publishedPort: 19132 });
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it("fails closed on an unclaimed host binding and makes no Docker changes", async () => {
    const runner = { run: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: activeInspect({
      "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }],
      "25565/tcp": [{ HostIp: "0.0.0.0", HostPort: "25565" }]
    }), stderr: "" })) };
    const result = await new DockerTransportPortExecutor({ runner, agentId, owner: "deploylite" })
      .execute(command(), { assertValid: async () => {} }, new AbortController().signal);
    expect(result).toMatchObject({ state: "failed", failureReason: "target-unavailable", containerId: null });
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it("moves the port between two trusted containers and verifies both resulting binding sets", async () => {
    const sourceDeploymentId = "deployment-source", sourceImage = `registry.example.com/team/source@sha256:${"d".repeat(64)}`;
    const sourceProof = trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1, candidateId: `${sourceDeploymentId}:candidate:source-command`,
      deploymentId: sourceDeploymentId, projectId, snapshotOriginId: sourceDeploymentId, snapshotHash: "e".repeat(64),
      effectiveImageDigest: `sha256:${"d".repeat(64)}`, runtimeHost: agentId, container: `deploylite-active-${sourceDeploymentId}`,
      containerId: "f".repeat(64), hostPort: 43001, containerPort: 3000, network: null });
    const sourceBefore = [{ protocol: "udp" as const, publishedPort: 19132, targetPort: 19132 }, { protocol: "tcp" as const, publishedPort: 25565, targetPort: 25565 }];
    const transfer = { sourceDeploymentId, sourceContainerId: "a".repeat(64), sourceBindings: [sourceBefore[1]!], sourcePreviousBindings: sourceBefore,
      sourceExecutionReceipt: sourceProof, sourceEffectiveImage: sourceImage };
    const originalTarget = { id: proof.containerId, name: `/deploylite-active-${deploymentId}`, state: "running" as const, running: true, health: "healthy",
      owner: "deploylite", projectId, deploymentId, candidateId: proof.candidateId, effectiveImage,
      hostBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }] }, networkMode: "default" };
    const originalSource = { id: transfer.sourceContainerId, name: `/deploylite-active-${sourceDeploymentId}`, state: "running" as const, running: true, health: "healthy",
      owner: "deploylite", projectId, deploymentId: sourceDeploymentId, candidateId: sourceProof.candidateId, effectiveImage: sourceImage,
      hostBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43001" }], "19132/udp": [{ HostIp: "0.0.0.0", HostPort: "19132" }],
        "25565/tcp": [{ HostIp: "0.0.0.0", HostPort: "25565" }] }, networkMode: "default" };
    const containers = new Map<string, TransferFixtureContainer>([[originalTarget.name.slice(1), originalTarget], [originalSource.name.slice(1), originalSource]]);
    const ids = new Map<string, string>(); let nextId = 1;
    const runner = { run: vi.fn(async (argv: readonly string[]) => {
      if (argv[1] === "container" && argv[2] === "inspect") {
        const value = containers.get(argv.at(-1)!);
        return value ? { exitCode: 0, signal: null, stdout: JSON.stringify(value), stderr: "" }
          : { exitCode: 1, signal: null, stdout: "", stderr: "Error: No such object" };
      }
      if (argv[1] === "inspect") return { exitCode: 0, signal: null, stdout: "healthy", stderr: "" };
      if (argv[1] === "run") {
        const name = argv[argv.indexOf("--name") + 1]!, labels = new Map<string, string>();
        for (let index = 1; index < argv.length - 1; index++) if (argv[index] === "--label") labels.set(argv[index + 1]!.split("=")[0]!, argv[index + 1]!.split("=").slice(1).join("="));
        const id = (nextId++).toString(16).padStart(64, "0"); ids.set(name, id);
        const hostBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
        for (let index = 1; index < argv.length - 1; index++) if (argv[index] === "--publish") {
          const value = argv[index + 1]!, match = /^(?:(127\.0\.0\.1|0\.0\.0\.0):)?(?:(\d*):)?(\d+)\/(tcp|udp)$/.exec(value);
          if (match) { const hostIp = match[1] ?? "0.0.0.0", hostPort = match[2] || String(43500 + nextId);
            (hostBindings[`${match[3]}/${match[4]}`] ??= []).push({ HostIp: hostIp, HostPort: hostPort }); }
        }
        containers.set(name, { id, name: `/${name}`, state: "running", running: true, health: "healthy", owner: labels.get("com.deploylite.owner")!,
          projectId: labels.get("com.deploylite.project")!, deploymentId: labels.get("com.deploylite.deployment")!, candidateId: labels.get("com.deploylite.candidate")!,
          effectiveImage: labels.get("com.deploylite.image")!, hostBindings, networkMode: "default" });
        return { exitCode: 0, signal: null, stdout: id, stderr: "" };
      }
      if (argv[1] === "stop") {
        for (const value of containers.values()) if (value.id === argv.at(-1)) { value.state = "exited"; value.running = false; }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (argv[1] === "rename") {
        const value = containers.get(argv[2]!); containers.delete(argv[2]!);
        if (value) { value.name = `/${argv[3]}`; containers.set(argv[3]!, value); }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (argv[1] === "rm") { containers.delete(argv.at(-1)!); return { exitCode: 0, signal: null, stdout: "", stderr: "" }; }
      if (argv[1] === "start") {
        const value = containers.get(argv.at(-1)!); if (value) { value.state = "running"; value.running = true; }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 1, signal: null, stdout: "", stderr: "unexpected Docker command" };
    }) };
    const result = await new DockerTransportPortExecutor({ runner, agentId, owner: "deploylite" })
      .execute(command([], transfer), { assertValid: async () => {} }, new AbortController().signal);
    expect(result).toMatchObject({ state: "updated", containerId: ids.get(`deploylite-active-${deploymentId}`),
      portTransfer: { sourceDeploymentId, sourceContainerId: ids.get(`deploylite-active-${sourceDeploymentId}`), retainedPriorContainerIds: [] } });
    expect(containers.get(`deploylite-active-${deploymentId}`)?.hostBindings).toMatchObject({ "19132/udp": [{ HostIp: "0.0.0.0", HostPort: "19132" }] });
    expect(containers.get(`deploylite-active-${sourceDeploymentId}`)?.hostBindings).toMatchObject({ "25565/tcp": [{ HostIp: "0.0.0.0", HostPort: "25565" }] });
    expect([...containers.keys()].sort()).toEqual([`deploylite-active-${deploymentId}`, `deploylite-active-${sourceDeploymentId}`].sort());
  });

  it("restores both exact prior containers when the second replacement fails", async () => {
    const sourceDeploymentId = "deployment-source", sourceImage = `registry.example.com/team/source@sha256:${"d".repeat(64)}`;
    const sourceProof = trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1, candidateId: `${sourceDeploymentId}:candidate:source-command`,
      deploymentId: sourceDeploymentId, projectId, snapshotOriginId: sourceDeploymentId, snapshotHash: "e".repeat(64),
      effectiveImageDigest: `sha256:${"d".repeat(64)}`, runtimeHost: agentId, container: `deploylite-active-${sourceDeploymentId}`,
      containerId: "f".repeat(64), hostPort: 43001, containerPort: 3000, network: null });
    const sourceBefore = [{ protocol: "udp" as const, publishedPort: 19132, targetPort: 19132 }];
    const transfer = { sourceDeploymentId, sourceContainerId: "a".repeat(64), sourceBindings: [], sourcePreviousBindings: sourceBefore,
      sourceExecutionReceipt: sourceProof, sourceEffectiveImage: sourceImage };
    const originalTarget = { id: proof.containerId, name: `/deploylite-active-${deploymentId}`, state: "running" as const, running: true, health: "healthy",
      owner: "deploylite", projectId, deploymentId, candidateId: proof.candidateId, effectiveImage,
      hostBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }] }, networkMode: "default" };
    const originalSource = { id: transfer.sourceContainerId, name: `/deploylite-active-${sourceDeploymentId}`, state: "running" as const, running: true, health: "healthy",
      owner: "deploylite", projectId, deploymentId: sourceDeploymentId, candidateId: sourceProof.candidateId, effectiveImage: sourceImage,
      hostBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43001" }], "19132/udp": [{ HostIp: "0.0.0.0", HostPort: "19132" }] }, networkMode: "default" };
    const containers = new Map<string, TransferFixtureContainer>([[originalTarget.name.slice(1), originalTarget], [originalSource.name.slice(1), originalSource]]);
    let nextId = 1;
    const runner = { run: vi.fn(async (argv: readonly string[]) => {
      if (argv[1] === "container" && argv[2] === "inspect") {
        const value = containers.get(argv.at(-1)!);
        return value ? { exitCode: 0, signal: null, stdout: JSON.stringify(value), stderr: "" }
          : { exitCode: 1, signal: null, stdout: "", stderr: "Error: No such object" };
      }
      if (argv[1] === "inspect") return { exitCode: 0, signal: null, stdout: "healthy", stderr: "" };
      if (argv[1] === "run") {
        const name = argv[argv.indexOf("--name") + 1]!;
        if (name === `deploylite-active-${sourceDeploymentId}` && !argv.includes("127.0.0.1::3000/tcp")) {
          return { exitCode: 125, signal: null, stdout: "", stderr: "simulated source replacement failure" };
        }
        const labels = new Map<string, string>();
        for (let index = 1; index < argv.length - 1; index++) if (argv[index] === "--label") labels.set(argv[index + 1]!.split("=")[0]!, argv[index + 1]!.split("=").slice(1).join("="));
        const id = (nextId++).toString(16).padStart(64, "0"), hostBindings: Record<string, Array<{ HostIp: string; HostPort: string }>> = {};
        for (let index = 1; index < argv.length - 1; index++) if (argv[index] === "--publish") {
          const match = /^(?:(127\.0\.0\.1|0\.0\.0\.0):)?(?:(\d*):)?(\d+)\/(tcp|udp)$/.exec(argv[index + 1]!);
          if (match) (hostBindings[`${match[3]}/${match[4]}`] ??= []).push({ HostIp: match[1] ?? "0.0.0.0", HostPort: match[2] || String(43500 + nextId) });
        }
        containers.set(name, { id, name: `/${name}`, state: "running", running: true, health: "healthy", owner: labels.get("com.deploylite.owner")!,
          projectId: labels.get("com.deploylite.project")!, deploymentId: labels.get("com.deploylite.deployment")!, candidateId: labels.get("com.deploylite.candidate")!,
          effectiveImage: labels.get("com.deploylite.image")!, hostBindings, networkMode: "default" });
        return { exitCode: 0, signal: null, stdout: id, stderr: "" };
      }
      if (argv[1] === "stop") {
        for (const value of containers.values()) if (value.id === argv.at(-1)) { value.state = "exited"; value.running = false; }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (argv[1] === "rename") {
        const value = containers.get(argv[2]!); containers.delete(argv[2]!);
        if (value) { value.name = `/${argv[3]}`; containers.set(argv[3]!, value); }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      if (argv[1] === "rm") { containers.delete(argv.at(-1)!); return { exitCode: 0, signal: null, stdout: "", stderr: "" }; }
      if (argv[1] === "start") {
        const value = containers.get(argv.at(-1)!); if (value) { value.state = "running"; value.running = true; }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      }
      return { exitCode: 1, signal: null, stdout: "", stderr: "unexpected Docker command" };
    }) };
    const result = await new DockerTransportPortExecutor({ runner, agentId, owner: "deploylite" })
      .execute(command([], transfer), { assertValid: async () => {} }, new AbortController().signal);
    expect(result).toMatchObject({ state: "failed", containerId: null, failureReason: "restart-failed" });
    expect(containers.get(`deploylite-active-${deploymentId}`)).toMatchObject({ id: proof.containerId, running: true,
      hostBindings: originalTarget.hostBindings });
    expect(containers.get(`deploylite-active-${sourceDeploymentId}`)).toMatchObject({ id: transfer.sourceContainerId, running: true,
      hostBindings: originalSource.hostBindings });
    expect([...containers.keys()].sort()).toEqual([`deploylite-active-${deploymentId}`, `deploylite-active-${sourceDeploymentId}`].sort());
  });
});
