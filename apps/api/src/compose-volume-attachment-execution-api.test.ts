import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvSecretCipher, loadEnvSecretKey } from "@deploylite/config";
import { hashSessionToken } from "@deploylite/db";
import { InMemoryCapabilityRegistry, composeVolumeAttachmentReceiptSchema, type ComposeResourceObservationV1, type ComposeVolumeAttachmentReceiptV1, type ImageReferencePolicyV1, type Project } from "@deploylite/contracts";
import { claimProjectUpdateAuthority, createComposePreview, createComposeRevision, digestComposeResourceObservation, InMemoryEnvSecretValueRepository,
  resolveControlCommandInMemory, validateProjectUpdateAuthority, type CanonicalRoleName, type ComposeRevisionSaveStore,
  type ProjectRepository, type ProjectUpdateControlRepository } from "@deploylite/domain";
import type { ComposeResourceInspectionAccess } from "./compose-resource-inspection-route.js";
import type { PreparedComposeVolumeAttachmentCommand } from "./agent-transport.js";
import type { ComposeVolumeAttachmentExecutionAccess } from "./compose-volume-attachment-execution-route.js";
import { buildApiApp, createInMemoryExecutionRepositories, InMemoryAuditRepository, InMemoryAuthUserRepository, InMemorySessionRepository } from "./app.js";

const apps: Awaited<ReturnType<typeof buildApiApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });
const policy: ImageReferencePolicyV1 = { policyVersion: "volume-attachment-api-test", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const image = `registry.example.com/app@sha256:${"a".repeat(64)}`;
const oldId = "c".repeat(64), networkId = "b".repeat(64), secret = "synthetic-token-never-return";
const document = (withMount: boolean, imageRef = image) => JSON.stringify({ services: { app: { image: imageRef, environment: { TOKEN: "${APP_TOKEN}" }, networks: ["backend"],
  ...(withMount ? { volumes: [{ type: "volume", source: "data", target: "/data" }] } : {}) } }, networks: { backend: {} }, volumes: { data: {} } });
const priorDocument = document(false), nextDocument = document(true);
const priorPreview = createComposePreview(priorDocument, "project-1", policy), nextPreview = createComposePreview(nextDocument, "project-1", policy);
const priorRevision = createComposeRevision({ document: priorDocument, projectId: "project-1", composeId: "compose-1", revisionId: "revision-1", revisionNumber: 1,
  createdBy: "compose-user", createdAt: "2026-10-08T00:00:00.000Z", expectedPreviewDigest: priorPreview.configDigest }, policy);
const nextRevision = createComposeRevision({ document: nextDocument, projectId: "project-1", composeId: "compose-1", revisionId: "revision-2", revisionNumber: 2,
  createdBy: "compose-user", createdAt: "2026-10-08T00:01:00.000Z", expectedPreviewDigest: nextPreview.configDigest }, policy);

async function fixture({ permission = true, next = nextRevision, otherConsumer = false, stale = false }: { permission?: boolean; next?: typeof nextRevision; otherConsumer?: boolean; stale?: boolean } = {}) {
  const project: Project = { id: "project-1", name: "Volume apply", repoUrl: "https://github.com/DeployLiteApp/DeployLite", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null };
  const projects: ProjectRepository = { save: async item => item, findById: async id => id === project.id ? project : null, list: async () => [project], remove: async () => false };
  const revisions = new Map([[priorRevision.id, priorRevision], [next.id, next]]);
  const revisionStore: ComposeRevisionSaveStore = { available: () => true, save: async () => { throw new Error("unused"); },
    findRevision: async (projectId, id) => projectId === project.id ? structuredClone(revisions.get(id) ?? null) : null,
    findLatestRevision: async projectId => projectId === project.id ? structuredClone(next) : null,
    findResourceOwner: async () => null, listRevisions: async () => ({ limit: 10, offset: 0, total: 0, revisions: [] }),
    listResources: async () => ({ limit: 10, offset: 0, total: 0, resources: [] }) };
  const cipher = createEnvSecretCipher(loadEnvSecretKey("volume_attachment_api_fixture_secret_key_123456"));
  const secrets = new InMemoryEnvSecretValueRepository();
  const listEncryptedSecrets = vi.spyOn(secrets, "listEncryptedByProject");
  await secrets.upsert({ projectId: project.id, key: "APP_TOKEN", scope: "project", encryptedValue: Buffer.from(cipher.encrypt(secret), "base64"),
    valueFingerprint: cipher.fingerprint(secret), keyVersion: 1 });
  const environmentDigest = createHash("sha256").update(JSON.stringify({ TOKEN: secret })).digest("hex");
  const container = { containerId: oldId, service: "app", running: true, attached: false, composeRevisionId: priorRevision.id,
    composeConfigDigest: priorPreview.configDigest, composeEnvironmentDigest: stale ? "e".repeat(64) : environmentDigest, networks: [{ name: priorPreview.networks[0]!.runtimeName, networkId }], mounts: [] };
  const volumeObservation: ComposeResourceObservationV1 = { schemaVersion: 1, owner: "deploylite", agentId: "agent-1", projectId: project.id, kind: "volume", key: "data",
    runtimeName: priorPreview.volumes[0]!.runtimeName, physicalIdentity: "2026-10-08T00:00:00.000Z", configDigest: priorPreview.configDigest,
    observedAt: 1_000, stateDigest: "", containers: [structuredClone(container), ...(otherConsumer ? [{ ...structuredClone(container), containerId: "f".repeat(64), service: "worker", attached: true }] : [])] };
  const networkObservation: ComposeResourceObservationV1 = { schemaVersion: 1, owner: "deploylite", agentId: "agent-1", projectId: project.id, kind: "network", key: "backend",
    runtimeName: priorPreview.networks[0]!.runtimeName, physicalIdentity: networkId, configDigest: priorPreview.configDigest, observedAt: 1_000, stateDigest: "",
    containers: [{ ...structuredClone(container), attached: true, mounts: [] }] };
  volumeObservation.stateDigest = digestComposeResourceObservation(volumeObservation);
  networkObservation.stateDigest = digestComposeResourceObservation(networkObservation);
  const inspect = vi.fn(async (input: { kind: "volume" | "network" }) => structuredClone(input.kind === "volume" ? volumeObservation : networkObservation));
  const access: ComposeResourceInspectionAccess = { owner: "deploylite", agentId: "agent-1", inspector: { inspect }, clock: { now: () => 1_010 }, maxAgeMs: 100,
    capabilities: new InMemoryCapabilityRegistry(["compose.resource.inspect.v1"]), deadlineMs: 2_000 };
  const audit = new InMemoryAuditRepository(), sessions = new InMemorySessionRepository(), shared = createInMemoryExecutionRepositories(projects, audit);
  const commands = () => shared.completion.commands;
  const controls: ProjectUpdateControlRepository = {
    resolve: async command => resolveControlCommandInMemory(commands(), command), complete: async command => command,
    findProjectUpdateByIdempotency: async (actorId, projectId, key) => [...commands().values()].find(value => value.actorId === actorId && value.action === "project.update"
      && value.scope.kind === "project" && value.scope.projectId === projectId && value.idempotencyKey === key) ?? null,
    claimProjectUpdate: async command => {
      const stored = [...commands().values()].find(value => value.id === command.id);
      if (!stored) throw new Error("missing test command");
      const authority = claimProjectUpdateAuthority([...commands().values()], stored, 1_010);
      return { command: structuredClone(stored), claimed: !!authority, ...(authority ? { authority } : {}) };
    },
    validateProjectUpdateAuthority: async authority => validateProjectUpdateAuthority([...commands().values()], authority, 1_010),
    completeProjectUpdate: async (command, authority, event) => {
      const stored = [...commands().values()].find(value => value.id === command.id);
      if (!stored) throw new Error("missing test command");
      if (stored.status === "completed") return structuredClone(stored);
      validateProjectUpdateAuthority([...commands().values()], authority, 1_010);
      await audit.append(event);
      const key = [...commands()].find(([, value]) => value.id === command.id)?.[0];
      if (!key) throw new Error("missing test command key");
      const completed = { ...stored, status: "completed" as const };
      commands().set(key, completed);
      return structuredClone(completed);
    }
  };
  const cached = new Map<string, ComposeVolumeAttachmentReceiptV1>(); let dispatches = 0;
  const transport = { available: () => true,
    readComposeVolumeAttachmentReceipt: async (prepared: PreparedComposeVolumeAttachmentCommand) => cached.get(prepared.command.id) ?? null,
    dispatchComposeVolumeAttachment: async (prepared: PreparedComposeVolumeAttachmentCommand) => {
      dispatches++;
      const receipt = composeVolumeAttachmentReceiptSchema.parse({ schemaVersion: 1, action: "compose.volume.attachment", agentId: prepared.agentId,
        commandId: prepared.command.id, projectId: project.id, inputDigest: prepared.command.inputDigest, correlationId: prepared.command.correlationId,
        key: "data", runtimeName: priorPreview.volumes[0]!.runtimeName, service: "app", attachmentAction: "attach", priorContainerId: oldId,
        replacementContainerId: "d".repeat(64), resourceCreatedAt: "2026-10-08T00:00:00.000Z", beforeStateDigest: volumeObservation.stateDigest,
        afterStateDigest: "e".repeat(64), observedAt: 1_011, status: "replaced", health: "passed", rollback: "not-required", reconciled: false, redacted: true, reason: null });
      cached.set(prepared.command.id, receipt); return receipt;
    } };
  const user = { id: "volume-user", email: "volume@example.test", emailNormalized: "volume@example.test", passwordHash: "unused-test-hash", role: "operator" as CanonicalRoleName,
    status: "active" as const, createdAt: new Date(), updatedAt: new Date() };
  await sessions.create({ userId: user.id, tokenHash: hashSessionToken("volume-attachment-test-session"), expiresAt: new Date("2027-01-01T00:00:00Z") });
  const grants = { listForActor: vi.fn(async (actorId: string) => permission ? [{ id: "volume-update", actorId, action: "project.update" as const, scope: { kind: "project" as const, projectId: project.id } }] : []) };
  const execution: ComposeVolumeAttachmentExecutionAccess = { controls, transport, commandTtlMs: 30_000 };
  const app = await buildApiApp({ env: { NODE_ENV: "test", DEPLOYLITE_SECRET_KEY: "volume_api_env_fixture_secret_key_123456" }, corsOrigin: false, imagePolicy: policy,
    authConfig: { cookieName: "volume_session", cookieSecure: false }, auth: { users: new InMemoryAuthUserRepository([user]), sessions, audit },
    state: { projects, composeRevisionSaves: revisionStore, envSecretValues: secrets, envSecretCipher: cipher, controlGrants: grants },
    composeResourceInspection: new Map([[project.id, access]]), composeVolumeAttachmentExecutions: new Map([[project.id, execution]]) });
  apps.push(app); audit.inputs.length = 0; audit.events.length = 0; grants.listForActor.mockClear();
  const input = { priorRevisionId: priorRevision.id, revisionId: next.id, key: "data", service: "app", attachmentAction: "attach",
    expectedStateDigest: volumeObservation.stateDigest, expectedContainerId: oldId };
  const post = (body: unknown = input, key = "volume-attach-once", session = true) => app.inject({ method: "POST",
    url: `/api/v1/projects/${project.id}/compose/volumes/attachment/apply`, headers: { ...(session ? { cookie: "volume_session=volume-attachment-test-session" } : {}), "idempotency-key": key },
    payload: body as Record<string, unknown> });
  return { post, input, inspect, audit, commands, dispatches: () => dispatches, grants, volumeObservation, secrets, listEncryptedSecrets, cached };
}

describe("project-scoped saved-revision volume attachment API", () => {
  it("applies through shared project.update authority and recovers the same cached receipt on retry", async () => {
    const f = await fixture(), first = await f.post();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data.attachment).toMatchObject({ status: "replaced", health: "passed", rollback: "not-required", redacted: true });
    expect(f.dispatches()).toBe(1);
    expect([...f.commands().values()]).toContainEqual(expect.objectContaining({ action: "project.update", status: "completed", projectExecutionAuthority: expect.any(Object) }));
    expect(f.audit.inputs).toContainEqual(expect.objectContaining({ action: "compose.volume.attachment.executed", targetId: "project-1" }));
    expect(first.body + JSON.stringify(f.audit.inputs)).not.toContain(secret);
    const inspectionCalls = f.inspect.mock.calls.length, retry = await f.post();
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().data.attachment).toEqual(first.json().data.attachment);
    expect(f.dispatches()).toBe(1);
    expect(f.inspect).toHaveBeenCalledTimes(inspectionCalls);
  });

  it("rejects unsupported revision deltas before any observation or agent dispatch", async () => {
    const changedImage = createComposeRevision({ document: document(true, `registry.example.com/other@sha256:${"f".repeat(64)}`), projectId: "project-1", composeId: "compose-1",
      revisionId: "revision-2", revisionNumber: 2, createdBy: "compose-user", createdAt: "2026-10-08T00:01:00.000Z",
      expectedPreviewDigest: createComposePreview(document(true, `registry.example.com/other@sha256:${"f".repeat(64)}`), "project-1", policy).configDigest }, policy);
    const f = await fixture({ next: changedImage }), response = await f.post();
    expect(response.statusCode).toBe(503);
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.dispatches()).toBe(0);
    expect(f.commands().size).toBe(0);
  });

  it("requires project.update permission before reading secrets or inspecting resources", async () => {
    const denied = await fixture({ permission: false }), response = await denied.post();
    expect(response.statusCode).toBe(403);
    expect(denied.inspect).not.toHaveBeenCalled();
    expect(denied.listEncryptedSecrets).not.toHaveBeenCalled();
    expect(denied.commands().size).toBe(0);
    const unauthenticated = await fixture(), noSession = await unauthenticated.post(unauthenticated.input, "volume-attach-once", false);
    expect(noSession.statusCode).toBe(401);
    expect(unauthenticated.inspect).not.toHaveBeenCalled();
  });

  it("rejects stale environment identity and a volume shared by another service before dispatch", async () => {
    const stale = await fixture({ stale: true }), staleResponse = await stale.post();
    expect(staleResponse.statusCode).toBe(409);
    expect(stale.dispatches()).toBe(0);
    const shared = await fixture({ otherConsumer: true }), sharedResponse = await shared.post();
    expect(sharedResponse.statusCode).toBe(409);
    expect(shared.dispatches()).toBe(0);
  });
});
