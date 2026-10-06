import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Deployment, DeploymentSnapshotV1 } from "@deploylite/contracts";
import type { AgentReplayStore } from "@deploylite/agent";
import type { DockerCliRunner } from "../../agent/src/infrastructure/docker/docker-cli-image-transport.js";
import type { DockerProcessExit } from "../../agent/src/infrastructure/docker/docker-process-runner.js";
import type { buildApiApp, createInMemoryExecutionRepositories } from "./app.js";

// Test-only physical boundary. Importing this file or running ordinary tests never starts Docker.
const policy = { maxOutageMs: 30_000, maxRecoveryMs: 60_000 };
const sourcePaths = [
  "apps/api/src/app.ts", "apps/api/src/agent-transport.ts", "apps/agent/src/index.ts",
  "apps/agent/src/agent-transport.ts", "apps/agent/src/deployment-dispatcher.ts",
  "apps/agent/src/infrastructure/docker/docker-process-runner.ts",
  "apps/agent/src/infrastructure/docker/docker-cli-image-transport.ts",
  "apps/agent/src/infrastructure/docker/docker-cli-argv.ts", "packages/domain/src/index.ts",
  "packages/domain/src/control-plane.ts", "packages/domain/src/deployment-contract/docker-image-executor.ts",
  "packages/domain/src/deployment-contract/deployment-authority.ts",
  "packages/domain/src/deployment-contract/execution-completion.ts",
  "packages/domain/src/deployment-contract/execution-memory-state.ts", "packages/contracts/src/index.ts",
  "packages/contracts/src/deployment-contract/agent-transport.ts",
  "packages/contracts/src/deployment-contract/snapshot-plan.ts", "packages/config/src/index.ts"
] as const;
const operations = ["inspect", "network-create", "container-run", "container-rename", "container-stop",
  "container-start", "container-remove", "network-remove", "loopback-probe", "port-check",
  "fault-after-stop", "cancel-after-stop", "lose-terminal-reply"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const objectId = /^[0-9a-f]{64}$/;
const imageId = /^sha256:[0-9a-f]{64}$/;
const digestImage = /^127\.0\.0\.1:49172\/deploylite-p2\/[a-z0-9-]+@sha256:[0-9a-f]{64}$/;
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
type Manifest = {
  schemaVersion: 1; authorization: "P2_PHYSICAL_DOCKER_APPROVED"; grantId: string; runId: string;
  expiresAt: string; dockerHost: string; engineId: string; image: string; platform: "linux/amd64" | "linux/arm64";
  runtimeHost: string; activePort: 49170; temporaryPort: 49171; containerPort: 8080;
  engineScope: "ephemeral-github-actions-job"; ciJob: { repository: string; runId: string; runAttempt: string; job: string };
  dockerConfigDirectory: string; maxContainers: 3; containerCpu: 0.5; containerMemoryBytes: 67108864; healthPath: string;
  credentialsFile: string; receiptDirectory: string; harnessSha256: string; operations: string[]; sourceHashes: Record<string, string>;
  expiryClosures?: { recoveryMaxMs: number; cleanupMaxMs: number };
};
type Credentials = { trustKey: string; adminPassword: string };
type Event = Record<string, unknown> & { kind: string; monoMs: number; wallTime: string };
type Intent = { deploymentId: string; candidateId: string; candidate: string; active: string };
type Container = { id: string; name: string; imageId: string; owner: string; projectId: string;
  deploymentId: string; candidateId: string; effectiveImage: string; running: boolean; health: string | null;
  hostBindings: Record<string, { HostIp: string; HostPort: string }[]>;
  portBindings: Record<string, { HostIp: string; HostPort: string }[]>; networkMode: string;
  networks: Record<string, { networkId: string; endpointId: string }> };
type Fault = "none" | "throw-after-stop" | "cancel-after-stop" | "lost-stop-reply" | "lost-replacement-reply";
type Tamper = "none" | "unsigned" | "signed-other-initial";
type CleanupClosure = { kind: "cleanup"; deadlineMonoMs: number };
function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), "object required");
  return value as Record<string, unknown>;
}
function requireText(value: unknown, name: string): string {
  assert(typeof value === "string" && value.length > 0, `${name} required`);
  return value;
}
function validateManifest(raw: unknown, env: NodeJS.ProcessEnv, now = Date.now()): Manifest {
  assert.equal(env.DEPLOYLITE_DOCKER_INTEGRATION, "1", "explicit integration flag required");
  assert.equal(env.DEPLOYLITE_DOCKER_RUNTIME_GRANT, "P2_PHYSICAL_DOCKER_APPROVED", "explicit runtime grant required");
  const value = record(raw);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.authorization, "P2_PHYSICAL_DOCKER_APPROVED");
  assert(uuid.test(requireText(value.runId, "runId")), "fresh UUID runId required");
  assert(uuid.test(requireText(value.runtimeHost, "runtimeHost")), "configured fixture runtimeHost UUID required");
  assert.equal(value.grantId, env.DEPLOYLITE_DOCKER_GRANT_ID);
  assert(requireText(value.grantId, "grantId").length >= 16);
  const expiry = Date.parse(requireText(value.expiresAt, "expiresAt"));
  assert(expiry > now && expiry - now <= 2 * 60 * 60 * 1000, "grant expiry outside two-hour window");
  const host = requireText(value.dockerHost, "dockerHost");
  assert(/^unix:\/\/\/[a-zA-Z0-9/_.-]+$/.test(host), "explicit local disposable-host socket required");
  assert.equal(env.DOCKER_HOST, host);
  assert(!env.DOCKER_CONTEXT && !env.DOCKER_TLS_VERIFY && !env.DOCKER_CERT_PATH, "ambient Docker context/TLS forbidden");
  assert(requireText(value.engineId, "engineId").length >= 16, "approved engine identity required");
  assert.equal(value.engineScope, "ephemeral-github-actions-job", "owned ephemeral CI engine required");
  assert.equal(env.GITHUB_ACTIONS, "true", "owned GitHub Actions job required");
  assert.equal(env.RUNNER_ENVIRONMENT, "github-hosted", "owned hosted GitHub Actions runner required");
  const job = record(value.ciJob);
  for (const [field, variable] of Object.entries({ repository: "GITHUB_REPOSITORY", runId: "GITHUB_RUN_ID",
    runAttempt: "GITHUB_RUN_ATTEMPT", job: "GITHUB_JOB" })) {
    assert.equal(requireText(job[field], `ciJob.${field}`), env[variable], `CI ${field} identity mismatch`);
  }
  assert(isAbsolute(requireText(value.dockerConfigDirectory, "private empty Docker config directory")));
  assert.equal(value.dockerConfigDirectory, env.DOCKER_CONFIG, "explicit owned Docker config required");
  assert(digestImage.test(requireText(value.image, "image")), "immutable supplied fixture digest required");
  assert(value.platform === "linux/amd64" || value.platform === "linux/arm64", "explicit supported platform required");
  for (const [field, expected] of Object.entries({ activePort: 49170, temporaryPort: 49171, containerPort: 8080,
    maxContainers: 3, containerCpu: 0.5, containerMemoryBytes: 67108864 })) assert.equal(value[field], expected, field);
  assert(/^\/(healthz|readyz|health)$/.test(requireText(value.healthPath, "healthPath")), "selected probe path required");
  for (const field of ["credentialsFile", "receiptDirectory"]) assert(isAbsolute(requireText(value[field], field)));
  const scopedOperations = value.operations;
  assert(Array.isArray(scopedOperations) && scopedOperations.length === operations.length &&
    operations.every((op) => scopedOperations.includes(op)) &&
    scopedOperations.every((op: unknown) => typeof op === "string" && operations.includes(op as typeof operations[number])),
  "exact operation scope required");
  assert(objectId.test(requireText(value.harnessSha256, "reviewed harness SHA256")));
  const hashes = record(value.sourceHashes);
  assert.deepEqual(Object.keys(hashes).sort(), [...sourcePaths].sort(), "exact current-source hash scope required");
  assert(Object.values(hashes).every((hash) => typeof hash === "string" && objectId.test(hash)), "source SHA256 required");
  assert(!env.DATABASE_URL && env.DEPLOYLITE_DB_INTEGRATION !== "1" && env.DEPLOYLITE_API_DB_INTEGRATION !== "1",
    "physical Docker slice does not authorize PostgreSQL");
  if (value.expiryClosures !== undefined) {
    const closure = record(value.expiryClosures);
    assert(typeof closure.cleanupMaxMs === "number" && closure.cleanupMaxMs > 0 && closure.cleanupMaxMs <= 30_000, "explicit bounded owned cleanup required");
    assert(typeof closure.recoveryMaxMs === "number" && closure.recoveryMaxMs > 0 && closure.recoveryMaxMs <= policy.maxRecoveryMs, "bounded recovery declaration required");
    // This declaration does not enable post-expiry recovery: final current-authority/physical-ID binding is still pending.
  }
  return structuredClone(value) as Manifest;
}
async function privateJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  assert(info.isFile() && (info.mode & 0o077) === 0 && info.uid === process.getuid?.(), "private owned input file required");
  return JSON.parse(await readFile(path, "utf8"));
}
type GrantTestBoundary = {
  readPrivate?: (path: string) => Promise<unknown>; read?: (path: string) => Promise<Buffer>;
  stat?: (path: string) => Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean; mode: number; uid: number }>;
  list?: (path: string) => Promise<string[]>; makeDirectory?: (path: string, options: { mode: number }) => Promise<unknown>;
};
async function validatePrivateDockerConfig(directory: string, boundary: GrantTestBoundary = {}): Promise<void> {
  const info = await (boundary.stat ?? lstat)(directory);
  assert(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid?.() && (info.mode & 0o077) === 0,
    "private owned non-symlink Docker config directory required");
  assert.deepEqual(await (boundary.list ?? ((path: string) => readdir(path)))(directory), [], "empty Docker config directory required");
}
async function loadGrant(boundary: GrantTestBoundary = {}): Promise<{ manifest: Manifest; credentials: Credentials }> {
  const readPrivate = boundary.readPrivate ?? privateJson, read = boundary.read ?? ((path: string) => readFile(path));
  const stat = boundary.stat ?? ((path: string) => lstat(path));
  const makeDirectory = boundary.makeDirectory ?? ((path: string, options: { mode: number }) => mkdir(path, options));
  assert.equal(process.env.DEPLOYLITE_DOCKER_INTEGRATION, "1");
  assert.equal(process.env.DEPLOYLITE_DOCKER_RUNTIME_GRANT, "P2_PHYSICAL_DOCKER_APPROVED");
  requireText(process.env.DEPLOYLITE_DOCKER_GRANT_ID, "grant ID");
  const path = requireText(process.env.DEPLOYLITE_DOCKER_MANIFEST, "manifest file");
  assert(isAbsolute(path));
  const manifest = validateManifest(await readPrivate(path), process.env);
  await validatePrivateDockerConfig(manifest.dockerConfigDirectory, boundary); // No config contents or credential readers are accessed.
  assert.equal(createHash("sha256").update(await read(fileURLToPath(import.meta.url))).digest("hex"),
    manifest.harnessSha256, "reviewed harness changed");
  for (const relative of sourcePaths) assert.equal(createHash("sha256").update(await read(resolve(repoRoot, relative))).digest("hex"),
    manifest.sourceHashes[relative], `source changed: ${relative}; rebase after 3.1 handoff`);
  const raw = record(await readPrivate(manifest.credentialsFile));
  const credentials = { trustKey: requireText(raw.trustKey, "private fixture HMAC"), adminPassword: requireText(raw.adminPassword, "private fixture admin password") };
  assert(credentials.trustKey.length >= 32 && credentials.adminPassword.length >= 32);
  const parent = await stat(dirname(manifest.receiptDirectory));
  assert(parent.isDirectory() && (parent.mode & 0o077) === 0 && parent.uid === process.getuid?.(), "private owned receipt parent required");
  await makeDirectory(manifest.receiptDirectory, { mode: 0o700 }); // Exclusive fresh evidence directory also blocks grant reuse.
  return { manifest, credentials };
}
async function availablePort(port: number): Promise<void> {
  await new Promise<void>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => server.close((error) => error ? reject(error) : resolvePort()));
  });
}
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const missingObject = (error: unknown) => /no such (object|container|network)/i.test(String((error as { result?: DockerProcessExit }).result?.stderr ?? ""));

class PhysicalFixture {
  readonly owner: string;
  readonly projectId = randomUUID();
  readonly network: string;
  readonly events: Event[] = [];
  readonly intents = new Map<string, Intent>();
  readonly containers = new Map<string, { intent: Intent; name: string }>();
  readonly controller = new AbortController();
  readonly envelopes: Record<string, unknown>[] = [];
  readonly replies: Record<string, unknown>[] = [];
  readonly ledger = { schemaVersion: 1, status: "RUNNING", physicalDocker: true, postgres: false,
    deployedHttp: false, receiptReconciliation: "PENDING", resources: [] as Record<string, unknown>[] };
  runner!: DockerCliRunner;
  app!: Awaited<ReturnType<typeof buildApiApp>>;
  memory!: ReturnType<typeof createInMemoryExecutionRepositories>;
  cookie = "";
  configId = "";
  networkId = "";
  fault: Fault = "none";
  tamper: Tamper = "none";
  faultArmed = false;
  barrier?: { entered: () => void; wait: Promise<void> };
  allowedFormats = new Set<string>();
  private raw!: DockerCliRunner;
  private builders!: typeof import("../../agent/src/infrastructure/docker/docker-cli-argv.js");
  private probeRunning = false;
  private probeTask?: Promise<void>;
  private faultMono?: number;
  private cleanupDeadlineMonoMs?: number;
  private cleanupController?: AbortController;
  private cleanupTimer?: ReturnType<typeof setTimeout>;
  private receiptWrite: typeof writeFile = writeFile; // Neutral injected writer seam; unchanged default behavior before F7 RED.
  constructor(readonly manifest: Manifest, readonly credentials: Credentials, readonly caseId: string) {
    this.owner = `p2v-${manifest.runId}`;
    this.network = `p2v-${manifest.runId.slice(0, 8)}-${randomUUID()}`;
  }
  event(kind: string, data: Record<string, unknown> = {}): Event {
    const event = { kind, monoMs: performance.now(), wallTime: new Date().toISOString(), ...data };
    this.events.push(event);
    return event;
  }
  async persist(): Promise<void> {
    // Capture one existing cleanup authority before any await; a delayed read must never start a new publication after it expires.
    const deadline = this.cleanupDeadlineMonoMs, controller = this.cleanupController;
    const fence = () => {
      if (deadline === undefined) return; // Ordinary pre-cleanup evidence keeps its existing behavior.
      assert.equal(this.cleanupDeadlineMonoMs, deadline, "receipt cannot renew cleanup deadline");
      assert(controller && controller === this.cleanupController, "receipt must retain original cleanup controller");
      controller.signal.throwIfAborted();
      assert(performance.now() < deadline, "receipt publication outside owned cleanup deadline");
    };
    fence();
    const deployments = this.memory ? await this.memory.deployments.list() : null;
    fence();
    const path = resolve(this.manifest.receiptDirectory, `${this.caseId}.json`);
    const text = JSON.stringify({ ...this.ledger, grantId: this.manifest.grantId, owner: this.owner,
      projectId: this.projectId, runtimeHost: this.manifest.runtimeHost, network: this.network,
      image: this.manifest.image, platform: this.manifest.platform, policy,
      envelopes: this.envelopes, replies: this.replies, events: this.events,
      completionState: deployments ? { deployments: deployments.filter((value) => value.projectId === this.projectId),
        commands: [...this.memory.completion.commands.values()] } : null }, null, 2);
    assert(!text.includes(this.credentials.trustKey) && !text.includes(this.credentials.adminPassword), "credential receipt leak");
    fence();
    await this.receiptWrite(path, text + "\n", { mode: 0o600, ...(deadline === undefined ? {} : { signal: controller!.signal }) });
    fence(); // Cancellation of a write already submitted to the OS never proves that no bytes were published.
  }
  private async withinCleanup<T>(closure: CleanupClosure, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    assert.equal(closure.deadlineMonoMs, this.cleanupDeadlineMonoMs, "cleanup cannot renew its original deadline");
    const remaining = closure.deadlineMonoMs - performance.now();
    assert(remaining > 0, "owned cleanup deadline exhausted before operation");
    if (Date.now() >= Date.parse(this.manifest.expiresAt)) assert(this.manifest.expiryClosures, "explicit post-expiry cleanup permission required");
    this.cleanupController ??= new AbortController();
    const signal = this.cleanupController.signal; signal.throwIfAborted();
    if (!this.cleanupTimer) {
      this.cleanupTimer = setTimeout(() => this.cleanupController!.abort(new Error("owned cleanup deadline exhausted")), remaining);
      this.cleanupTimer.unref?.();
    }
    let abort!: () => void;
    const exhausted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
    });
    try {
      // The CLI receives the same deadline signal; the race also settles a misbehaving injected runner/await as unknown.
      const value = await Promise.race([operation(signal), exhausted]);
      signal.throwIfAborted(); assert(performance.now() < closure.deadlineMonoMs, "late cleanup result cannot verify closure");
      return value;
    } finally { signal.removeEventListener("abort", abort); }
  }
  async invoke(argv: readonly string[], signal = new AbortController().signal, closure?: CleanupClosure): Promise<DockerProcessExit> {
    assert.equal(argv[0], "docker");
    const now = performance.now(), expiry = Date.parse(this.manifest.expiresAt);
    assert(Number.isFinite(expiry), "valid grant expiry required");
    if (closure) {
      assert.equal(closure.kind, "cleanup", "post-expiry recovery remains unbound and forbidden");
      const budget = this.manifest.expiryClosures?.cleanupMaxMs ?? 30_000;
      assert(Number.isFinite(closure.deadlineMonoMs) && closure.deadlineMonoMs > now && closure.deadlineMonoMs - now <= budget, "owned cleanup deadline expired or widened");
      if (this.cleanupDeadlineMonoMs === undefined) this.cleanupDeadlineMonoMs = closure.deadlineMonoMs;
      assert.equal(closure.deadlineMonoMs, this.cleanupDeadlineMonoMs, "owned cleanup deadline cannot renew");
      if (Date.now() >= expiry) assert(this.manifest.expiryClosures, "explicit post-expiry cleanup permission required");
      const target = argv.at(-1)!;
      if (argv[1] === "network") {
        assert(["inspect", "rm"].includes(argv[2]!) && objectId.test(this.networkId) && target === this.networkId, "cleanup network outside owned ledger");
      } else if (argv[1] === "rm") {
        assert(objectId.test(target) && this.containers.has(target), "cleanup container outside exact owned ledger");
      } else {
        assert(argv[1] === "inspect" || (argv[1] === "container" && argv[2] === "inspect"), "cleanup permits only owned inspection/removal");
        this.intentFor(target);
      }
    } else {
      assert(Date.now() < expiry, "fresh Docker effect after grant expiry forbidden; post-expiry recovery binding pending");
    }
    const event = this.event("docker-command", { argv: [...argv], physicalRan: true, phase: "started" });
    try {
      const command = (deadlineSignal?: AbortSignal) => this.raw.run([argv[0]!, "--config", this.manifest.dockerConfigDirectory,
        "--host", this.manifest.dockerHost, ...argv.slice(1)], deadlineSignal ? AbortSignal.any([signal, deadlineSignal]) : signal);
      const result = closure ? await this.withinCleanup(closure, command) : await command();
      Object.assign(event, { phase: "completed", completedMonoMs: performance.now(), exitCode: result.exitCode,
        signal: result.signal, stdout: result.stdout, stderr: result.stderr });
      return result;
    } catch (error) {
      Object.assign(event, { phase: "rejected", completedMonoMs: performance.now(), errorKind: (error as Error).name,
        ...(closure ? { daemonOutcome: "unknown" } : {}) });
      throw error;
    }
  }
  private intentFor(target: string): Intent {
    const intent = [...this.intents.values()].find((entry) => entry.candidate === target || entry.active === target) ?? this.containers.get(target)?.intent;
    assert(intent, "target outside exact signed-execution manifest");
    return intent;
  }
  private async inspected(target: string, closure?: CleanupClosure): Promise<Container> {
    const intent = this.intentFor(target);
    const candidate = { projectId: this.projectId, deploymentId: intent.deploymentId, candidateId: intent.candidateId,
      effectiveImage: this.manifest.image, runtimePort: this.manifest.containerPort, networkName: this.network };
    const argv = this.builders.buildDockerActiveIdentityInspectArgv({ candidate, containerName: target,
      projectId: this.projectId, owner: this.owner, hostPort: this.manifest.activePort,
      containerPort: this.manifest.containerPort, allowedNetworks: [this.network], networkName: this.network });
    const value = JSON.parse((await this.invoke(argv, undefined, closure)).stdout) as Container;
    assert(objectId.test(value.id) && imageId.test(value.imageId));
    assert.equal(value.owner, this.owner); assert.equal(value.projectId, this.projectId);
    assert.equal(value.deploymentId, intent.deploymentId); assert.equal(value.candidateId, intent.candidateId);
    assert([`/${intent.candidate}`, `/${intent.active}`].includes(value.name), "unexpected physical container name");
    assert.equal(value.effectiveImage, this.manifest.image); assert.equal(value.imageId, this.configId);
    assert.equal(value.networkMode, this.network); assert.deepEqual(Object.keys(value.networks), [this.network]);
    assert.equal(value.networks[this.network]?.networkId, this.networkId);
    return value;
  }
  async observe(deployment: Deployment, healthy = true): Promise<Container> {
    const value = await this.inspected(`deploylite-active-${deployment.id}`);
    assert.equal(value.id, deployment.executionReceipt?.containerId);
    assert.equal(value.name, `/${deployment.executionReceipt?.container}`);
    if (healthy) { assert.equal(value.running, true); assert.equal(value.health, "healthy"); }
    const expected = { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "49170" }] };
    assert.deepEqual(value.hostBindings, expected);
    if (healthy) assert.deepEqual(value.portBindings, expected);
    this.event("physical-observation", { deploymentId: deployment.id, observation: value });
    return value;
  }
  async setup(testBoundary: { runner?: DockerCliRunner; portCheck?: (port: number) => Promise<void>; config?: GrantTestBoundary } = {}): Promise<void> {
    await validatePrivateDockerConfig(this.manifest.dockerConfigDirectory, testBoundary.config); // Recheck before every process construction.
    const { DockerProcessRunner } = await import("../../agent/src/infrastructure/docker/docker-process-runner.js");
    this.builders = await import("../../agent/src/infrastructure/docker/docker-cli-argv.js");
    this.raw = testBoundary.runner ?? new DockerProcessRunner({ timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    const engineFormat = '{"id":{{json .ID}},"os":{{json .OSType}},"architecture":{{json .Architecture}},"cpu":{{json .NCPU}},"memory":{{json .MemTotal}}}';
    const engine = JSON.parse((await this.invoke(["docker", "info", "--format", engineFormat])).stdout);
    assert.equal(engine.id, this.manifest.engineId); assert.equal(engine.os, "linux");
    // The owned ephemeral job/engine is bound above; budgets apply to our containers, never shared daemon settings.
    this.event("owned-engine-observation", { engineId: engine.id, ciJob: this.manifest.ciJob,
      nativeCpu: engine.cpu, nativeMemoryBytes: engine.memory, containerCpu: this.manifest.containerCpu,
      containerMemoryBytes: this.manifest.containerMemoryBytes, maxContainers: this.manifest.maxContainers });
    const imageFormat = '{"id":{{json .Id}},"os":{{json .Os}},"arch":{{json .Architecture}},"repoDigests":{{json .RepoDigests}},"healthType":{{if .Config.Healthcheck}}{{if .Config.Healthcheck.Test}}{{json (index .Config.Healthcheck.Test 0)}}{{else}}null{{end}}{{else}}null{{end}},"healthInterval":{{if .Config.Healthcheck}}{{json .Config.Healthcheck.Interval}}{{else}}0{{end}}}';
    const image = JSON.parse((await this.invoke(["docker", "image", "inspect", "--format", imageFormat, this.manifest.image])).stdout);
    assert(imageId.test(image.id)); assert.equal(`${image.os}/${image.arch}`, this.manifest.platform);
    const architecture = engine.architecture === "x86_64" ? "amd64" : engine.architecture === "aarch64" ? "arm64" : engine.architecture;
    assert.equal(image.arch, architecture, "native approved fixture platform required");
    assert(Array.isArray(image.repoDigests) && image.repoDigests.includes(this.manifest.image), "preloaded exact digest required");
    assert(["CMD", "CMD-SHELL"].includes(image.healthType) && image.healthInterval > 0 && image.healthInterval <= 2_000_000_000,
      "fixture must already contain a frequent Docker HEALTHCHECK; no implicit override/build/pull");
    this.configId = image.id;
    const portCheck = testBoundary.portCheck ?? availablePort;
    await portCheck(this.manifest.activePort); await portCheck(this.manifest.temporaryPort);
    const networkFormat = '{"id":{{json .Id}},"name":{{json .Name}},"owner":{{json (index .Labels "com.deploylite.owner")}},"project":{{json (index .Labels "com.deploylite.project")}},"internal":{{json .Internal}},"containers":{{json .Containers}}}';
    this.allowedFormats.add(networkFormat);
    const created = await this.invoke(["docker", "network", "create", "--internal", "--label", `com.deploylite.owner=${this.owner}`,
      "--label", `com.deploylite.project=${this.projectId}`, this.network]);
    this.networkId = created.stdout.trim(); assert(objectId.test(this.networkId));
    this.ledger.resources.push({ kind: "network", id: this.networkId, name: this.network, owner: this.owner, project: this.projectId });
    await this.persist();
    const network = JSON.parse((await this.invoke(["docker", "network", "inspect", "--format", networkFormat, this.networkId])).stdout);
    assert.equal(network.internal, true); assert.equal(network.owner, this.owner); assert.equal(network.project, this.projectId);
    const sample = { candidateId: "dep_fixture:candidate:command", projectId: this.projectId, deploymentId: "dep_fixture",
      effectiveImage: this.manifest.image, runtimePort: 8080, networkName: this.network };
    for (const argv of [this.builders.buildDockerInspectArgv("fixture"), this.builders.buildDockerOwnershipInspectArgv("fixture"),
      this.builders.buildDockerRestoreInspectArgv("fixture"), this.builders.buildDockerStopOwnershipInspectArgv("a".repeat(64)),
      this.builders.buildDockerLifecycleInspectArgv("fixture"), this.builders.buildDockerImageIdentityInspectArgv(this.manifest.image),
      this.builders.buildDockerOwnedStopLookupArgv({ owner: this.owner, projectId: this.projectId,
        deploymentId: sample.deploymentId, candidateId: sample.candidateId, effectiveImage: this.manifest.image }),
      this.builders.buildDockerActiveIdentityInspectArgv({ candidate: sample, projectId: this.projectId, containerName: "fixture",
        hostPort: 49170, containerPort: 8080, owner: this.owner, allowedNetworks: [this.network], networkName: this.network })]) {
      this.allowedFormats.add(argv[argv.indexOf("--format") + 1]!);
    }
    this.runner = { run: (argv, signal) => this.runProduction(argv, signal) };
    await this.setupApplication();
  }
  private async runProduction(argv: readonly string[], signal: AbortSignal): Promise<DockerProcessExit> {
    assert.equal(argv[0], "docker");
    if (argv[1] === "run") {
      const name = argv[argv.indexOf("--name") + 1]!;
      const intent = this.intentFor(name);
      const port = Number(argv[argv.indexOf("--publish") + 1]!.split(":")[1]);
      assert(port === 49170 || port === 49171);
      const expected = this.builders.buildDockerRunArgv({ candidate: { candidateId: intent.candidateId,
        projectId: this.projectId, deploymentId: intent.deploymentId, effectiveImage: this.manifest.image,
        runtimePort: 8080, networkName: this.network }, projectId: this.projectId, containerName: name,
        hostPort: port, containerPort: 8080, owner: this.owner, allowedNetworks: [this.network], networkName: this.network });
      assert.deepEqual(argv, expected, "production run escaped fixture scope");
      const ids = (await this.invoke(["docker", "ps", "--all", "--no-trunc", "--filter", `label=com.deploylite.owner=${this.owner}`,
        "--filter", `label=com.deploylite.project=${this.projectId}`, "--format", "{{.ID}}"])).stdout.trim().split("\n").filter(Boolean);
      assert(ids.length < this.manifest.maxContainers && ids.every((id) => this.containers.has(id)), "container ceiling/ownership conflict");
      this.event("run-intent", { name, intent, sourceArgv: [...argv], port }); await this.persist();
      // Test boundary forbids Docker's implicit registry pull. Production argv itself remains recorded unchanged.
      const bounded = argv.slice(2).map((part, index, source) => source[index - 1] === "--tmpfs" ? `${part},size=16m` : part);
      const result = await this.invoke([argv[0]!, argv[1]!, "--pull=never", `--cpus=${this.manifest.containerCpu}`,
        `--memory=${this.manifest.containerMemoryBytes}`, "--pids-limit=64", ...bounded], signal);
      const id = result.stdout.trim(); assert(objectId.test(id));
      this.containers.set(id, { intent, name });
      this.ledger.resources.push({ kind: "container", id, name, owner: this.owner, project: this.projectId,
        deploymentId: intent.deploymentId, candidateId: intent.candidateId, image: this.manifest.image });
      await this.persist(); // Record the physical ID before checking caps, so a rejected observation cannot lose cleanup ownership.
      const format = '{"id":{{json .Id}},"cpu":{{json .HostConfig.NanoCpus}},"memory":{{json .HostConfig.Memory}},"pids":{{json .HostConfig.PidsLimit}}}';
      const observed = JSON.parse((await this.invoke(["docker", "container", "inspect", "--format", format, id], signal)).stdout);
      assert.equal(observed.id, id); assert.equal(observed.cpu, this.manifest.containerCpu * 1_000_000_000);
      assert.equal(observed.memory, this.manifest.containerMemoryBytes); assert.equal(observed.pids, 64);
      this.event("owned-container-budget", { containerId: id, ...observed });
      await this.persist(); return result;
    }
    if (argv.includes("--format")) {
      assert(this.allowedFormats.has(argv[argv.indexOf("--format") + 1]!), "arbitrary inspection dump forbidden");
      if (argv[1] === "image") assert.equal(argv.at(-1), this.manifest.image);
      else if (argv[1] === "ps") {
        assert(argv.includes(`label=com.deploylite.owner=${this.owner}`) && argv.includes(`label=com.deploylite.project=${this.projectId}`));
      } else this.intentFor(argv.at(-1)!);
      const result = await this.invoke(argv, signal);
      if (this.barrier && result.stdout.trim() === "healthy" && argv.at(-1)?.startsWith("deploylite-candidate-")) {
        const barrier = this.barrier; this.barrier = undefined; barrier.entered(); await barrier.wait;
      }
      return result;
    }
    assert(["stop", "start", "rm", "rename"].includes(argv[1]!), "non-fixture command forbidden");
    const target = argv[1] === "rename" ? argv[2]! : argv.at(-1)!;
    const lifecycleArgv = argv[1] === "stop" ? this.builders.buildDockerStopArgv(target)
      : argv[1] === "start" ? this.builders.buildDockerStartArgv(target)
      : argv[1] === "rm" ? this.builders.buildDockerRemoveArgv(target)
      : this.builders.buildDockerRenameArgv(target, this.intentFor(target).active);
    assert.deepEqual(argv, lifecycleArgv, "lifecycle escaped exact fixture operation");
    const before = await this.inspected(target);
    assert(this.containers.has(before.id), "destructive target must be a recorded manifest ID");
    if (argv[1] === "rename") assert.equal(argv[3], this.intentFor(target).active);
    if (argv[1] === "stop") this.event("physical-owned-stop", { containerId: before.id, priorRunning: before.running,
      lastHealthyProbeBegin: this.events.filter((event) => event.kind === "loopback-probe" && event.healthy).at(-1)?.beginMonoMs });
    const result = await this.invoke(argv, signal);
    if (argv[1] === "rm") this.containers.delete(before.id);
    if (argv[1] === "rename") this.containers.get(before.id)!.name = argv[3]!;
    if (argv[1] === "stop" && this.faultArmed && ["throw-after-stop", "cancel-after-stop"].includes(this.fault)) {
      this.faultArmed = false; this.faultMono = performance.now();
      this.event("harness-injected-fault", { fault: this.fault, actualStoppedContainerId: before.id });
      if (this.fault === "cancel-after-stop") this.controller.abort();
      else throw new Error("harness injected failure after real owned prior stop");
    }
    return result;
  }
  private register(body: Record<string, unknown>): void {
    if (body.action === "deployment.stop") return;
    assert.equal(body.projectId, this.projectId); assert.equal(body.agentId, this.manifest.runtimeHost);
    const deploymentId = requireText(body.deploymentId, "execution ID"), commandId = requireText(body.commandId, "command ID");
    assert((/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(deploymentId) ||
      /^dep_[a-z0-9_-]{1,59}$/.test(deploymentId)) && /^[a-z0-9][a-z0-9_.-]{0,62}$/.test(commandId));
    const intent = { deploymentId, candidateId: `${deploymentId}:candidate:${commandId}`,
      candidate: `deploylite-candidate-${deploymentId}-${commandId}`, active: `deploylite-active-${deploymentId}` };
    const old = this.intents.get(deploymentId);
    if (old) assert.deepEqual(intent, old); else this.intents.set(deploymentId, intent);
  }
  private async setupApplication(): Promise<void> {
    const [{ buildApiApp, createRuntimeRepositories, createInMemoryExecutionRepositories, InMemoryAuthUserRepository },
      { parseDeployLiteEnv, signAgentTransport }, { AuthenticatedAgentCommandReceiver, DigestDeploymentDispatcher },
      { InMemoryProtocolTransport }, { AuthenticatedAgentDeploymentTransport }, { createDeploymentSnapshot }] = await Promise.all([
      import("./app.js"), import("@deploylite/config"), import("@deploylite/agent"), import("@deploylite/domain"),
      import("./agent-transport.js"), import("@deploylite/contracts")
    ]);
    const env = { NODE_ENV: "test", DEPLOYLITE_BCRYPT_COST: "10" };
    const runtime = await createRuntimeRepositories(parseDeployLiteEnv(env), { auth: { users: new InMemoryAuthUserRepository() } });
    const email = `p2v-${this.manifest.runId}@example.test`;
    await runtime.auth.users.createInitialAdmin({ email, passwordHash: await runtime.auth.hasher.hash(this.credentials.adminPassword) });
    await runtime.state.projects.save({ id: this.projectId, name: "Disposable P2 fixture", repoUrl: "https://example.test/p2-fixture",
      defaultBranch: "main", buildCommand: "unused", runCommand: "unused", port: 8080, description: null, imageTag: null });
    await runtime.state.agents.save({ id: this.manifest.runtimeHost, name: "Disposable P2 fixture agent", endpoint: "https://agent.fixture.test",
      status: "online", lastHeartbeatAt: new Date().toISOString(), resourceSnapshot: { cpuLoad: 0, memoryUsedBytes: 0,
        memoryTotalBytes: this.manifest.containerMemoryBytes * this.manifest.maxContainers, diskUsedBytes: 0, diskTotalBytes: 1 } });
    this.memory = createInMemoryExecutionRepositories(runtime.state.projects, runtime.auth.audit);
    const dispatcher = new DigestDeploymentDispatcher({ protocol: new InMemoryProtocolTransport({ clock: { now: Date.now },
      leasePolicy: { ttlMs: 180_000 }, retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 }, capabilities: ["deploy.execute"] }),
      runner: this.runner, owner: this.owner, hostPort: 49170, temporaryHostPort: 49171, containerPort: 8080,
      trustedHosts: [this.manifest.image.split("/")[0]!], allowedNetworks: [this.network], networkName: this.network, promotionPolicy: policy });
    const settled = new Map<string, { fingerprint: string; receipt: Record<string, unknown> }>();
    const pending = new Map<string, string>();
    const replayStore: AgentReplayStore = {
      claim: async (id, fingerprint) => {
        const old = settled.get(id);
        if (old) { assert.equal(old.fingerprint, fingerprint); return { claimed: false, receipt: structuredClone(old.receipt) }; }
        assert(!pending.has(id), "unexpected concurrent same command"); pending.set(id, fingerprint);
        return { claimed: true, claimToken: `${this.manifest.runId}:${id}` };
      },
      wait: async () => { throw new Error("unexpected harness replay wait"); },
      complete: async (id, value) => { assert.equal(pending.get(id), value.fingerprint); settled.set(id, structuredClone(value)); pending.delete(id); },
      release: async (id) => { pending.delete(id); }
    };
    const receiver = new AuthenticatedAgentCommandReceiver({ agentId: this.manifest.runtimeHost, trustKey: this.credentials.trustKey,
      capabilities: ["deploy.execute", "deployment.stop"], dispatcher, stopDispatcher: dispatcher,
      authorityValidator: this.memory.controls, replayStore });
    const transport = new AuthenticatedAgentDeploymentTransport({ endpoint: "https://agent.fixture.test", agentId: this.manifest.runtimeHost,
      trustKey: this.credentials.trustKey, fetch: async (url, init) => {
        const signature = String((init?.headers as Record<string, string>)["x-deploylite-signature"]);
        if (String(url).endsWith("/capabilities")) {
          assert(receiver.verifyRequest("GET /capabilities", signature));
          return new Response(JSON.stringify({ schemaVersion: 1, agentId: receiver.agentId, capabilities: receiver.capabilities,
            protocolVersions: [1, 2] }), { headers: { "x-deploylite-request-signature": signature } });
        }
        let body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        let requestSignature = signature;
        assert(receiver.verifyRequest(JSON.stringify(body), signature), "real API signature required");
        this.register(body);
        const originalBinding = { commandId: body.commandId, deploymentId: body.deploymentId,
          correlationId: record(body.context).correlationId, originalProjectId: body.projectId, originalSnapshotHash: body.snapshotHash };
        if (this.tamper !== "none" && body.schemaVersion === 1 && !body.action) {
          if (this.tamper === "unsigned") body = { ...body, projectId: randomUUID() };
          else {
            const original = body.snapshot as unknown as DeploymentSnapshotV1;
            const { hash: _hash, canonicalJson: _json, canonicalBytes: _bytes, ...projection } = original;
            const changed = createDeploymentSnapshot({ ...projection, configRevision: "harness-alternative-config" },
              { sha256: (bytes) => createHash("sha256").update(bytes).digest("hex") });
            body = { ...body, snapshot: { ...changed, canonicalBytes: undefined }, snapshotHash: changed.hash };
            requestSignature = signAgentTransport(JSON.stringify(body), this.credentials.trustKey);
          }
          this.event("harness-injected-wire-tamper", { tamper: this.tamper, ...originalBinding });
        }
        this.envelopes.push(structuredClone({ ...body, requestAuthenticated: receiver.verifyRequest(JSON.stringify(body), requestSignature) }));
        const relay = () => this.controller.abort(); init?.signal?.addEventListener("abort", relay, { once: true });
        if (init?.signal?.aborted) relay();
        try {
          let reply: Awaited<ReturnType<typeof receiver.receive>>;
          try { reply = await receiver.receive(body, requestSignature, this.controller.signal); }
          catch (error) {
            this.event("receiver-rejection", { commandId: body.commandId, deploymentId: body.deploymentId,
              correlationId: record(body.context).correlationId, requestAuthenticated: receiver.verifyRequest(JSON.stringify(body), requestSignature),
              reason: (error as Error).message });
            throw error;
          }
          this.replies.push(structuredClone(reply));
          if ((this.fault === "lost-stop-reply" && body.action === "deployment.stop") ||
            (this.fault === "lost-replacement-reply" && body.schemaVersion === 2)) {
            this.event("harness-injected-lost-reply", { action: body.action ?? "deploy.execute", commandId: body.commandId });
            throw new Error("harness dropped actual received terminal reply");
          }
          return new Response(JSON.stringify(reply));
        } finally { init?.signal?.removeEventListener("abort", relay); }
      } });
    const snapshots = new Map<string, DeploymentSnapshotV1>();
    this.app = await buildApiApp({ env, auth: runtime.auth, imagePolicy: { policyVersion: "p2-fixture-v1",
      trustedHosts: [this.manifest.image.split("/")[0]!], allowTags: false, allowDigests: true },
      state: { ...runtime.state, deployments: this.memory.deployments, executionCompletion: this.memory.completion,
        controlDeletes: this.memory.controls, controlRedeploy: this.memory.controls, deploymentDispatcher: transport,
        deploymentStopDispatcher: transport, snapshots: { saveSnapshot: async (value) => { snapshots.set(value.hash, structuredClone(value)); },
          findByHash: async (hash) => structuredClone(snapshots.get(hash) ?? null) },
        controlGrants: { listForActor: async (actorId) => ["deployment.redeploy", "deployment.stop"].map((action) => ({
          id: `${this.manifest.runId}:${action}`, actorId, action: action as "deployment.redeploy" | "deployment.stop",
          scope: { kind: "platform" as const } })) } } });
    const login = await this.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: this.credentials.adminPassword } });
    assert.equal(login.statusCode, 200); this.cookie = login.headers["set-cookie"] as string;
    // No app.listen(), agent server, PostgreSQL, real secrets or deployed HTTP boundary is involved.
  }
}

// These prospective guard assertions are intentionally authored before runtime activation; NOT RUN in preparation.
describe("physical Docker acceptance opt-in guard", () => {
  const job = { repository: "fixture/deploylite", runId: "123456", runAttempt: "1", job: "p2-docker-acceptance" };
  const valid = () => ({ schemaVersion: 1, authorization: "P2_PHYSICAL_DOCKER_APPROVED", grantId: "fixture-grant-123456789",
    runId: "11111111-1111-4111-8111-111111111111", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    dockerHost: "unix:///tmp/p2-fixture.sock", engineId: "fixture-engine-123456789", image: `127.0.0.1:49172/deploylite-p2/11111111-1111-4111-8111-111111111111@sha256:${"a".repeat(64)}`,
    platform: "linux/amd64", runtimeHost: "22222222-2222-4222-8222-222222222222", activePort: 49170, temporaryPort: 49171,
    containerPort: 8080, maxContainers: 3, containerCpu: 0.5, containerMemoryBytes: 67108864,
    engineScope: "ephemeral-github-actions-job", ciJob: job, dockerConfigDirectory: "/tmp/fixture-empty-docker-config", healthPath: "/healthz",
    credentialsFile: "/tmp/fixture-private.json", receiptDirectory: "/tmp/fixture-receipts", harnessSha256: "c".repeat(64), operations: [...operations],
    sourceHashes: Object.fromEntries(sourcePaths.map((path) => [path, "b".repeat(64)])) });
  const env = { DEPLOYLITE_DOCKER_INTEGRATION: "1", DEPLOYLITE_DOCKER_RUNTIME_GRANT: "P2_PHYSICAL_DOCKER_APPROVED",
    DEPLOYLITE_DOCKER_GRANT_ID: "fixture-grant-123456789", DOCKER_HOST: "unix:///tmp/p2-fixture.sock",
    GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", GITHUB_REPOSITORY: job.repository, GITHUB_RUN_ID: job.runId,
    GITHUB_RUN_ATTEMPT: job.runAttempt, GITHUB_JOB: job.job, DOCKER_CONFIG: "/tmp/fixture-empty-docker-config" };
  it.each([undefined, "0", "true"])("keeps Docker inaccessible for flag %s", (flag) => {
    const factory = vi.fn();
    expect(() => { validateManifest(valid(), { ...env, DEPLOYLITE_DOCKER_INTEGRATION: flag }); factory(); }).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
  it.each(["authorization", "grantId", "image", "platform", "runtimeHost", "dockerHost", "harnessSha256", "sourceHashes", "operations"])(
    "rejects missing %s before constructing a process runner", (field) => {
      const input: Record<string, unknown> = valid(); delete input[field]; const factory = vi.fn();
      expect(() => { validateManifest(input, env); factory(); }).toThrow(); expect(factory).not.toHaveBeenCalled();
    });
  const jobEnv = { ...env, CI: "true", GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: job.repository,
    GITHUB_RUN_ID: job.runId, GITHUB_RUN_ATTEMPT: job.runAttempt, GITHUB_JOB: job.job,
    DOCKER_CONFIG: "/tmp/fixture-empty-docker-config" };
  const owned = () => ({ ...valid(), engineScope: "ephemeral-github-actions-job", ciJob: job,
    containerCpu: 0.5, containerMemoryBytes: 64 * 1024 * 1024, dockerConfigDirectory: jobEnv.DOCKER_CONFIG });
  it.each([
    { GITHUB_ACTIONS: "false" }, { GITHUB_REPOSITORY: "other/repository" }, { GITHUB_RUN_ID: "654321" },
    { GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_JOB: "other-job" }, { DOCKER_CONFIG: "/tmp/ambient-config" }
  ])("rejects an unowned CI execution identity %j before any runner", (change) => {
    expect(() => validateManifest(owned(), { ...jobEnv, ...change })).toThrow();
  });
  it.each([{ containerCpu: 1 }, { containerMemoryBytes: 128 * 1024 * 1024 }, { engineScope: "shared-daemon" }])(
    "rejects owned-resource budget/scope drift %j", (change) => {
      expect(() => validateManifest({ ...owned(), ...change }, jobEnv)).toThrow();
    });
  it("accepts the observed loopback registry RepoDigest without treating an image ID as its digest", () => {
    const image = `127.0.0.1:49172/deploylite-p2/${valid().runId}@sha256:${"a".repeat(64)}`;
    expect(() => validateManifest({ ...owned(), image }, jobEnv)).not.toThrow();
    expect(() => validateManifest({ ...owned(), image: `sha256:${"a".repeat(64)}` }, jobEnv)).toThrow();
  });
  it("records the current UUID execution identity without rewriting its logical candidate", () => {
    const f = new PhysicalFixture(validateManifest(owned(), jobEnv), { trustKey: "mock-only", adminPassword: "mock-only" }, "GUARD_UUID");
    const deploymentId = "33333333-3333-5333-8333-333333333333", commandId = "44444444-4444-4444-8444-444444444444";
    const register = f as unknown as { register(body: Record<string, unknown>): void };
    expect(() => register.register({ projectId: f.projectId, agentId: f.manifest.runtimeHost, deploymentId, commandId })).not.toThrow();
    expect(f.intents.get(deploymentId)?.candidateId).toBe(`${deploymentId}:candidate:${commandId}`);
  });
  it("accepts a larger native owned hosted engine and records only per-container budgets", async () => {
    const f = new PhysicalFixture(validateManifest(owned(), jobEnv), { trustKey: "mock-only", adminPassword: "mock-only" }, "GUARD_ENGINE");
    const id = "d".repeat(64);
    const run = vi.fn(async (argv: readonly string[]): Promise<DockerProcessExit> => {
      const words = argv.filter((word) => !["--config", jobEnv.DOCKER_CONFIG, "--host", f.manifest.dockerHost].includes(word));
      const data = words[1] === "info" ? { id: f.manifest.engineId, os: "linux", architecture: "x86_64", cpu: 8, memory: 16 * 1024 ** 3 }
        : words[1] === "image" ? { id: `sha256:${"a".repeat(64)}`, os: "linux", arch: "amd64", repoDigests: [f.manifest.image], healthType: "CMD", healthInterval: 1_000_000_000 }
        : words[2] === "inspect" ? { id, name: f.network, owner: f.owner, project: f.projectId, internal: true, containers: {} } : null;
      return { exitCode: 0, signal: null, stdout: data === null ? id : JSON.stringify(data), stderr: "" };
    });
    const portCheck = vi.fn(async () => {});
    const app = vi.spyOn(f as unknown as { setupApplication(): Promise<void> }, "setupApplication").mockResolvedValue();
    const persist = vi.spyOn(f, "persist").mockResolvedValue();
    try {
      await expect(f.setup({ runner: { run }, portCheck, config: { stat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: process.getuid!(), mode: 0o700 }), list: async () => [] } })).resolves.toBeUndefined();
      expect(portCheck.mock.calls).toEqual([[49170], [49171]]);
      expect(run.mock.calls.every(([argv]) => !argv.includes("update"))).toBe(true);
    } finally { app.mockRestore(); persist.mockRestore(); }
  });
  async function recordingRun(limits = { cpu: 500_000_000, memory: 64 * 1024 * 1024, pids: 64 }) {
    const f = new PhysicalFixture(validateManifest(owned(), jobEnv), { trustKey: "mock-only", adminPassword: "mock-only" }, "GUARD_CAPS");
    const builders = await import("../../agent/src/infrastructure/docker/docker-cli-argv.js");
    const deploymentId = "33333333-3333-4333-8333-333333333333", commandId = "44444444-4444-4444-8444-444444444444";
    const intent = { deploymentId, candidateId: `${deploymentId}:candidate:${commandId}`,
      candidate: `deploylite-candidate-${deploymentId}-${commandId}`, active: `deploylite-active-${deploymentId}` };
    const id = "e".repeat(64); f.intents.set(deploymentId, intent);
    const run = vi.fn(async (argv: readonly string[]): Promise<DockerProcessExit> => {
      const words = argv.filter((word) => !["--config", jobEnv.DOCKER_CONFIG, "--host", f.manifest.dockerHost].includes(word));
      const stdout = words[1] === "ps" ? "" : words[1] === "run" ? id : JSON.stringify({ id, ...limits });
      return { exitCode: 0, signal: null, stdout, stderr: "" };
    });
    Object.assign(f, { raw: { run }, builders });
    vi.spyOn(f, "persist").mockResolvedValue();
    const argv = builders.buildDockerRunArgv({ candidate: { candidateId: intent.candidateId, projectId: f.projectId,
      deploymentId, effectiveImage: f.manifest.image, runtimePort: 8080, networkName: f.network }, projectId: f.projectId,
      containerName: intent.candidate, owner: f.owner, hostPort: 49171, containerPort: 8080, networkName: f.network, allowedNetworks: [f.network] });
    const execute = () => (f as unknown as { runProduction(argv: readonly string[], signal: AbortSignal): Promise<DockerProcessExit> })
      .runProduction(argv, new AbortController().signal);
    return { f, run, execute };
  }
  it("adds pull-never/owned caps and verifies their actual inspection before returning success", async () => {
    const { f, run, execute } = await recordingRun();
    await execute();
    const args = run.mock.calls.find(([argv]) => argv.includes("run"))![0];
    expect(args).toContain("--pull=never"); expect(args).toContain("--cpus=0.5");
    expect(args).toContain("--memory=67108864"); expect(args).toContain("--pids-limit=64");
    expect(args.filter((part) => part.includes(":rw,")).every((part) => part.includes("size=16m"))).toBe(true);
    expect(args.slice(1, 5)).toEqual(["--config", jobEnv.DOCKER_CONFIG, "--host", f.manifest.dockerHost]);
    expect(run.mock.calls.some(([argv]) => argv.includes("inspect") && argv.at(-1) === "e".repeat(64))).toBe(true);
    expect(f.events.some((event) => event.kind === "owned-container-budget" && event.cpu === 500_000_000 && event.memory === 67108864)).toBe(true);
  });
  it.each([{ cpu: 0, memory: 67108864, pids: 64 }, { cpu: 500000000, memory: 0, pids: 64 }, { cpu: 500000000, memory: 67108864, pids: 0 }])(
    "refuses observed missing/widened owned-container limits %j while retaining the exact cleanup ID", async (limits) => {
      const { f, execute } = await recordingRun(limits);
      await expect(execute()).rejects.toThrow();
      expect(f.containers.has("e".repeat(64))).toBe(true);
    });
  describe("corrective Docker source guards", () => {
    const correctedEnv = { ...jobEnv, RUNNER_ENVIRONMENT: "github-hosted" };
    const corrected = () => ({ ...owned(), expiryClosures: { recoveryMaxMs: 60_000, cleanupMaxMs: 30_000 } });
    const withEnv = () => {
      for (const [key, value] of Object.entries(correctedEnv)) vi.stubEnv(key, value);
      vi.stubEnv("DEPLOYLITE_DOCKER_MANIFEST", "/tmp/mock-manifest.json");
    };
    it.each([undefined, "", "self-hosted"])("rejects non-hosted runner environment %s before runner", (value) => {
      expect(() => validateManifest(corrected(), { ...correctedEnv, RUNNER_ENVIRONMENT: value })).toThrow();
    });
    function inputs(fault = "valid") {
      const bytes = Buffer.from("recording reviewed source bytes"), digest = createHash("sha256").update(bytes).digest("hex");
      const input = { ...corrected(), harnessSha256: digest, sourceHashes: Object.fromEntries(sourcePaths.map((p) => [p, digest])) };
      const uid = process.getuid!();
      const readPrivate = vi.fn(async (path: string): Promise<unknown> => path === "/tmp/mock-manifest.json" ? input
        : { trustKey: "mock-credential-not-read-from-disk-123456789", adminPassword: "mock-admin-not-read-from-disk-123456789" });
      const stat = vi.fn(async (path: string) => {
        const config = path === input.dockerConfigDirectory;
        if (config && fault === "missing") throw new Error("ENOENT recording private config");
        return { isDirectory: () => !(config && fault === "file"), isSymbolicLink: () => config && fault === "symlink",
          uid: uid + Number(config && fault === "foreign-owner"), mode: config && fault === "public-mode" ? 0o755 : 0o700 };
      });
      const list = vi.fn(async () => fault === "nonempty" ? ["config.json"] : []);
      const read = vi.fn(async () => bytes), makeDirectory = vi.fn(async () => {});
      return { readPrivate, stat, list, read, makeDirectory, input };
    }
    it.each(["missing", "file", "symlink", "foreign-owner", "public-mode", "nonempty"])(
      "rejects private Docker config %s without reading its contents or credentials", async (fault) => {
        withEnv(); const boundary = inputs(fault);
        try {
          await expect(loadGrant(boundary)).rejects.toThrow();
          expect(boundary.readPrivate.mock.calls.map(([path]) => path)).toEqual(["/tmp/mock-manifest.json"]);
          expect(boundary.read).not.toHaveBeenCalled(); expect(boundary.makeDirectory).not.toHaveBeenCalled();
        } finally { vi.unstubAllEnvs(); }
      });
    it("characterizes valid private empty owned config without any process", async () => {
      withEnv(); const boundary = inputs();
      try { expect((await loadGrant(boundary)).manifest.dockerConfigDirectory).toBe(boundary.input.dockerConfigDirectory); }
      finally { vi.unstubAllEnvs(); }
    });
  });
});
