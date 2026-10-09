import { transportPortApplyAgentCommandSchema, trustedPriorExecutionReceiptSchema } from "@deploylite/contracts";
import { claimProjectUpdateAuthority, createControlCommand } from "@deploylite/domain";
import { describe, expect, it, vi } from "vitest";
import { DockerTransportPortExecutor } from "./docker-transport-port-executor.js";

const projectId = "project-1", deploymentId = "deployment-1", agentId = "agent-1";
const effectiveImage = `registry.example.com/team/app@sha256:${"b".repeat(64)}`;
const route = { schemaVersion: 1 as const, projectId, deploymentId, protocol: "udp" as const, publishedPort: 19132, targetPort: 19132 };
const proof = trustedPriorExecutionReceiptSchema.parse({ schemaVersion: 1, candidateId: `${deploymentId}:candidate:command-1`, deploymentId, projectId,
  snapshotOriginId: deploymentId, snapshotHash: "a".repeat(64), effectiveImageDigest: `sha256:${"b".repeat(64)}`, runtimeHost: agentId,
  container: `deploylite-active-${deploymentId}`, containerId: "c".repeat(64), hostPort: 43000, containerPort: 3000, network: null });

function command(previousBindings = [{ protocol: route.protocol, publishedPort: route.publishedPort, targetPort: route.targetPort }]) {
  const operation = "apply" as const, rollbackRevisionId = null;
  const input = { route, executionReceipt: proof, effectiveImage, operation, rollbackRevisionId };
  const now = Date.now(), control = { ...createControlCommand({ actorId: "actor-1", action: "project.update", scope: { kind: "project", projectId },
    input, idempotencyKey: "port-command-1", correlationId: "correlation-1", expiresAt: new Date(now + 30_000) }), status: "eligible" as const };
  const authority = claimProjectUpdateAuthority([control], control, now)!;
  return transportPortApplyAgentCommandSchema.parse({ schemaVersion: 1, action: "transport.port.apply", agentId, commandId: control.id, projectId,
    idempotencyKey: control.idempotencyKey, inputDigest: control.inputDigest, operation, rollbackRevisionId, route,
    currentContainerId: proof.containerId,
    bindings: [{ protocol: route.protocol, publishedPort: route.publishedPort, targetPort: route.targetPort }],
    previousBindings,
    executionReceipt: proof, effectiveImage, requiredCapabilities: ["docker.transport.port.apply.v1"], authority, lease: authority.projectLease,
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
});
