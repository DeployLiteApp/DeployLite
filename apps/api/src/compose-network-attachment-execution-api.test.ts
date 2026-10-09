import { afterEach, describe, expect, it, vi } from "vitest";
import { hashSessionToken } from "@deploylite/db";
import { InMemoryCapabilityRegistry, composeNetworkAttachmentReceiptSchema, type ComposeNetworkAttachmentReceiptV1, type ComposeResourceObservationV1, type Project } from "@deploylite/contracts";
import { claimProjectUpdateAuthority, createComposePreview, digestComposeResourceObservation, InMemoryEnvSecretValueRepository, resolveControlCommandInMemory, validateProjectUpdateAuthority,
  type CanonicalRoleName, type ControlCommand, type PreparedComposeAttachmentCommand, type ProjectRepository, type ProjectUpdateControlRepository } from "@deploylite/domain";
import type { ComposeResourceInspectionAccess } from "./compose-resource-inspection-route.js";
import { buildApiApp, createInMemoryExecutionRepositories, InMemoryAuditRepository, InMemoryAuthUserRepository, InMemorySessionRepository, type BuildApiAppOptions } from "./app.js";

const apps: Awaited<ReturnType<typeof buildApiApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });
const policy = { policyVersion: "attachment-execution-test", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const image = "registry.example.com/app@sha256:" + "a".repeat(64);
const document = JSON.stringify({ services: { app: { image, networks: ["backend"] } }, networks: { backend: {} } });
const preview = createComposePreview(document, "project-1", policy);
type MutableAccess = { -readonly [P in keyof ComposeResourceInspectionAccess]: ComposeResourceInspectionAccess[P] };
type OptionsWithAttachment = BuildApiAppOptions & Readonly<{ composeNetworkAttachmentExecutions?: ReadonlyMap<string, unknown> }>;

async function fixture({ role = "operator", permission = true }: { role?: CanonicalRoleName; permission?: boolean } = {}) {
  const projectsMap = new Map<string, Project>();
  const projects: ProjectRepository = { save: async project => { projectsMap.set(project.id, project); return project; }, findById: async id => projectsMap.get(id) ?? null,
    list: async () => [...projectsMap.values()], remove: async id => projectsMap.delete(id) };
  await projects.save({ id: "project-1", name: "Attachment", repoUrl: "https://github.com/DeployLiteApp/DeployLite", defaultBranch: "main", buildCommand: null, runCommand: null, port: null, description: null, imageTag: null });
  const observation: ComposeResourceObservationV1 = { schemaVersion: 1, owner: "deploylite", agentId: "agent-1", projectId: "project-1", kind: "network", key: "backend",
    runtimeName: preview.networks[0]!.runtimeName, physicalIdentity: "b".repeat(64), configDigest: preview.configDigest, observedAt: 1_000, stateDigest: "",
    containers: [{ containerId: "c".repeat(64), service: "app", running: false, attached: false, mounts: [] }] };
  const seal = () => { observation.stateDigest = digestComposeResourceObservation(observation); };
  seal();
  const inspect = vi.fn(async () => structuredClone(observation));
  const access: MutableAccess = { owner: "deploylite", agentId: "agent-1", inspector: { inspect }, clock: { now: () => 1_010 }, maxAgeMs: 100,
    capabilities: new InMemoryCapabilityRegistry(["compose.resource.inspect.v1"]), deadlineMs: 1_000 };
  const audit = new InMemoryAuditRepository(), sessions = new InMemorySessionRepository(), secrets = new InMemoryEnvSecretValueRepository();
  const memory = createInMemoryExecutionRepositories(projects, audit);
  const commands = () => memory.completion.commands;
  const controls: ProjectUpdateControlRepository = {
    resolve: async command => resolveControlCommandInMemory(commands(), command),
    complete: async command => command,
    findProjectUpdateByIdempotency: async (actorId, projectId, idempotencyKey) => [...commands().values()].find(command => command.actorId === actorId && command.action === "project.update"
      && command.scope.kind === "project" && command.scope.projectId === projectId && command.idempotencyKey === idempotencyKey) ?? null,
    claimProjectUpdate: async command => {
      const current = [...commands().values()].find(value => value.id === command.id);
      if (!current) throw new Error("missing command");
      const authority = claimProjectUpdateAuthority([...commands().values()], current, 1_010);
      return { command: structuredClone(current), claimed: !!authority, ...(authority ? { authority } : {}) };
    },
    validateProjectUpdateAuthority: async authority => validateProjectUpdateAuthority([...commands().values()], authority, 1_010),
    completeProjectUpdate: async (command, authority, event) => {
      const current = [...commands().values()].find(value => value.id === command.id);
      if (!current) throw new Error("missing command");
      if (current.status === "completed") return structuredClone(current);
      validateProjectUpdateAuthority([...commands().values()], authority, 1_010);
      await audit.append(event);
      const key = [...commands()].find(([, value]) => value.id === current.id)?.[0];
      if (!key) throw new Error("missing command key");
      const completed = { ...current, status: "completed" as const };
      commands().set(key, completed);
      return structuredClone(completed);
    }
  };
  const cached = new Map<string, ComposeNetworkAttachmentReceiptV1>();
  let dispatches = 0;
  const transport = {
    available: () => true,
    dispatchComposeNetworkAttachment: async (prepared: PreparedComposeAttachmentCommand): Promise<ComposeNetworkAttachmentReceiptV1> => {
      dispatches++;
      const receipt = composeNetworkAttachmentReceiptSchema.parse({ schemaVersion: 1, action: "compose.network.attachment", agentId: prepared.agentId,
        commandId: prepared.command.id, projectId: "project-1", inputDigest: prepared.command.inputDigest, correlationId: prepared.command.correlationId,
        key: "backend", runtimeName: preview.networks[0]!.runtimeName, service: "app", attachmentAction: "attach", containerId: "c".repeat(64),
        resourceId: "b".repeat(64), beforeStateDigest: observation.stateDigest, afterStateDigest: "d".repeat(64), observedAt: 1_011,
        status: "attached", reconciled: false, redacted: true, reason: null });
      cached.set(prepared.command.id, receipt);
      return receipt;
    },
    readComposeNetworkAttachmentReceipt: async (prepared: PreparedComposeAttachmentCommand) => cached.get(prepared.command.id) ?? null
  };
  const user = { id: "attach-user", email: "attach@example.test", emailNormalized: "attach@example.test", passwordHash: "unused-fixture-hash", role,
    status: "active" as const, createdAt: new Date(), updatedAt: new Date() };
  await sessions.create({ userId: user.id, tokenHash: hashSessionToken("attachment-test-session"), expiresAt: new Date("2027-01-01T00:00:00Z") });
  const grants = { listForActor: vi.fn(async (actorId: string) => permission ? [{ id: "attach-grant", actorId, action: "project.update" as const, scope: { kind: "project" as const, projectId: "project-1" } }] : []) };
  const execution = { controls, transport, commandTtlMs: 30_000 };
  const options = { env: { NODE_ENV: "test", DEPLOYLITE_SECRET_KEY: "attachment_fixture_secret_key_1234567890" }, corsOrigin: false, imagePolicy: policy,
    authConfig: { cookieName: "attach_session", cookieSecure: false }, auth: { users: new InMemoryAuthUserRepository([user]), sessions, audit },
    state: { projects, envSecretValues: secrets, controlGrants: grants }, composeResourceInspection: new Map([["project-1", access]]),
    composeNetworkAttachmentExecutions: new Map([["project-1", execution]]) } as OptionsWithAttachment;
  const app = await buildApiApp(options as BuildApiAppOptions); apps.push(app); audit.inputs.length = 0; audit.events.length = 0; grants.listForActor.mockClear();
  const body = { document, kind: "network", key: "backend", service: "app", action: "attach", expectedConfigDigest: preview.configDigest,
    expectedStateDigest: observation.stateDigest, expectedContainerId: "c".repeat(64) };
  const post = (payload: unknown = body, idempotencyKey = "attachment-once", session = true) => app.inject({ method: "POST",
    url: "/api/v1/projects/project-1/compose/attachments/apply", headers: { ...(session ? { cookie: "attach_session=attachment-test-session" } : {}), "idempotency-key": idempotencyKey },
    payload: payload as Record<string, unknown> });
  return { app, post, body, access, observation, seal, inspect, audit, commands, dispatches: () => dispatches, cached };
}

describe("project-scoped Compose network attachment apply API", () => {
  it("applies a fresh stopped-service proposal through the shared command and replays its receipt", async () => {
    const f = await fixture(), first = await f.post();
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data.attachment).toMatchObject({ status: "attached", redacted: true, projectId: "project-1", key: "backend", service: "app" });
    expect(f.dispatches()).toBe(1);
    expect([...f.commands().values()]).toContainEqual(expect.objectContaining({ action: "project.update", status: "completed", projectExecutionAuthority: expect.any(Object) }));
    expect(f.audit.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ action: "compose.resource.attachment.executed", targetId: "project-1" })]));
    const inspections = f.inspect.mock.calls.length, retry = await f.post();
    expect(retry.statusCode, retry.body + JSON.stringify(f.audit.inputs)).toBe(200);
    expect(retry.json().data.attachment).toEqual(first.json().data.attachment);
    expect(f.dispatches()).toBe(1);
    expect(f.inspect).toHaveBeenCalledTimes(inspections);
  });
  it("requires project.update authorization before observation and command claim", async () => {
    const denied = await fixture({ permission: false }), response = await denied.post();
    expect(response.statusCode).toBe(403);
    expect(denied.inspect).not.toHaveBeenCalled();
    expect([...denied.commands().values()]).toHaveLength(0);
    const noSession = await fixture(), unauthenticated = await noSession.post(noSession.body, "attachment-once", false);
    expect(unauthenticated.statusCode).toBe(401);
    expect(noSession.inspect).not.toHaveBeenCalled();
  });
});
