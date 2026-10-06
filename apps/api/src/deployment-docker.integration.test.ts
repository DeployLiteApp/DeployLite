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
