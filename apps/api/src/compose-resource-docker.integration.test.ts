import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { hashSessionToken } from "@deploylite/db";
import { createEnvSecretCipher, loadEnvSecretKey } from "@deploylite/config";
import { InMemoryCapabilityRegistry, COMPOSE_RESOURCE_INSPECTION_CAPABILITY, COMPOSE_NETWORK_ATTACHMENT_CAPABILITY,
  COMPOSE_RESOURCE_CLEANUP_CAPABILITY, COMPOSE_VOLUME_ATTACHMENT_CAPABILITY, COMPOSE_VOLUME_BACKUP_CAPABILITY, type Project, type ComposeResourceKind,
  type ComposeVolumeAttachmentAgentCommandV1 } from "@deploylite/contracts";
import { createComposePreview, digestComposeResourceObservation, InMemoryComposeRevisionSaveStore,
  InMemoryComposeVolumeBackupPlanStore, InMemoryComposeResourceCleanupStore, InMemoryEnvSecretValueRepository,
  claimProjectUpdateAuthority, resolveControlCommandInMemory, validateProjectUpdateAuthority,
  type AuditEventInput, type ComposeResourceInspector, type DeploymentAuthorityValidation, type ProjectUpdateControlRepository } from "@deploylite/domain";
import { AuthenticatedAgentCommandReceiver } from "@deploylite/agent";
import { DockerProcessError, DockerProcessRunner, type DockerProcessExit } from "../../agent/src/infrastructure/docker/docker-process-runner.js";
import { createDockerComposeResourceInspector } from "../../agent/src/infrastructure/docker/docker-compose-resource-inspector.js";
import { createDockerComposeNetworkAttachmentExecutor } from "../../agent/src/infrastructure/docker/docker-compose-network-attachment.js";
import { createDockerComposeVolumeAttachmentExecutor } from "../../agent/src/infrastructure/docker/docker-compose-volume-attachment.js";
import { createDockerComposeVolumeReplacementDriver } from "../../agent/src/infrastructure/docker/docker-compose-volume-replacement-driver.js";
import { createDockerComposeVolumeBackupExecutor, createLocalDirectoryComposeVolumeBackupSource } from "../../agent/src/infrastructure/docker/docker-compose-volume-backup.js";
import { createDockerComposeResourceCleanupExecutor } from "../../agent/src/infrastructure/docker/docker-compose-resource-cleanup.js";
import { COMPOSE_CONTAINER_INSPECT_FORMAT, COMPOSE_NETWORK_INSPECT_FORMAT, COMPOSE_REPLACEMENT_CANDIDATE_INSPECT_FORMAT, COMPOSE_REPLACEMENT_HEALTHCHECK_FORMAT,
  COMPOSE_REPLACEMENT_HEALTH_FORMAT } from "../../agent/src/infrastructure/docker/docker-compose-resource-argv.js";
import { startAgentServer } from "../../agent/src/server.js";
import { AuthenticatedAgentDeploymentTransport } from "./agent-transport.js";
import { AuthenticatedAgentComposeResourceInspectionTransport } from "./compose-resource-inspection-transport.js";
import { buildApiApp, createInMemoryExecutionRepositories, InMemoryAuditRepository, InMemoryAuthUserRepository, InMemorySessionRepository } from "./app.js";

const enabled = process.env.DEPLOYLITE_P3_DOCKER_INTEGRATION === "1";
const fixtureImagePattern = /^127\.0\.0\.1:49172\/deploylite-p3\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const secretFreeMarker = "deploylite-p3-owned-volume-marker-v1";
const policy = { policyVersion: "p3-disposable-ci-v1", trustedHosts: ["127.0.0.1:49172"], allowTags: false, allowDigests: true };
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const apps: Awaited<ReturnType<typeof buildApiApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

type Manifest = { schemaVersion: 1; repository: string; commit: string; runId: string; runAttempt: string; job: string;
  engineId: string; dockerHost: string; image: string; imageId: string; platform: "linux/amd64"; sourceHashes: Record<string, string>;
  preparation: { baseImage: string; baseImageId: string; registryImage: string; registryImageId: string; networkName: string; networkId: string;
    registryContainerName: string; registryContainerId: string; loopbackPort: 49172; cleanupVerified: true } };
type Owned = { id: string; kind: "container" | "network" | "volume"; name: string; resourceKind?: ComposeResourceKind; key?: string; created?: boolean };
type Evidence = { schemaVersion: 1; status: "PASS" | "FAILED" | "CLEANUP_BLOCKED"; repository: string; commit: string; runId: string;
  runAttempt: string; projectId: string; owner: string; agentId: string; image: string; imageId: string; sourceHashes: Record<string, string>;
  operations: Array<{ operation: string; status: string; receipt?: unknown }>; resources: Owned[]; cleanup: Array<{ kind: string; id: string; verifiedAbsent: boolean }> };

async function privateManifest(): Promise<Manifest> {
  assert.equal(process.env.DEPLOYLITE_P3_DOCKER_RUNTIME_GRANT, "P3_COMPOSE_CI_APPROVED");
  assert.equal(process.env.GITHUB_ACTIONS, "true"); assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.env.GITHUB_REPOSITORY, "DeployLiteApp/DeployLite"); assert.equal(process.env.GITHUB_JOB, "p3-docker-acceptance");
  assert.equal(process.env.DEPLOYLITE_P3_HEAD_REPOSITORY, "DeployLiteApp/DeployLite");
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    assert.equal(process.env.GITHUB_BASE_REF, "main"); assert(process.env.GITHUB_HEAD_REF);
  } else if (process.env.GITHUB_EVENT_NAME === "push") {
    assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  } else {
    assert.fail("P3 acceptance requires an internal main pull request or main push");
  }
  assert.equal(process.env.DOCKER_HOST, "unix:///var/run/docker.sock");
  assert(!process.env.DOCKER_CONTEXT && !process.env.DOCKER_TLS_VERIFY && !process.env.DOCKER_CERT_PATH);
  const path = process.env.DEPLOYLITE_P3_FIXTURE_MANIFEST; assert(path && resolve(path) === path);
  const stat = await lstat(path); assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.());
  const value = JSON.parse(await readFile(path, "utf8")) as Manifest;
  assert.equal(value.schemaVersion, 1); assert.equal(value.repository, process.env.GITHUB_REPOSITORY);
  assert.equal(value.commit, process.env.DEPLOYLITE_P3_EXPECTED_SHA); assert.equal(value.runId, process.env.GITHUB_RUN_ID);
  assert.equal(value.runAttempt, process.env.GITHUB_RUN_ATTEMPT); assert.equal(value.job, process.env.GITHUB_JOB);
  assert.equal(value.dockerHost, process.env.DOCKER_HOST); assert.equal(value.platform, "linux/amd64");
  assert(fixtureImagePattern.test(value.image)); assert(/^sha256:[a-f0-9]{64}$/.test(value.imageId));
  const safeRun = `${value.runId}-${value.runAttempt}`.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  assert.equal(value.preparation.baseImage, "docker.io/library/busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092");
  assert.equal(value.preparation.registryImage, "docker.io/library/registry:3.1.2@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8");
  assert(/^sha256:[a-f0-9]{64}$/.test(value.preparation.baseImageId) && /^sha256:[a-f0-9]{64}$/.test(value.preparation.registryImageId));
  assert(/^[a-f0-9]{64}$/.test(value.preparation.networkId) && /^[a-f0-9]{64}$/.test(value.preparation.registryContainerId));
  assert.equal(value.preparation.networkName, `deploylite-p3-prep-${safeRun}`); assert.equal(value.preparation.registryContainerName, `deploylite-p3-registry-${safeRun}`);
  assert.equal(value.preparation.loopbackPort, 49172); assert.equal(value.preparation.cleanupVerified, true);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), value.commit);
  for (const [relative, expected] of Object.entries(value.sourceHashes)) assert.equal(sha256(await readFile(resolve(root, relative))), expected, `fixture source changed: ${relative}`);
  return value;
}

function boundedRunner(allowed: (argv: readonly string[]) => boolean, captureContainerId: (value: string) => void = () => undefined,
  reportFailure: (operation: string, detail: string) => void = () => undefined,
  reportSuccess: (operation: string, argv: readonly string[], result: DockerProcessExit) => void = () => undefined) {
  const processRunner = new DockerProcessRunner({ timeoutMs: 15_000, maxOutputBytes: 65_536, spawn: (file, args, options) => {
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C", LC_ALL: "C", DOCKER_HOST: process.env.DOCKER_HOST!, DOCKER_CONFIG: process.env.DOCKER_CONFIG! };
    return nodeSpawn(file, args, { ...options, env });
  } });
  const runner = { async run(argv: readonly string[], signal: AbortSignal, environment?: Readonly<Record<string, string>>) {
    assert.equal(argv[0], "docker");
    const operation = argv.slice(1, 3).join(" ");
    if (!allowed(argv)) { reportFailure(operation, "blocked-by-fixture-allowlist"); assert(false, `out-of-fixture Docker operation: ${operation}`); }
    let result: DockerProcessExit;
    try { result = await processRunner.run(argv, signal, environment); }
    catch (error) {
      const failure = error instanceof DockerProcessError ? error.result : undefined;
      if (failure) {
        const detail = failure.stderr.replace(/[\r\n]+/g, " ").replace(/\b[a-f0-9]{32,64}\b/gi, "[REDACTED]").slice(0, 240);
        reportFailure(operation, `exit=${failure.exitCode}; stderr=${detail || "empty"}`);
        throw new Error(`P3 fixture Docker operation failed (${operation}; exit=${failure.exitCode}; stderr=${detail})`);
      }
      reportFailure(operation, error instanceof DockerProcessError ? `runner=${error.kind}` : "runner-error");
      throw error;
    }
    if (result.exitCode !== 0 || result.signal !== null) { reportFailure(operation, "nonzero-result"); throw new Error("P3 fixture Docker operation failed"); }
    reportSuccess(operation, argv, result);
    const args = argv.slice(1);
    if ((args[0] === "run" || args[0] === "container" && args[1] === "run") && /^[a-f0-9]{64}$/.test(result.stdout.trim())) captureContainerId(result.stdout.trim());
    return result;
  } };
  return runner;
}

function containerFormat(labels: Record<string, string>) {
  return ["--label", `com.deploylite.owner=${labels.owner}`, "--label", `com.deploylite.project=${labels.project}`];
}

describe.skipIf(!enabled)("P3 C3-C8 disposable Docker acceptance", () => {
  it("binds observed ownership, network changes, volume replacement, backup and confirmed cleanup to one exact run", async () => {
    const manifest = await privateManifest(), runId = manifest.runId.replace(/[^a-z0-9-]/gi, "-").toLowerCase(), projectId = `p3c8-${runId}-${manifest.runAttempt}`;
    const owner = "deploylite", agentId = `p3agent-${runId}`, trustKey = randomBytes(32).toString("hex"), session = randomUUID();
    const priorDocument = JSON.stringify({ services: { app: { image: manifest.image, networks: ["backend"] } }, networks: { backend: { internal: true }, extra: { internal: true } }, volumes: { data: {} } });
    const attachedDocument = JSON.stringify({ services: { app: { image: manifest.image, networks: ["backend", "extra"] } }, networks: { backend: { internal: true }, extra: { internal: true } }, volumes: { data: {} } });
    const nextDocument = JSON.stringify({ services: { app: { image: manifest.image, networks: ["backend"], volumes: [{ type: "volume", source: "data", target: "/data" }] } }, networks: { backend: { internal: true }, extra: { internal: true } }, volumes: { data: {} } });
    const priorPreview = createComposePreview(priorDocument, projectId, policy), nextPreview = createComposePreview(nextDocument, projectId, policy);
    const backend = priorPreview.networks.find(value => value.key === "backend")!, extra = priorPreview.networks.find(value => value.key === "extra")!, volume = nextPreview.volumes.find(value => value.key === "data")!;
    const artifactDir = process.env.RUNNER_TEMP ? join(process.env.RUNNER_TEMP, "deploylite-p3-evidence") : "";
    assert(artifactDir); await mkdir(artifactDir, { mode: 0o700, recursive: true });
    const artifactPath = join(artifactDir, "compose-acceptance.json");
    const evidence: Evidence = { schemaVersion: 1, status: "FAILED", repository: manifest.repository, commit: manifest.commit, runId: manifest.runId,
      runAttempt: manifest.runAttempt, projectId, owner, agentId, image: manifest.image, imageId: manifest.imageId, sourceHashes: manifest.sourceHashes,
      operations: [], resources: [], cleanup: [] };
    const ownedIds = new Set<string>(), resourceByName = new Map<string, Owned>();
    const log = (operation: string, status: string, receipt?: unknown) => evidence.operations.push({ operation, status, ...(receipt === undefined ? {} : { receipt }) });
    log("C8 exact-source integrated fixture binding", "PASS", { repository: manifest.repository, commit: manifest.commit, runId: manifest.runId,
      runAttempt: manifest.runAttempt, engineId: manifest.engineId, preparation: manifest.preparation });
    const allowedNames = new Set([backend.runtimeName, extra.runtimeName, volume.runtimeName]);
    const allowedContainerNames = new Set([`p3c8-${runId}-seed`, `p3c8-${runId}-service`]);
    const allowedIds = new Set<string>();
    let backupSourceRoot = "";
    let backupSourceContainerId: string | undefined;
    const allowed = (argv: readonly string[]) => {
      const a = argv.slice(1), op = a.slice(0, 2).join(" ");
      if (a[0] === "network" && a[1] === "create") return allowedNames.has(a.at(-1)!) && a.includes("--internal");
      if (a[0] === "volume" && a[1] === "create") return a.at(-1) === volume.runtimeName;
      const safeFixtureRun = () => {
        const name = a[a.indexOf("--name") + 1];
        const nameAllowed = allowedContainerNames.has(name ?? "") || /^dl-[a-f0-9]{32}-vol-candidate$/.test(name ?? "");
        const seed = name === `p3c8-${runId}-seed`;
        const bounded = seed ? a.includes("--cpus=0.25") && a.includes("--memory=33554432") && a.includes("--pids-limit=32")
          : a.includes("--cpus=0.5") && a.includes("--memory=67108864") && a.includes("--pids-limit=64");
        return nameAllowed && bounded && a.includes(manifest.image) && !a.includes("--publish")
          && a.includes("--read-only") && a.includes("--cap-drop=ALL") && a.includes("--security-opt=no-new-privileges");
      };
      if (a[0] === "container" && a[1] === "run") return safeFixtureRun();
      if (a[0] === "run") return safeFixtureRun();
      if (a[0] === "container" && a[1] === "cp") return !!backupSourceContainerId && allowedIds.has(backupSourceContainerId)
        && a.length === 4 && a[2] === `${backupSourceContainerId}:/data/.` && a[3] === backupSourceRoot;
      if (a[0] === "container" && ["inspect", "diff", "start", "stop", "rm", "exec"].includes(a[1]!)) return allowedIds.has(a[1] === "exec" ? a[2]! : a.at(-1)!) || a[1] === "inspect" && a.includes("--format") && allowedNames.has(a.at(-1)!);
      if (a[0] === "container" && a[1] === "ls") return a.includes("--all") && a.includes("--no-trunc") || a.includes("--filter");
      if (a[0] === "network" && ["inspect", "connect", "disconnect", "rm"].includes(a[1]!)) {
        const network = a[1] === "inspect" ? a.at(-1)! : a[1] === "connect" && a[2] === "--alias" ? a[4]! : a[2]!;
        return allowedNames.has(network) && (a[1] === "inspect" || a[1] === "rm" || allowedIds.has(a.at(-1)!));
      }
      if (a[0] === "volume" && ["inspect", "rm"].includes(a[1]!)) return allowedNames.has(a.at(-1)!);
      if (a[0] === "volume" && a[1] === "ls") return a.includes("--filter");
      if (a[0] === "network" && a[1] === "ls") return a.includes("--filter");
      return false;
    };
    const dockerFailureDiagnostics: string[] = []; let lastDockerOperation = "none";
    let lastNetworkInspection: { name: string; id: string } | undefined, networkProjection = "unavailable";
    let stoppedVolumeMountProjection: Record<string, unknown> | undefined;
    let candidateObservation: Record<string, unknown> | undefined, createdCandidateId: string | undefined;
    const replacementAgentObservations: Array<Record<string, unknown>> = [];
    const replacementDriverEvents: Array<Record<string, unknown>> = [];
    let replacementExecutionStartedAt: number | undefined, volumeAttachmentActive = false;
    let observedAgentVolumeCommand: ComposeVolumeAttachmentAgentCommandV1 | undefined;
    const runner = boundedRunner(allowed, id => allowedIds.add(id), (operation, detail) => { if (dockerFailureDiagnostics.length < 8) dockerFailureDiagnostics.push(`${operation}: ${detail}`); },
      (operation, argv, result) => {
        lastDockerOperation = operation;
        if (argv[1] === "run" && argv.includes("--name") && /^dl-[a-f0-9]{32}-vol-candidate$/.test(argv[argv.indexOf("--name") + 1] ?? "")) {
          createdCandidateId = result.stdout.trim();
        }
        if (argv[1] === "container" && argv[2] === "inspect" && argv[4] === COMPOSE_REPLACEMENT_CANDIDATE_INSPECT_FORMAT) {
          try { candidateObservation = JSON.parse(result.stdout) as Record<string, unknown>; } catch { candidateObservation = undefined; }
        }
        if (argv[1] === "network" && argv[2] === "inspect" && argv[4] === COMPOSE_NETWORK_INSPECT_FORMAT) {
          try {
            const observation = JSON.parse(result.stdout) as { name?: string; id?: string };
            lastNetworkInspection = { name: observation.name ?? "", id: observation.id ?? "" };
          } catch { lastNetworkInspection = undefined; }
        }
        if (argv[1] === "container" && argv[2] === "inspect" && argv[4] === COMPOSE_CONTAINER_INSPECT_FORMAT) {
          try {
            const observation = JSON.parse(result.stdout) as { id?: string; running?: boolean; networks?: Array<{ name: string; networkId: string }>;
              mounts?: Array<{ type: string; name: string | null; target: string; readOnly: boolean }>;
              configuredMounts?: Array<{ type: string; name: string | null; target: string; readOnly: boolean }> };
            networkProjection = JSON.stringify({ expectedNameLength: lastNetworkInspection?.name.length ?? 0,
              expectedIdLength: lastNetworkInspection?.id.length ?? 0,
              entries: (observation.networks ?? []).slice(0, 8).map(network => ({ nameMatches: network.name === lastNetworkInspection?.name,
                idMatches: network.networkId === lastNetworkInspection?.id, idLength: network.networkId.length })) });
            if (observation.id === createdCandidateId && observation.running === false) {
              const active = observation.mounts ?? [], configured = observation.configuredMounts ?? [];
              stoppedVolumeMountProjection = { running: false,
                activeMountCount: active.length, activeExpectedMountCount: active.filter(mount => mount.type === "volume" && mount.name === volume.runtimeName
                  && mount.target === "/data" && mount.readOnly === false).length,
                configuredMountCount: configured.length, configuredExpectedMountCount: configured.filter(mount => mount.type === "volume"
                  && mount.name === volume.runtimeName && mount.target === "/data" && mount.readOnly === false).length };
            }
          } catch { networkProjection = "container-network-output-unparseable"; }
        }
      });
    const docker = async (args: readonly string[]) => (await runner.run(["docker", ...args], new AbortController().signal)).stdout.trim();
    const dockerJson = async <T>(args: readonly string[]) => JSON.parse(await docker(args)) as T;
    const register = (resource: Owned) => { evidence.resources.push(resource); resourceByName.set(resource.name, resource); if (resource.kind === "container") allowedIds.add(resource.id); };
    let server: Awaited<ReturnType<typeof startAgentServer>> | undefined, api: Awaited<ReturnType<typeof buildApiApp>> | undefined;
    const archiveDestination = await mkdtemp(join(artifactDir, ".backup-"));
    backupSourceRoot = await mkdtemp(join(artifactDir, ".volume-source-"));
    const caps = new InMemoryCapabilityRegistry([COMPOSE_RESOURCE_INSPECTION_CAPABILITY, COMPOSE_NETWORK_ATTACHMENT_CAPABILITY, COMPOSE_VOLUME_ATTACHMENT_CAPABILITY,
      COMPOSE_VOLUME_BACKUP_CAPABILITY, COMPOSE_RESOURCE_CLEANUP_CAPABILITY]);
    const physicalInspector = createDockerComposeResourceInspector({ runner, owner, agentId, imagePolicy: policy, capabilities: caps,
      clock: { now: Date.now }, limits: { maxContainers: 32, maxOutputBytes: 65_536, deadlineMs: 15_000 } });
    const replay = new Map<string, { fingerprint: string; token: string; receipt?: Record<string, unknown> }>();
    const replayStore = { durable: false,
      claim: async (id: string, fingerprint: string) => { const prior = replay.get(id); if (prior) { if (prior.fingerprint !== fingerprint) throw new Error("fixture replay conflict"); return prior.receipt ? { claimed: false, receipt: prior.receipt } : { claimed: false }; } const token = randomUUID(); replay.set(id, { fingerprint, token }); return { claimed: true, claimToken: token }; },
      wait: async (id: string) => { const value = replay.get(id)?.receipt; if (!value) throw new Error("fixture replay receipt absent"); return value; },
      complete: async (id: string, value: { fingerprint: string; claimToken: string; receipt: Record<string, unknown> }) => { const prior = replay.get(id); if (!prior || prior.token !== value.claimToken || prior.fingerprint !== value.fingerprint) throw new Error("fixture replay claim changed"); prior.receipt = structuredClone(value.receipt); },
      release: async (id: string, token?: string) => { const prior = replay.get(id); if (prior && (!token || prior.token === token)) replay.delete(id); } };
    let appAudit: InMemoryAuditRepository | undefined;
    let resources: ComposeResourceInspector | undefined;
    try {
      for (const name of [backend.runtimeName, extra.runtimeName]) assert.equal(await docker(["network", "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"]), "");
      assert.equal(await docker(["volume", "ls", "--filter", `name=^${volume.runtimeName}$`, "--format", "{{.Name}}"]), "");
      const createNetwork = async (name: string, key: string) => {
        await docker(["network", "create", "--driver", "bridge", "--internal", ...containerFormat({ owner, project: projectId }), "--label", "com.deploylite.resource.kind=network", "--label", `com.deploylite.resource.key=${key}`, name]);
        const resource = await dockerJson<{ id: string; owner: string; projectId: string; resourceKind: string; resourceKey: string }>(["network", "inspect", "--format", `{"id":{{json .Id}},"owner":{{json (index .Labels "com.deploylite.owner")}},"projectId":{{json (index .Labels "com.deploylite.project")}},"resourceKind":{{json (index .Labels "com.deploylite.resource.kind")}},"resourceKey":{{json (index .Labels "com.deploylite.resource.key")}}}`, name]);
        assert.equal(resource.owner, owner); assert.equal(resource.projectId, projectId); assert.equal(resource.resourceKind, "network"); assert.equal(resource.resourceKey, key);
        register({ id: resource.id, kind: "network", name, resourceKind: "network", key, created: true }); return resource.id;
      };
      const backendId = await createNetwork(backend.runtimeName, "backend"), extraId = await createNetwork(extra.runtimeName, "extra");
      await docker(["volume", "create", "--driver", "local", ...containerFormat({ owner, project: projectId }), "--label", "com.deploylite.resource.kind=volume", "--label", "com.deploylite.resource.key=data", volume.runtimeName]);
      const volumeInfo = await dockerJson<{ CreatedAt: string; Labels: Record<string, string> }>(["volume", "inspect", "--format", `{"CreatedAt":{{json .CreatedAt}},"Labels":{{json .Labels}}}`, volume.runtimeName]);
      assert.equal(volumeInfo.Labels["com.deploylite.owner"], owner); assert.equal(volumeInfo.Labels["com.deploylite.project"], projectId);
      assert.equal(volumeInfo.Labels["com.deploylite.resource.kind"], "volume"); assert.equal(volumeInfo.Labels["com.deploylite.resource.key"], "data");
      register({ id: volumeInfo.CreatedAt, kind: "volume", name: volume.runtimeName, resourceKind: "volume", key: "data", created: true });
      const seedName = `p3c8-${runId}-seed`, seedId = await docker(["run", "--detach", "--name", seedName, "--network", "none", "--user", "0:0",
        "--cpus=0.25", "--memory=33554432", "--pids-limit=32", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--mount", `type=volume,source=${volume.runtimeName},target=/data`, "--entrypoint", "/bin/sh", manifest.image, "-c", `printf '%s' '${secretFreeMarker}' > /data/p3-marker.txt && sleep 30`]);
      const seedOwned = { id: seedId, kind: "container" as const, name: seedName, created: true }; register(seedOwned);
      await docker(["container", "exec", seedId, "/bin/sh", "-c", "test \"$(cat /data/p3-marker.txt)\" = deploylite-p3-owned-volume-marker-v1"]);
      await docker(["container", "rm", "--force", seedId]); seedOwned.created = false;

      const project: Project = { id: projectId, name: "P3 disposable CI fixture", repoUrl: "https://github.com/DeployLiteApp/DeployLite", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null };
      const projectRows = new Map([[projectId, project]]);
      const projects = { save: async (value: Project) => { projectRows.set(value.id, structuredClone(value)); return structuredClone(value); }, findById: async (id: string) => structuredClone(projectRows.get(id) ?? null),
        list: async () => [...projectRows.values()].map(value => structuredClone(value)), remove: async (id: string) => projectRows.delete(id) };
      appAudit = new InMemoryAuditRepository(); const memory = createInMemoryExecutionRepositories(projects, appAudit);
      const revisions = new InMemoryComposeRevisionSaveStore({ ledger: memory.completion, appendAudit: value => { appAudit!.appendSynchronous(value); } });
      const secrets = new InMemoryEnvSecretValueRepository(), cipher = createEnvSecretCipher(loadEnvSecretKey(randomBytes(32).toString("hex")));
      const user = { id: "p3-ci-operator", email: "p3-ci@example.test", emailNormalized: "p3-ci@example.test", passwordHash: "unused-fixture", role: "admin" as const,
        status: "active" as const, createdAt: new Date(), updatedAt: new Date() };
      const sessions = new InMemorySessionRepository(); await sessions.create({ userId: user.id, tokenHash: hashSessionToken(session), expiresAt: new Date(Date.now() + 60 * 60_000) });
      const grants = { listForActor: async (actorId: string) => ["project.update", "project.deploy", "project.delete"].map(action => ({ id: `p3-${action}`, actorId,
        action: action as "project.update" | "project.deploy" | "project.delete", scope: { kind: "project" as const, projectId } })) };
      const control = memory.controls;
      const agentInspector: ComposeResourceInspector = {
        async inspect(...args) {
          const [input] = args;
          try {
            const observation = await physicalInspector.inspect(...args);
            if (createdCandidateId && observedAgentVolumeCommand && input.preview.configDigest === nextPreview.configDigest
              && ["volume", "network"].includes(input.kind) && replacementAgentObservations.length < 8) {
              const expectedService = input.preview.services.find(value => value.name === observedAgentVolumeCommand!.service);
              const expectedNetwork = expectedService && input.preview.networks.find(value => value.key === expectedService.networks[0])?.runtimeName;
              const expectedMounts = expectedService?.volumes.map(value => ({ target: value.target, readOnly: value.readOnly })) ?? [];
              const plannedResource = (input.kind === "network" ? input.preview.networks : input.preview.volumes).find(value => value.key === input.key);
              const validPhysicalIdentity = input.kind === "volume"
                ? /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(observation.physicalIdentity)
                  && Number.isFinite(Date.parse(observation.physicalIdentity))
                : /^[a-f0-9]{64}$/.test(observation.physicalIdentity);
              const candidate = observation.containers.find(value => value.containerId === createdCandidateId);
              const prior = observation.containers.find(value => value.containerId === observedAgentVolumeCommand!.containerId);
              replacementAgentObservations.push({ phase: volumeAttachmentActive ? "executor" : "after-response",
                elapsedMs: replacementExecutionStartedAt === undefined ? null : Date.now() - replacementExecutionStartedAt,
                kind: input.kind, containerCount: observation.containers.length,
                observationDigestMatches: digestComposeResourceObservation(observation) === observation.stateDigest,
                observationOwnerMatches: observation.owner === owner, observationAgentMatches: observation.agentId === observedAgentVolumeCommand.agentId,
                observationProjectMatches: observation.projectId === observedAgentVolumeCommand.projectId,
                observationKindMatches: observation.kind === input.kind, observationKeyMatches: observation.key === input.key,
                observationRuntimeNameMatches: Boolean(plannedResource && observation.runtimeName === plannedResource.runtimeName),
                observationConfigMatches: observation.configDigest === input.preview.configDigest, observationIdentityValid: validPhysicalIdentity,
                candidateObserved: Boolean(candidate), candidateRunning: candidate?.running === true, candidateAttached: candidate?.attached === true,
                candidateRevisionMatches: candidate?.composeRevisionId === observedAgentVolumeCommand.revisionId,
                candidateConfigMatches: candidate?.composeConfigDigest === observedAgentVolumeCommand.configDigest,
                candidateEnvironmentMatches: candidate?.composeEnvironmentDigest === observedAgentVolumeCommand.secretDigest,
                candidateMountsMatch: JSON.stringify(candidate?.mounts ?? []) === JSON.stringify(expectedMounts),
                candidateNetworkMatches: Boolean(expectedNetwork && candidate?.networks?.some(value => value.name === expectedNetwork)),
                candidateNetworkIdPresent: Boolean(expectedNetwork && candidate?.networks?.find(value => value.name === expectedNetwork)?.networkId),
                priorObserved: Boolean(prior), priorRunning: prior?.running === true });
            }
            return observation;
          } catch (error) {
            if (createdCandidateId && observedAgentVolumeCommand && ["volume", "network"].includes(input.kind)
              && replacementAgentObservations.length < 8) {
              const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code
                : error instanceof Error ? error.name : typeof error;
              replacementAgentObservations.push({ phase: volumeAttachmentActive ? "executor" : "after-response",
                elapsedMs: replacementExecutionStartedAt === undefined ? null : Date.now() - replacementExecutionStartedAt,
                kind: input.kind, configMatchesNext: input.preview.configDigest === nextPreview.configDigest,
                inspectionFailed: true, errorCode: code });
            }
            throw error;
          }
        }
      };
      const imagePolicy = policy;
      const commands = () => memory.completion.commands;
      const projectControls: ProjectUpdateControlRepository = {
        resolve: async command => resolveControlCommandInMemory(commands(), command),
        complete: async command => command,
        findProjectUpdateByIdempotency: async (actorId, selectedProject, key) => [...commands().values()].find(command => command.actorId === actorId
          && command.action === "project.update" && command.scope.kind === "project" && command.scope.projectId === selectedProject && command.idempotencyKey === key) ?? null,
        claimProjectUpdate: async command => {
          const stored = [...commands().values()].find(value => value.id === command.id); if (!stored) throw new Error("fixture command missing");
          const authority = claimProjectUpdateAuthority([...commands().values()], stored, Date.now());
          return { command: structuredClone(stored), claimed: !!authority, ...(authority ? { authority } : {}) };
        },
        validateProjectUpdateAuthority: async authority => validateProjectUpdateAuthority([...commands().values()], authority, Date.now()),
        completeProjectUpdate: async (command, authority, event) => {
          const stored = [...commands().values()].find(value => value.id === command.id); if (!stored) throw new Error("fixture command missing");
          if (stored.status === "completed") return structuredClone(stored);
          validateProjectUpdateAuthority([...commands().values()], authority, Date.now()); await appAudit!.append(event);
          const entry = [...commands()].find(([, value]) => value.id === command.id); if (!entry) throw new Error("fixture command key missing");
          const completed = { ...stored, status: "completed" as const }; commands().set(entry[0], completed); return structuredClone(completed);
        }
      };
      const networkAttachment = createDockerComposeNetworkAttachmentExecutor({ runner, inspector: agentInspector, owner, agentId, imagePolicy, capabilities: caps });
      const baseVolumeAttachment = createDockerComposeVolumeAttachmentExecutor({ inspector: agentInspector, owner, agentId, trustKey, imagePolicy, capabilities: caps,
        driver: (() => {
          const base = createDockerComposeVolumeReplacementDriver({ runner, owner });
          const record = (value: Record<string, unknown>) => { if (replacementDriverEvents.length < 8) replacementDriverEvents.push({
            elapsedMs: replacementExecutionStartedAt === undefined ? null : Date.now() - replacementExecutionStartedAt, ...value }); };
          const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code
            : error instanceof Error ? error.name : typeof error;
          return { ...base,
            async cutover(...args: Parameters<typeof base.cutover>) {
              try { await base.cutover(...args); record({ operation: "cutover", status: "completed" }); }
              catch (error) { record({ operation: "cutover", status: "failed", errorCode: errorCode(error) }); throw error; }
            },
            async restorePrior(...args: Parameters<typeof base.restorePrior>) {
              try { await base.restorePrior(...args); record({ operation: "restorePrior", status: "completed" }); }
              catch (error) { record({ operation: "restorePrior", status: "failed", errorCode: errorCode(error) }); throw error; }
            },
            async waitUntilHealthy(containerId, timeoutMs, signal) {
              const target = containerId === createdCandidateId ? "candidate" : "prior";
              try { const healthy = await base.waitUntilHealthy(containerId, timeoutMs, signal);
                record({ operation: "waitUntilHealthy", target, healthy }); return healthy; }
              catch (error) { record({ operation: "waitUntilHealthy", target, status: "failed", errorCode: errorCode(error) }); throw error; }
            },
            async removeCandidate(...args: Parameters<typeof base.removeCandidate>) {
              try { await base.removeCandidate(...args); record({ operation: "removeCandidate", status: "completed" }); }
              catch (error) { record({ operation: "removeCandidate", status: "failed", errorCode: errorCode(error) }); throw error; }
            }
          };
        })() });
      const volumeAttachment = { ...baseVolumeAttachment, async execute(...args: Parameters<typeof baseVolumeAttachment.execute>) {
        observedAgentVolumeCommand = structuredClone(args[0]); replacementExecutionStartedAt = Date.now(); volumeAttachmentActive = true;
        try { return await baseVolumeAttachment.execute(...args); }
        finally { volumeAttachmentActive = false; }
      } };
      const volumeBackup = createDockerComposeVolumeBackupExecutor({ owner, agentId, imagePolicy, capabilities: caps, inspector: agentInspector,
        source: createLocalDirectoryComposeVolumeBackupSource(new Map([[volume.runtimeName, backupSourceRoot]])), destinations: new Map([["ci-artifact", archiveDestination]]) });
      const resourceCleanup = createDockerComposeResourceCleanupExecutor({ runner, inspector: agentInspector, owner, agentId, imagePolicy, capabilities: caps });
      const receiver = new AuthenticatedAgentCommandReceiver({ agentId, trustKey, capabilities: ["deploy.execute", COMPOSE_RESOURCE_INSPECTION_CAPABILITY,
        COMPOSE_NETWORK_ATTACHMENT_CAPABILITY, COMPOSE_VOLUME_ATTACHMENT_CAPABILITY, COMPOSE_VOLUME_BACKUP_CAPABILITY, COMPOSE_RESOURCE_CLEANUP_CAPABILITY],
        dispatcher: { dispatch: async () => { throw new Error("unexpected deployment dispatch"); } }, replayStore, networkAttachment, volumeAttachment,
        volumeBackup, resourceInspector: agentInspector, resourceCleanup,
        authorityValidator: { validateDeploymentAuthority: async () => { throw new Error("unexpected deployment authority"); },
          validateProjectUpdateAuthority: projectControls.validateProjectUpdateAuthority } satisfies DeploymentAuthorityValidation });
      const inspectComposeResource = receiver.inspectComposeResource.bind(receiver);
      receiver.inspectComposeResource = async (body, signature, signal) => {
        try { return await inspectComposeResource(body, signature, signal); }
        catch (error) {
          const detail = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code
            : error instanceof Error ? error.name : typeof error;
          const trace = error instanceof Error ? (error.stack ?? "").split("\n").slice(1, 5).map(line => line.trim()
            .replace(/\b[a-f0-9]{32,64}\b/gi, "[REDACTED]")).join(" <- ").slice(0, 360) : "";
          if (dockerFailureDiagnostics.length < 8) dockerFailureDiagnostics.push(`agent-receiver: ${detail}; last-docker=${lastDockerOperation}; trace=${trace}`);
          throw error;
        }
      };
      server = await startAgentServer({ host: "127.0.0.1", port: 0, receiver, replayStore, production: false });
      const agentPort = (server.server.address() as AddressInfo).port, endpoint = `http://127.0.0.1:${agentPort}`;
      const transportOptions = { endpoint, trustKey, agentId, allowInsecureInternal: true, timeoutMs: 30_000 };
      const diagnosticFetch: typeof globalThis.fetch = async (input, init) => {
        const response = await globalThis.fetch(input, init);
        if (!response.ok && dockerFailureDiagnostics.length < 8) {
          const detail = (await response.clone().text().catch(() => "")).replace(/(password|secret|token|authorization|api[_-]?key|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
            .replace(/\b[a-f0-9]{32,64}\b/gi, "[REDACTED]").replace(/[\r\n\t]+/g, " ").slice(0, 200);
          dockerFailureDiagnostics.push(`agent-http-${response.status}: ${detail || "empty"}`);
        }
        return response;
      };
      const reportAgentFailure = (source: string, error: unknown) => {
        const identity = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code
          : error instanceof Error ? error.name : typeof error;
        const sanitize = (value: string) => value.replace(/(password|secret|token|authorization|api[_-]?key|credential)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
          .replace(/\b[a-f0-9]{32,64}\b/gi, "[REDACTED]").replace(/[\r\n\t]+/g, " ");
        const detail = error instanceof Error ? sanitize(error.message).slice(0, 160) : "";
        const trace = error instanceof Error ? sanitize((error.stack ?? "").split("\n").slice(1, 5).map(line => line.trim()).join(" <- ")).slice(0, 360) : "";
        if (dockerFailureDiagnostics.length < 8) dockerFailureDiagnostics.push(source + ": " + identity + "; last-docker=" + lastDockerOperation
          + "; detail=" + detail + "; trace=" + trace + "; network-projection=" + networkProjection.slice(0, 480));
      };
      const receiveAgentRequest = receiver.receive.bind(receiver);
      receiver.receive = async (body, signature, signal) => {
        try { return await receiveAgentRequest(body, signature, signal); }
        catch (error) { reportAgentFailure("agent-request", error); throw error; }
      };
      const deploymentTransport = new AuthenticatedAgentDeploymentTransport({ ...transportOptions, fetch: diagnosticFetch });
      const dispatchNetworkAttachment = deploymentTransport.dispatchComposeNetworkAttachment.bind(deploymentTransport);
      deploymentTransport.dispatchComposeNetworkAttachment = async (prepared, authority, context) => {
        try { return await dispatchNetworkAttachment(prepared, authority, context); }
        catch (error) { reportAgentFailure("network-transport", error); throw error; }
      };
      resources = new AuthenticatedAgentComposeResourceInspectionTransport({ ...transportOptions, fetch: diagnosticFetch });
      const access = { owner, agentId, inspector: resources, clock: { now: Date.now }, maxAgeMs: 30_000, capabilities: caps, deadlineMs: 30_000 };
      const rawBackupPlanStore = new InMemoryComposeVolumeBackupPlanStore({ ledger: memory.completion, appendAudit: value => { appAudit!.appendSynchronous(value); }, clock: Date.now });
      const backupPlanStore = { available: () => true, save: async (input: Parameters<typeof rawBackupPlanStore.save>[0]) => rawBackupPlanStore.save(input) };
      const backupProfile = { owner, agentId, projectId, profileId: "p3-ci", destinationId: "ci-artifact", maxBytes: 1_048_576, maxEntries: 100,
        maxDurationMs: 15_000, planTtlMs: 60_000 };
      const cleanupStore = new InMemoryComposeResourceCleanupStore({ ledger: memory.completion, clock: Date.now,
        commitAudit: (value: AuditEventInput, publish: () => void) => { appAudit!.appendAtomically(value, publish); } });
      api = await buildApiApp({ env: { NODE_ENV: "test", DEPLOYLITE_SECRET_KEY: randomBytes(32).toString("hex") }, corsOrigin: false, imagePolicy: policy,
        authConfig: { cookieName: "p3_session", cookieSecure: false }, auth: { users: new InMemoryAuthUserRepository([user]), sessions, audit: appAudit },
        state: { projects, composeRevisionSaves: revisions, envSecretValues: secrets, envSecretCipher: cipher, controlGrants: grants,
          controlDeletes: control, controlRedeploy: control, controlRollback: control, executionCompletion: memory.completion },
        composeResourceInspection: new Map([[projectId, access]]),
        composeNetworkAttachmentExecutions: new Map([[projectId, { controls: projectControls, transport: deploymentTransport, commandTtlMs: 30_000 }]]),
        composeVolumeAttachmentExecutions: new Map([[projectId, { controls: projectControls, transport: deploymentTransport, commandTtlMs: 30_000 }]]),
        composeVolumeBackupPlans: new Map([[projectId, { profiles: new Map([["ci-artifact", backupProfile]]), store: backupPlanStore }]]),
        composeVolumeBackupExecutions: new Map([[projectId, { controls: projectControls, transport: deploymentTransport }]]),
        composeResourceCleanupPlans: new Map([[projectId, { store: cleanupStore, confirmationTtlMs: 60_000 }]]),
        composeResourceCleanupExecutions: new Map([[projectId, { transport: deploymentTransport, confirmationTtlMs: 60_000 }]]) });
      apps.push(api);
      const headers = (key: string, confirmation?: string, controlIdempotencyKey = false) => ({ cookie: `p3_session=${session}`, [controlIdempotencyKey ? "x-control-idempotency-key" : "idempotency-key"]: key, ...(confirmation ? { "x-control-confirmation-id": confirmation } : {}) });
      const post = async (path: string, body: unknown, key: string) => api!.inject({ method: "POST", url: `/api/v1/projects/${projectId}/compose${path ? `/${path}` : ""}`, headers: headers(key, undefined, !path), payload: body as Record<string, unknown> });
      const inspect = async (document: string, kind: ComposeResourceKind, key: string) => {
        const preview = createComposePreview(document, projectId, policy), response = await post("resources/inspect", { document, kind, key, expectedConfigDigest: preview.configDigest }, `inspect-${kind}-${key}-${randomUUID()}`);
        assert.equal(response.statusCode, 200, response.body); return response.json().data.inspection as { stateDigest: string; physicalIdentity: string; containers: Array<Record<string, unknown>> };
      };

      const priorSaved = await post("", { document: priorDocument, composeId: null, expectedRevisionId: null, expectedPreviewDigest: priorPreview.configDigest }, `revision-prior-${randomUUID()}`);
      assert.equal(priorSaved.statusCode, 201, priorSaved.body); const priorRevision = priorSaved.json().data.revision;
      const nextSaved = await post("", { document: nextDocument, composeId: priorRevision.composeId, expectedRevisionId: priorRevision.id, expectedPreviewDigest: nextPreview.configDigest }, `revision-next-${randomUUID()}`);
      assert.equal(nextSaved.statusCode, 201, nextSaved.body); const nextRevision = nextSaved.json().data.revision;
      log("C3 owned network and volume identities", "PASS", { backendId, extraId, volumeCreatedAt: volumeInfo.CreatedAt });
      const serviceName = `p3c8-${runId}-service`, environmentDigest = sha256("{}");
      const serviceId = await docker(["run", "--detach", "--name", serviceName, "--cpus=0.5", "--memory=67108864", "--pids-limit=64", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
        "--restart", "no", "--network", backend.runtimeName, "--network-alias", "app", "--label", `com.deploylite.owner=${owner}`, "--label", `com.deploylite.project=${projectId}`,
        "--label", "com.deploylite.compose.managed=v1", "--label", "com.deploylite.compose.service=app", "--label", `com.deploylite.compose.revision=${priorRevision.id}`,
        "--label", `com.deploylite.compose.config-digest=${priorPreview.configDigest}`, "--label", `com.deploylite.compose.environment-digest=${environmentDigest}`, manifest.image]);
      const service = { id: serviceId, kind: "container" as const, name: serviceName, created: true }; register(service);
      let healthy = false; for (let attempt = 0; attempt < 30; attempt++) { if (await docker(["container", "inspect", "--format", COMPOSE_REPLACEMENT_HEALTH_FORMAT, serviceId]) === "healthy") { healthy = true; break; } await new Promise(resolveDelay => setTimeout(resolveDelay, 250)); }
      assert(healthy, "synthetic seed service did not become healthy"); await docker(["container", "stop", "--time", "5", serviceId]);
      const volumeBefore = await inspect(priorDocument, "volume", "data"); assert.equal(volumeBefore.containers[0]?.attached, false);
      const attachState = await inspect(attachedDocument, "network", "extra");
      const attach = await post("attachments/apply", { document: attachedDocument, kind: "network", key: "extra", service: "app", action: "attach",
        expectedConfigDigest: createComposePreview(attachedDocument, projectId, policy).configDigest, expectedStateDigest: attachState.stateDigest, expectedContainerId: serviceId }, "network-attach-once");
      assert.equal(attach.statusCode, 200, attach.body); log("C4 network attach", "PASS", attach.json().data.attachment);
      const attachedState = await inspect(priorDocument, "network", "extra"); assert.equal(attachedState.containers[0]?.attached, true);
      const detach = await post("attachments/apply", { document: priorDocument, kind: "network", key: "extra", service: "app", action: "detach",
        expectedConfigDigest: priorPreview.configDigest, expectedStateDigest: attachedState.stateDigest, expectedContainerId: serviceId }, "network-detach-once");
      assert.equal(detach.statusCode, 200, detach.body); log("C4 network detach", "PASS", detach.json().data.attachment);
      const detached = await inspect(priorDocument, "network", "extra"); assert.equal(detached.containers[0]?.attached, false);
      await docker(["container", "start", serviceId]);
      let healthyAfterRestart = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const health = await docker(["container", "inspect", "--format", COMPOSE_REPLACEMENT_HEALTH_FORMAT, serviceId]);
        if (health === "healthy") { healthyAfterRestart = true; break; }
        await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
      }
      const healthcheck = await docker(["container", "inspect", "--format", COMPOSE_REPLACEMENT_HEALTHCHECK_FORMAT, serviceId]);
      const writableLayerChanges = await docker(["container", "diff", serviceId]);
      const changedPaths = writableLayerChanges.split(/\r?\n/).filter(Boolean).slice(0, 12).map(path => path.slice(0, 128));
      dockerFailureDiagnostics.push(`volume-preflight: restartedHealthy=${healthyAfterRestart}; healthcheck=${healthcheck}; writableLayerChangeCount=${writableLayerChanges ? writableLayerChanges.split(/\r?\n/).length : 0}; changedPaths=${JSON.stringify(changedPaths)}`);
      assert(healthyAfterRestart, "synthetic seed service did not become healthy after restart");
      assert.equal(healthcheck, "yes|healthy", "synthetic seed service did not retain its healthcheck");
      assert.equal(writableLayerChanges, "", "synthetic seed service writable layer is not clean");
      const volumeAttachState = await inspect(priorDocument, "volume", "data");
      assert.equal(volumeAttachState.containers[0]?.running, true); assert.equal(volumeAttachState.containers[0]?.attached, false);
      const replace = await post("volumes/attachment/apply", { priorRevisionId: priorRevision.id, revisionId: nextRevision.id, key: "data", service: "app", attachmentAction: "attach",
        expectedStateDigest: volumeAttachState.stateDigest, expectedContainerId: serviceId }, "volume-replace-once");
      const volumeCommand = [...commands().values()].find(value => value.idempotencyKey === "volume-replace-once");
      if (candidateObservation && volumeCommand && observedAgentVolumeCommand) {
        const commandPreview = createComposePreview(observedAgentVolumeCommand.canonicalDocument, observedAgentVolumeCommand.projectId, policy);
        const commandService = commandPreview.services.find(value => value.name === observedAgentVolumeCommand!.service);
        const commandNetworkName = commandService && commandPreview.networks.find(value => value.key === commandService.networks[0])?.runtimeName;
        const expectedCandidateName = `dl-${createHash("sha256").update(observedAgentVolumeCommand.commandId).digest("hex").slice(0, 32)}-vol-candidate`;
        dockerFailureDiagnostics.push(`volume-candidate-checks: ${JSON.stringify({ idMatches: candidateObservation.id === createdCandidateId,
          nameMatches: typeof candidateObservation.name === "string" && candidateObservation.name.replace(/^\//, "") === expectedCandidateName,
          ownerMatches: candidateObservation.owner === owner, projectMatchesAgent: candidateObservation.projectId === observedAgentVolumeCommand.projectId,
          projectMatchesFixture: observedAgentVolumeCommand.projectId === projectId,
          serviceMatchesAgent: candidateObservation.service === observedAgentVolumeCommand.service,
          commandMatchesAgent: candidateObservation.commandId === observedAgentVolumeCommand.commandId,
          commandMatchesControl: observedAgentVolumeCommand.commandId === volumeCommand.id,
          revisionMatchesAgent: candidateObservation.revisionId === observedAgentVolumeCommand.revisionId,
          revisionMatchesFixture: observedAgentVolumeCommand.revisionId === nextRevision.id,
          configDigestMatchesAgent: candidateObservation.configDigest === observedAgentVolumeCommand.configDigest,
          configDigestMatchesFixture: observedAgentVolumeCommand.configDigest === nextPreview.configDigest,
          environmentDigestMatchesAgent: candidateObservation.environmentDigest === observedAgentVolumeCommand.secretDigest,
          environmentDigestMatchesFixture: observedAgentVolumeCommand.secretDigest === sha256("{}"),
          imageMatchesAgent: Boolean(commandService && candidateObservation.image === commandService.image), running: candidateObservation.running === true,
          networksMatchAgent: Boolean(commandNetworkName && JSON.stringify(candidateObservation.networks) === JSON.stringify([commandNetworkName])),
          mountsMatchAgent: Boolean(commandService && JSON.stringify(candidateObservation.mounts) === JSON.stringify(commandService.volumes.map(mount => ({
            source: observedAgentVolumeCommand!.runtimeName, target: mount.target, readOnly: mount.readOnly })))) })}`);
      }
      assert.equal(replace.statusCode, 200, replace.body); const replacementReceipt = replace.json().data.attachment;
      const replacementId = replacementReceipt.replacementContainerId as string;
      assert(/^[a-f0-9]{64}$/.test(replacementId)); register({ id: replacementId, kind: "container", name: "volume-replacement-candidate", created: true });
      let replacementProjection: Record<string, unknown>;
      try {
        const afterReplacement = await agentInspector.inspect({ preview: nextPreview, kind: "volume", key: "data" }, new AbortController().signal);
        const observedCandidate = afterReplacement.containers.find(value => value.containerId === replacementId);
        const observedPrior = afterReplacement.containers.find(value => value.containerId === serviceId);
        const candidateMounts = observedCandidate?.mounts as Array<{ target?: string; readOnly?: boolean }> | undefined;
        replacementProjection = { targetCount: afterReplacement.containers.length, candidateObserved: Boolean(observedCandidate),
          candidateRunning: observedCandidate?.running === true, candidateAttached: observedCandidate?.attached === true,
          candidateMountTargetMatches: candidateMounts?.some(value => value.target === "/data" && value.readOnly === false) === true,
          priorObserved: Boolean(observedPrior), priorRunning: observedPrior?.running === true };
      } catch { replacementProjection = { inspectionFailed: true }; }
      dockerFailureDiagnostics.push(`volume-replacement-postcondition: ${JSON.stringify({ status: replacementReceipt.status,
        health: replacementReceipt.health, rollback: replacementReceipt.rollback, reason: replacementReceipt.reason, ...replacementProjection,
        agentObservations: replacementAgentObservations, driverEvents: replacementDriverEvents,
        replacementExecutionElapsedMs: replacementExecutionStartedAt === undefined ? null : Date.now() - replacementExecutionStartedAt })}`);
      assert.equal(replacementReceipt.status, "replaced", JSON.stringify({ status: replacementReceipt.status, health: replacementReceipt.health,
        rollback: replacementReceipt.rollback, reason: replacementReceipt.reason, ...replacementProjection }));
      assert.equal(replacementReceipt.health, "passed");
      const persisted = await docker(["container", "exec", replacementId, "/bin/sh", "-c", "test \"$(cat /data/p3-marker.txt)\" = deploylite-p3-owned-volume-marker-v1"]);
      assert.equal(persisted, ""); log("C4 bounded volume replacement", "PASS", replacementReceipt);
      await docker(["container", "stop", "--time", "5", replacementId]);
      const backupObservation = await agentInspector.inspect({ preview: nextPreview, kind: "volume", key: "data" }, new AbortController().signal);
      const stoppedVolumeConsumer = backupObservation.containers.find(value => value.containerId === replacementId);
      dockerFailureDiagnostics.push(`volume-stopped-observation: ${JSON.stringify({ consumerCount: backupObservation.containers.length,
        stoppedConsumerFound: Boolean(stoppedVolumeConsumer), attached: stoppedVolumeConsumer?.attached ?? false,
        running: stoppedVolumeConsumer?.running ?? null, projectedMountCount: Array.isArray(stoppedVolumeConsumer?.mounts) ? stoppedVolumeConsumer.mounts.length : null,
        dockerMountProjection: stoppedVolumeMountProjection ?? null })}`);
      assert(stoppedVolumeConsumer?.attached); assert.equal(stoppedVolumeConsumer.running, false);
      assert.equal(backupObservation.containers.filter(value => value.attached).length, 1);
      backupSourceContainerId = replacementId;
      await docker(["container", "cp", `${replacementId}:/data/.`, backupSourceRoot]);
      const stagedSourceFiles = await readdir(backupSourceRoot);
      assert.deepEqual(stagedSourceFiles, ["p3-marker.txt"]);
      assert.equal(await readFile(join(backupSourceRoot, "p3-marker.txt"), "utf8"), secretFreeMarker);
      log("C6 exact stopped-volume source snapshot", "PASS", { stoppedConsumer: true, oneAttachedConsumer: true, markerVerified: true, stagedEntryCount: stagedSourceFiles.length });
      const backupPreview = await post("volumes/backup/preview", { document: nextDocument, key: "data", expectedConfigDigest: nextPreview.configDigest,
        expectedStateDigest: backupObservation.stateDigest, destinationId: "ci-artifact" }, "backup-plan-once");
      assert.equal(backupPreview.statusCode, 200, backupPreview.body);
      const plan = backupPreview.json().data.backupPlan.plan;
      const backup = await post("volumes/backup/execute", { document: nextDocument, key: "data", expectedConfigDigest: nextPreview.configDigest,
        expectedStateDigest: backupObservation.stateDigest, destinationId: "ci-artifact", plan }, "backup-execute-once");
      assert.equal(backup.statusCode, 200, backup.body); const backupReceipt = backup.json().data.backup;
      const archive = await readFile(join(archiveDestination, backupReceipt.archiveId, "archive.tar"));
      const backupManifest = await readFile(join(archiveDestination, backupReceipt.archiveId, "manifest.json"));
      assert.equal(sha256(archive), backupReceipt.archiveSha256); assert.equal(sha256(backupManifest), backupReceipt.manifestSha256);
      assert(archive.includes(Buffer.from(secretFreeMarker))); log("C6 stopped volume backup and integrity", "PASS", backupReceipt);
      await docker(["container", "rm", "--force", replacementId]); service.created = false; const currentService = evidence.resources.find(value => value.id === replacementId); if (currentService) currentService.created = false;
      await docker(["container", "rm", "--force", serviceId]);

      const clean = async (kind: ComposeResourceKind, key: string, document: string) => {
        const preview = createComposePreview(document, projectId, policy), state = await inspect(document, kind, key);
        const body = { document, kind, key, expectedConfigDigest: preview.configDigest, expectedStateDigest: state.stateDigest };
        const keyId = `cleanup-${kind}-${key}`;
        const pending = await api!.inject({ method: "POST", url: `/api/v1/projects/${projectId}/compose/resources/cleanup/preview`, headers: headers(keyId), payload: body });
        assert.equal(pending.statusCode, 200, pending.body); const confirmationId = pending.json().data.cleanup.confirmationId as string;
        const confirmed = await api!.inject({ method: "POST", url: `/api/v1/projects/${projectId}/compose/resources/cleanup/confirm`, headers: headers(keyId, confirmationId), payload: body });
        assert.equal(confirmed.statusCode, 200, confirmed.body); assert.equal(confirmed.json().data.cleanup.status, "completed");
        const receipt = confirmed.json().data.cleanup.execution; assert.equal(receipt.terminalStatus, "removed");
        const retry = await api!.inject({ method: "POST", url: `/api/v1/projects/${projectId}/compose/resources/cleanup/confirm`, headers: headers(keyId, confirmationId), payload: body });
        assert.equal(retry.statusCode, 200, retry.body); assert.equal(retry.json().data.cleanup.idempotent, true);
        const target = resourceByName.get(receipt.runtimeName as string); assert(target && target.kind === kind);
        target.created = false;
        const absent = await docker([kind === "volume" ? "volume" : "network", "ls", "--filter", `name=^${target.name}$`, "--format", "{{.Name}}"]);
        assert.equal(absent, ""); evidence.cleanup.push({ kind, id: target.id, verifiedAbsent: true });
        log(`C7 confirmed ${kind} cleanup`, "PASS", receipt);
      };
      await clean("volume", "data", nextDocument); await clean("network", "extra", nextDocument); await clean("network", "backend", nextDocument);
      for (const resource of evidence.resources.filter(value => value.kind === "network" || value.kind === "volume")) {
        const result = resource.kind === "network" ? await docker(["network", "ls", "--filter", `name=^${resource.name}$`, "--format", "{{.Name}}"])
          : await docker(["volume", "ls", "--filter", `name=^${resource.name}$`, "--format", "{{.Name}}"]);
        assert.equal(result, "");
      }
      log("C5 actual observation", "PASS", { owner, projectId, verifiedObservationCount: evidence.operations.filter(value => value.operation.startsWith("C5") || value.operation.startsWith("C3")).length });
      expect(appAudit!.inputs.some(value => value.action === "compose.resource.cleanup.completed")).toBe(true);
      expect(JSON.stringify(evidence)).not.toContain(trustKey); evidence.status = "PASS";
      await writeFile(artifactPath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    } catch (error) {
      evidence.status = "FAILED"; log("harness", "FAILED", { reason: error instanceof Error ? error.message.replace(/[^A-Za-z0-9 _:-]/g, "").slice(0, 160) : "unknown", dockerFailures: dockerFailureDiagnostics });
      await writeFile(artifactPath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "wx" }).catch(() => undefined);
      throw error;
    } finally {
      if (api) await api.close().catch(() => undefined);
      if (server) await server.close().catch(() => undefined);
      if (evidence.status !== "PASS") {
        for (const resource of evidence.resources.filter(value => value.kind === "container" && value.created).reverse()) {
          try { await docker(["container", "rm", "--force", resource.id]); resource.created = false; } catch { evidence.status = "CLEANUP_BLOCKED"; }
        }
        for (const resource of evidence.resources.filter(value => (value.kind === "volume" || value.kind === "network") && value.created).reverse()) {
          try {
            const preview = createComposePreview(nextDocument, projectId, policy), observation = await physicalInspector.inspect({ preview, kind: resource.kind as ComposeResourceKind, key: resource.key! }, new AbortController().signal);
            assert.equal(observation.owner, owner); assert.equal(observation.projectId, projectId); assert.equal(observation.runtimeName, resource.name); assert.equal(observation.containers.some(value => value.attached), false);
            await docker([resource.kind === "volume" ? "volume" : "network", "rm", resource.name]); resource.created = false;
          } catch { evidence.status = "CLEANUP_BLOCKED"; }
        }
        await writeFile(artifactPath, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "w" }).catch(() => undefined);
      }
      if (backupSourceRoot) await rm(backupSourceRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(archiveDestination, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 180_000);
});
