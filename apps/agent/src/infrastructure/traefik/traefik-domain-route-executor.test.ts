import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOMAIN_ROUTE_APPLY_CAPABILITY, domainRouteApplyAgentCommandSchema,
  trustedPriorExecutionReceiptSchema, type DomainRouteIntentV1 } from "@deploylite/contracts";
import { claimProjectUpdateAuthority, createControlCommand, domainRouteNetworkName } from "@deploylite/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerCliRunner } from "../docker/docker-cli-image-transport.js";
import { DockerProcessError } from "../docker/docker-process-runner.js";
import { TraefikDomainRouteFileStore } from "./traefik-domain-route-file-store.js";
import { createTraefikDomainRouteExecutor } from "./traefik-domain-route-executor.js";
import { DOMAIN_ROUTE_TRAEFIK_INSPECT_FORMAT } from "./traefik-domain-route-argv.js";

const projectId = "project-1", deploymentId = "dep_0123456789abcdef", agentId = "agent-1";
const route: DomainRouteIntentV1 = { schemaVersion: 1, projectId, deploymentId, domain: "app.example.test" };
const networkName = domainRouteNetworkName(projectId);
const effectiveImage = `registry.example.com/team/app@sha256:${"b".repeat(64)}`;
const targetId = "c".repeat(64), traefikId = "d".repeat(64), networkId = "e".repeat(64);
const receipt = trustedPriorExecutionReceiptSchema.parse({
  schemaVersion: 1, candidateId: `${deploymentId}:candidate:deploy_0123456789abcdef`, deploymentId, projectId,
  snapshotOriginId: deploymentId, snapshotHash: "a".repeat(64), effectiveImageDigest: `sha256:${"b".repeat(64)}`,
  runtimeHost: agentId, container: `deploylite-active-${deploymentId}`, containerId: targetId,
  hostPort: 43000, containerPort: 3000, network: "bridge"
});
const traefikImage = "traefik:v3.6.7@sha256:a9890c898f379c1905ee5b28342f6b408dc863f08db2dab20e46c267d1ff463a";
const directories: string[] = [];
async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "deploylite-traefik-executor-"));
  directories.push(value);
  return value;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(value => rm(value, { recursive: true, force: true }))); vi.restoreAllMocks(); });

function fixture(options: { foreignNetwork?: boolean; authorityValid?: boolean } = {}) {
  const memberships = new Map<string, string>();
  let networkCreated = false;
  const network = () => ({
    id: networkId, name: networkName, driver: "bridge", internal: false, owner: "deploylite",
    project: options.foreignNetwork ? "project-foreign" : projectId, kind: "domain-route",
    containers: Object.fromEntries([...memberships].map(([id, name]) => [id, { Name: name }]))
  });
  const active = () => {
    const networks = { bridge: { networkId: "1".repeat(64), endpointId: "2".repeat(64) },
      ...(memberships.has(targetId) ? { [networkName]: { networkId, endpointId: "3".repeat(64) } } : {}) };
    return {
      id: targetId, name: `/${receipt.container}`, imageId: `sha256:${"b".repeat(64)}`, owner: "deploylite-agent", projectId,
      deploymentId, candidateId: receipt.candidateId, effectiveImage, running: true, health: "healthy",
      hostBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }] },
      portBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }] },
      networkMode: "bridge", networks
    };
  };
  const run = vi.fn(async (argv: readonly string[]) => {
    if (argv[1] === "container" && argv[2] === "ls") return { exitCode: 0, signal: null, stdout: `${traefikId}\n`, stderr: "" };
    if (argv[1] === "container" && argv[2] === "inspect" && argv[3] === "--format") {
      if (argv[4] === DOMAIN_ROUTE_TRAEFIK_INSPECT_FORMAT) return { exitCode: 0, signal: null, stdout: JSON.stringify({
        id: traefikId, name: "/deploylite-traefik-1", project: "deploylite", service: "traefik", image: traefikImage, state: "running"
      }), stderr: "" };
      return { exitCode: 0, signal: null, stdout: JSON.stringify(active()), stderr: "" };
    }
    if (argv[1] === "image") return { exitCode: 0, signal: null, stdout: JSON.stringify(`sha256:${"b".repeat(64)}`), stderr: "" };
    if (argv[1] === "network" && argv[2] === "inspect") {
      if (!networkCreated) throw new DockerProcessError("failed", { exitCode: 1, signal: null, stdout: "", stderr: `No such network: ${networkName}` });
      return { exitCode: 0, signal: null, stdout: JSON.stringify(network()), stderr: "" };
    }
    if (argv[1] === "network" && argv[2] === "create") {
      networkCreated = true;
      if (options.foreignNetwork) memberships.set("9".repeat(64), "/unrelated-container");
      return { exitCode: 0, signal: null, stdout: networkId, stderr: "" };
    }
    if (argv[1] === "network" && argv[2] === "connect") {
      memberships.set(argv[4]!, argv[4] === targetId ? `/${receipt.container}` : "/deploylite-traefik-1");
      return { exitCode: 0, signal: null, stdout: "", stderr: "" };
    }
    if (argv[1] === "container" && argv[2] === "inspect") return { exitCode: 0, signal: null, stdout: JSON.stringify({
      id: argv[5], name: "/deploylite-active-other", owner: "deploylite-agent", project: projectId, deployment: "other", state: "running"
    }), stderr: "" };
    throw new Error(`Unexpected Docker argv: ${argv.join(" ")}`);
  });
  const now = 1_800_000_000_000;
  const control = { ...createControlCommand({ actorId: "actor-1", action: "project.update", scope: { kind: "project", projectId },
    input: { route, receipt, effectiveImage }, idempotencyKey: "route-1", correlationId: "correlation-1", expiresAt: new Date(now + 30_000) }), status: "eligible" as const };
  const authority = claimProjectUpdateAuthority([control], control, now)!;
  const command = domainRouteApplyAgentCommandSchema.parse({
    schemaVersion: 1, action: "domain.route.apply", agentId, commandId: control.id, projectId, idempotencyKey: control.idempotencyKey,
    inputDigest: control.inputDigest, route, executionReceipt: receipt, effectiveImage,
    requiredCapabilities: [DOMAIN_ROUTE_APPLY_CAPABILITY], authority, lease: authority.projectLease,
    context: { requestId: "request-1", correlationId: control.correlationId }, timeoutMs: 30_000, cancellationRequested: false
  });
  return { run, command, authority: { assertValid: vi.fn(async () => { if (options.authorityValid === false) throw new Error("expired"); }) }, networkName };
}

describe("Traefik domain route executor", () => {
  it("joins only the receipt-bound target and verified Traefik to a labeled project network before writing the file", async () => {
    const root = await directory(), f = fixture(), executor = createTraefikDomainRouteExecutor({
      runner: { run: f.run } as unknown as DockerCliRunner, fileStore: new TraefikDomainRouteFileStore(root), agentId,
      now: () => 1_800_000_000_001
    });
    const result = await executor.execute(f.command, f.authority, new AbortController().signal);
    expect(result).toMatchObject({ state: "created", networkName: f.networkName, networkId, targetContainerId: targetId, traefikContainerId: traefikId });
    expect(f.run.mock.calls.some(([argv]) => argv[1] === "network" && argv[2] === "create")).toBe(true);
    const fileName = result.fileName!;
    const files = await readdir(root);
    expect(files).toEqual([fileName]);
    expect(await readFile(join(root, fileName), "utf8")).toContain(`http://${receipt.container}:3000`);
    expect(f.run.mock.calls.filter(([argv]) => argv[1] === "network" && argv[2] === "connect").map(([argv]) => argv[4]))
      .toEqual([targetId, traefikId]);
  });

  it("rejects a foreign-owned project network without writing a route file", async () => {
    const root = await directory(), f = fixture({ foreignNetwork: true }), executor = createTraefikDomainRouteExecutor({
      runner: { run: f.run } as unknown as DockerCliRunner, fileStore: new TraefikDomainRouteFileStore(root), agentId,
      now: () => 1_800_000_000_001
    });
    const result = await executor.execute(f.command, f.authority, new AbortController().signal);
    expect(result).toMatchObject({ state: "failed", failureReason: "network-conflict" });
    expect(await readdir(root)).toEqual([]);
    expect(f.run.mock.calls.some(([argv]) => argv[1] === "network" && argv[2] === "connect")).toBe(false);
  });

  it("fails before Docker inspection if the project update authority is no longer valid", async () => {
    const root = await directory(), f = fixture({ authorityValid: false }), executor = createTraefikDomainRouteExecutor({
      runner: { run: f.run } as unknown as DockerCliRunner, fileStore: new TraefikDomainRouteFileStore(root), agentId,
      now: () => 1_800_000_000_001
    });
    await expect(executor.execute(f.command, f.authority, new AbortController().signal)).rejects.toMatchObject({ code: "authority-invalid" });
    expect(f.run).not.toHaveBeenCalled();
  });
});
