import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { COMPOSE_RESOURCE_INSPECTION_CAPABILITY,
  composeResourceObservationSchema, composeVolumeAttachmentApplyInputSchema, composeVolumeAttachmentExecutionRequestSchema,
  composeVolumeAttachmentReceiptSchema, FenceError, type ComposeVolumeAttachmentExecutionRequestV1, type ComposeVolumeAttachmentReceiptV1,
  type ProjectControlAuthorityV1 } from "@deploylite/contracts";
import { awaitAbortable, ComposeResourceInspectionError, ComposeVolumeAttachmentPlanError, composeVolumeAttachmentExecutionDigest,
  createComposeVolumeAttachmentReplacementPlan, createControlCommand, digestControlInput, digestComposeResourceObservation,
  IdempotencyConflictError, PolicyEvaluator, type AuditEventInput, type AuditRepository, type ControlCommand,
  type ControlGrantRepository, type EnvSecretValueRepository, type ProjectRepository,
  type ProjectUpdateControlRepository, type ComposeRevisionSaveStore } from "@deploylite/domain";
import type { EnvSecretCipher } from "@deploylite/config";
import type { ComposeResourceInspectionAccess } from "./compose-resource-inspection-route.js";
import type { PreparedComposeVolumeAttachmentCommand } from "./agent-transport.js";

export type ComposeVolumeAttachmentAgentTransport = Readonly<{
  available(): boolean;
  dispatchComposeVolumeAttachment(prepared: PreparedComposeVolumeAttachmentCommand, authority: ProjectControlAuthorityV1,
    context: Readonly<{ requestId: string; correlationId: string; signal?: AbortSignal }>): Promise<ComposeVolumeAttachmentReceiptV1>;
  readComposeVolumeAttachmentReceipt(prepared: PreparedComposeVolumeAttachmentCommand, authority: ProjectControlAuthorityV1,
    context: Readonly<{ requestId: string; correlationId: string; signal?: AbortSignal }>): Promise<ComposeVolumeAttachmentReceiptV1 | null>;
}>;
export type ComposeVolumeAttachmentExecutionAccess = Readonly<{ controls: ProjectUpdateControlRepository; transport: ComposeVolumeAttachmentAgentTransport; commandTtlMs: number }>;
type Options = Readonly<{
  prefix: string; projects: ProjectRepository; grants: ControlGrantRepository; audit: AuditRepository; revisions?: ComposeRevisionSaveStore;
  secrets?: EnvSecretValueRepository; secretCipher?: EnvSecretCipher; imagePolicy: import("@deploylite/contracts").ImageReferencePolicyV1;
  access?: ReadonlyMap<string, ComposeResourceInspectionAccess>; execution?: ReadonlyMap<string, ComposeVolumeAttachmentExecutionAccess>;
  requireAuth: import("fastify").preHandlerAsyncHookHandler; requireRole: import("fastify").preHandlerAsyncHookHandler;
  ok(request: import("fastify").FastifyRequest, data: unknown): unknown; error(request: import("fastify").FastifyRequest, code: string, message: string): unknown;
}>;
const identity = /^[A-Za-z0-9_-]{1,200}$/;
function fail(code: ConstructorParameters<typeof ComposeResourceInspectionError>[0]): never { throw new ComposeResourceInspectionError(code); }
function validateControl(command: ControlCommand, actorId: string, projectId: string, idempotencyKey: string): void {
  if (command.actorId !== actorId || command.action !== "project.update" || command.scope.kind !== "project" || command.scope.projectId !== projectId
    || command.idempotencyKey !== idempotencyKey || !(command.expiresAt instanceof Date) || !Number.isSafeInteger(command.expiresAt.valueOf())) throw new FenceError("Project update volume replacement scope rejected");
}
function authorityFor(command: ControlCommand, projectId: string): ProjectControlAuthorityV1 | null {
  const authority = command.projectExecutionAuthority;
  if (!authority) return null;
  if (authority.action !== "project.update" || authority.projectId !== projectId || authority.commandId !== command.id
    || authority.inputDigest !== command.inputDigest || authority.projectLease.projectId !== projectId) throw new FenceError("Project update volume replacement authority scope rejected");
  return structuredClone(authority);
}
function validateReceipt(raw: unknown, request: ComposeVolumeAttachmentExecutionRequestV1, command: ControlCommand, agentId: string): ComposeVolumeAttachmentReceiptV1 {
  const parsed = composeVolumeAttachmentReceiptSchema.safeParse(raw);
  if (!parsed.success) fail("COMPOSE_INSPECTION_INVALID");
  const receipt = parsed.data;
  if (receipt.agentId !== agentId || receipt.commandId !== command.id || receipt.projectId !== request.projectId
    || receipt.inputDigest !== command.inputDigest || receipt.correlationId !== command.correlationId
    || receipt.key !== request.key || receipt.runtimeName !== request.runtimeName || receipt.service !== request.service
    || receipt.attachmentAction !== request.attachmentAction || receipt.priorContainerId !== request.containerId) fail("COMPOSE_INSPECTION_INVALID");
  return receipt;
}
export function registerComposeVolumeAttachmentExecutionRoute(app: FastifyInstance, options: Options): void {
  app.post(`${options.prefix}/projects/:projectId/compose/volumes/attachment/apply`, { bodyLimit: 1_048_576, preHandler: [options.requireAuth, options.requireRole] }, async (request, reply) => {
    const { projectId } = z.object({ projectId: z.string().regex(identity) }).parse(request.params), actorId = request.auth!.user.id;
    const auditFailure = (reason: string) => options.audit.append({ actorUserId: actorId, action: "compose.volume.attachment.rejected", targetType: "project", targetId: projectId,
      ...request.correlationContext, metadata: { projectId, reason } });
    const idempotencyKey = request.headers["idempotency-key"], parsed = composeVolumeAttachmentApplyInputSchema.safeParse(request.body);
    if (!parsed.success || typeof idempotencyKey !== "string" || !identity.test(idempotencyKey)) {
      await auditFailure("invalid-request"); return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
    }
    const input = { ...parsed.data, projectId };
    const decision = new PolicyEvaluator().evaluate({ actorId, role: request.auth!.user.role, action: "project.update", scope: { kind: "project", projectId },
      correlationId: request.correlationContext.correlationId, grants: await options.grants.listForActor(actorId) });
    if (!decision.allowed) { await auditFailure(decision.code); return reply.code(403).send(options.error(request, decision.code, "Volume attachment is not authorized.")); }
    if (!await options.projects.findById(projectId)) return reply.code(404).send(options.error(request, "NOT_FOUND", "Project was not found."));
    const inspection = options.access?.get(projectId), execution = options.execution?.get(projectId);
    if (!inspection || !execution || !inspection.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY) || !execution.transport.available()
      || !options.revisions?.available() || !options.secrets || !options.secretCipher
      || !Number.isSafeInteger(inspection.deadlineMs) || inspection.deadlineMs < 1 || inspection.deadlineMs > 60_000
      || !Number.isSafeInteger(execution.commandTtlMs) || execution.commandTtlMs < 1 || execution.commandTtlMs > 60_000) {
      await auditFailure("capability-unavailable");
      return reply.code(503).send(options.error(request, "COMPOSE_ATTACHMENT_UNSUPPORTED", "Volume attachment is unavailable or outside the supported policy."));
    }
    const revisions = options.revisions, secrets = options.secrets, secretCipher = options.secretCipher, controls = execution.controls, transport = execution.transport;
    const capturedInspection = { ...inspection, imagePolicy: structuredClone(options.imagePolicy) };
    const current = () => {
      if (options.access?.get(projectId) !== inspection || options.execution?.get(projectId) !== execution || execution.controls !== controls || execution.transport !== transport
        || inspection.owner !== capturedInspection.owner || inspection.agentId !== capturedInspection.agentId || inspection.inspector !== capturedInspection.inspector
        || inspection.clock !== capturedInspection.clock || inspection.deadlineMs !== capturedInspection.deadlineMs || inspection.maxAgeMs !== capturedInspection.maxAgeMs
        || !inspection.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY) || digestControlInput(options.imagePolicy) !== digestControlInput(capturedInspection.imagePolicy)
        || !transport.available()) fail("COMPOSE_RESOURCE_STALE");
    };
    const controller = new AbortController(), cancel = () => controller.abort(new ComposeResourceInspectionError("COMPOSE_INSPECTION_CANCELED"));
    const timer = setTimeout(cancel, inspection.deadlineMs); request.raw.once("aborted", cancel); if (request.raw.aborted) cancel();
    const context = { requestId: request.correlationContext.requestId, correlationId: request.correlationContext.correlationId, signal: controller.signal };
    const freshObservation = async (preview: import("@deploylite/contracts").ComposePreviewV1, kind: "network" | "volume", key: string) => {
      const observation = composeResourceObservationSchema.parse(await awaitAbortable(() => inspection.inspector.inspect({ preview, kind, key }, controller.signal, context), controller.signal));
      if (digestComposeResourceObservation(observation) !== observation.stateDigest || observation.owner !== inspection.owner || observation.agentId !== inspection.agentId
        || observation.projectId !== projectId || observation.kind !== kind || observation.key !== key
        || observation.runtimeName !== (kind === "network" ? preview.networks : preview.volumes).find(item => item.key === key)?.runtimeName
        || observation.configDigest !== preview.configDigest || !Number.isSafeInteger(inspection.clock.now())
        || inspection.clock.now() < observation.observedAt || inspection.clock.now() - observation.observedAt > inspection.maxAgeMs) fail("COMPOSE_RESOURCE_STALE");
      return observation;
    };
    const constructPrepared = async () => {
      const prior = await awaitAbortable(() => revisions.findRevision(projectId, input.priorRevisionId), controller.signal);
      const next = await awaitAbortable(() => revisions.findRevision(projectId, input.revisionId), controller.signal);
      if (!prior || !next) fail("COMPOSE_RESOURCE_STALE");
      const plan = createComposeVolumeAttachmentReplacementPlan({ priorRevision: prior, revision: next, service: input.service, key: input.key,
        attachmentAction: input.attachmentAction }, capturedInspection.imagePolicy);
      const oldService = prior.preview.services.find(value => value.name === input.service);
      if (!oldService) fail("COMPOSE_ATTACHMENT_UNSUPPORTED");
      const encrypted = await awaitAbortable(() => secrets.listEncryptedByProject(projectId), controller.signal);
      const environmentSeed: Record<string, string> = {};
      for (const reference of plan.secretRefs) {
        const value = encrypted.find(record => record.key === reference.secretRefId && record.scope === "project" && record.valuePresent);
        if (!value) fail("COMPOSE_ATTACHMENT_UNSUPPORTED");
        try {
          const plaintext = secretCipher.decrypt(value.encryptedValue.toString("base64"));
          if (secretCipher.fingerprint(plaintext) !== value.valueFingerprint) fail("COMPOSE_ATTACHMENT_UNSUPPORTED");
          environmentSeed[reference.key] = plaintext;
        } catch { fail("COMPOSE_ATTACHMENT_UNSUPPORTED"); }
      }
      const environment = Object.fromEntries(Object.entries(environmentSeed).sort(([a], [b]) => a.localeCompare(b)));
      const secretDigest = createHash("sha256").update(JSON.stringify(environment)).digest("hex");
      const request = composeVolumeAttachmentExecutionRequestSchema.parse({ schemaVersion: 1, action: "project.update", scope: { kind: "project", projectId },
        operation: "compose.resource.attachment", idempotencyKey, correlationId: context.correlationId, projectId,
        priorRevisionId: prior.id, revisionId: next.id, priorConfigDigest: plan.priorConfigDigest, configDigest: plan.configDigest,
        stateDigest: input.expectedStateDigest, secretDigest, priorCanonicalDocument: plan.priorCanonicalDocument, canonicalDocument: plan.canonicalDocument,
        key: plan.key, runtimeName: plan.runtimeName, service: plan.service, attachmentAction: plan.attachmentAction, containerId: input.expectedContainerId });
      const inputDigest = composeVolumeAttachmentExecutionDigest(request);
      const existing = await awaitAbortable(() => controls.findProjectUpdateByIdempotency(actorId, projectId, idempotencyKey), controller.signal);
      if (!existing?.projectExecutionAuthority) {
        const latest = await awaitAbortable(() => revisions.findLatestRevision(projectId, next.composeId), controller.signal);
        if (!latest || latest.id !== next.id || prior.composeId !== next.composeId || prior.number + 1 !== next.number) fail("COMPOSE_RESOURCE_STALE");
        const volumeObservation = await freshObservation(prior.preview, "volume", input.key);
        if (volumeObservation.stateDigest !== input.expectedStateDigest) fail("COMPOSE_RESOURCE_STALE");
        const target = volumeObservation.containers.filter(value => value.service === input.service);
        const selectedMounts = oldService.volumes.map(value => ({ target: value.target, readOnly: value.readOnly }));
        if (target.length !== 1 || target[0]!.containerId !== input.expectedContainerId || !target[0]!.running
          || target[0]!.composeRevisionId !== prior.id || target[0]!.composeConfigDigest !== prior.preview.configDigest
          || target[0]!.attached !== (input.attachmentAction === "detach") || JSON.stringify(target[0]!.mounts) !== JSON.stringify(selectedMounts)
          || target[0]!.composeEnvironmentDigest !== secretDigest || volumeObservation.containers.some(value => value.service !== input.service && value.attached)) fail("COMPOSE_RESOURCE_STALE");
        const networkKey = oldService.networks[0]!;
        const networkObservation = await freshObservation(prior.preview, "network", networkKey);
        const networkTarget = networkObservation.containers.filter(value => value.service === input.service);
        const runtimeNetwork = prior.preview.networks.find(value => value.key === networkKey)?.runtimeName;
        if (!runtimeNetwork || networkTarget.length !== 1 || networkTarget[0]!.containerId !== input.expectedContainerId || !networkTarget[0]!.attached
          || target[0]!.networks?.length !== 1 || target[0]!.networks[0]!.name !== runtimeNetwork
          || target[0]!.networks[0]!.networkId !== networkObservation.physicalIdentity) fail("COMPOSE_RESOURCE_STALE");
        current();
      }
      let command: ControlCommand;
      if (existing) {
        validateControl(existing, actorId, projectId, idempotencyKey);
        if (existing.inputDigest !== inputDigest) throw new IdempotencyConflictError();
        command = existing;
      } else {
        const payload = Object.fromEntries(Object.entries(request).filter(([field]) => field !== "idempotencyKey" && field !== "correlationId"));
        const proposed = { ...createControlCommand({ actorId, action: request.action, scope: request.scope, input: payload, idempotencyKey,
          correlationId: request.correlationId, expiresAt: new Date(inspection.clock.now() + execution.commandTtlMs) }), status: "eligible" as const };
        if (proposed.inputDigest !== inputDigest) throw new IdempotencyConflictError();
        const resolved = await awaitAbortable(() => controls.resolve(proposed), controller.signal);
        command = resolved.command; validateControl(command, actorId, projectId, idempotencyKey);
      }
      if (existing?.projectExecutionAuthority || command.projectExecutionAuthority) {
        const authority = authorityFor(command, projectId);
        if (!authority) throw new FenceError("Project update volume replacement authority is missing");
        const prepared: PreparedComposeVolumeAttachmentCommand = { command, request: { ...request, correlationId: command.correlationId }, agentId: inspection.agentId, environment };
        return { prepared, authority, prior, next, existing: true };
      }
      const prepared: PreparedComposeVolumeAttachmentCommand = { command, request, agentId: inspection.agentId, environment };
      return { prepared, authority: null, prior, next, existing: Boolean(existing) };
    };
    const successAudit = (command: ControlCommand, receipt: ComposeVolumeAttachmentReceiptV1): AuditEventInput => ({ actorUserId: actorId,
      action: "compose.volume.attachment.executed", targetType: "project", targetId: projectId, requestId: context.requestId, correlationId: command.correlationId,
      metadata: { projectId, commandId: command.id, inputDigest: command.inputDigest, priorRevisionId: input.priorRevisionId, revisionId: input.revisionId,
        key: receipt.key, service: receipt.service, attachmentAction: receipt.attachmentAction, priorContainerId: receipt.priorContainerId,
        replacementContainerId: receipt.replacementContainerId, beforeStateDigest: receipt.beforeStateDigest, afterStateDigest: receipt.afterStateDigest,
        status: receipt.status, reconciled: receipt.reconciled } });
    try {
      current();
      const preparedState = await constructPrepared();
      let { prepared, authority } = preparedState;
      let command = prepared.command;
      const commandContext = { ...context, correlationId: command.correlationId };
      if (authority) {
        const cached = await awaitAbortable(() => transport.readComposeVolumeAttachmentReceipt(prepared, authority!, commandContext), controller.signal);
        current();
        if (cached) {
          const receipt = validateReceipt(cached, prepared.request, command, prepared.agentId);
          if (command.status !== "completed") {
            const completed = await awaitAbortable(() => controls.completeProjectUpdate(command, authority!, successAudit(command, receipt)), controller.signal);
            if (completed.status !== "completed") fail("COMPOSE_INSPECTION_FAILED");
          }
          return options.ok(request, { attachment: receipt });
        }
        if (command.status === "completed") fail("COMPOSE_INSPECTION_FAILED");
      }
      if (!authority) {
        if (command.status !== "eligible") fail("COMPOSE_RESOURCE_STALE");
        if (command.expiresAt.valueOf() <= inspection.clock.now()) fail("COMPOSE_RESOURCE_STALE");
        const claimed = await awaitAbortable(() => controls.claimProjectUpdate(command), controller.signal);
        command = claimed.command;
        authority = claimed.authority ?? authorityFor(command, projectId);
      }
      if (!authority || authority.projectId !== projectId || authority.commandId !== command.id || authority.inputDigest !== command.inputDigest
        || authority.projectLease.expiresAt <= inspection.clock.now()) fail("COMPOSE_RESOURCE_STALE");
      prepared = { ...prepared, command, request: { ...prepared.request, correlationId: command.correlationId } };
      const dispatchContext = { ...context, correlationId: command.correlationId };
      current();
      let receipt = await awaitAbortable(() => transport.readComposeVolumeAttachmentReceipt(prepared, authority!, dispatchContext), controller.signal);
      if (!receipt) {
        try { receipt = await awaitAbortable(() => transport.dispatchComposeVolumeAttachment(prepared, authority!, dispatchContext), controller.signal); }
        catch (dispatchError) {
          if (controller.signal.aborted) throw dispatchError;
          const recovered = await awaitAbortable(() => transport.readComposeVolumeAttachmentReceipt(prepared, authority!, dispatchContext), controller.signal);
          if (!recovered) throw dispatchError;
          receipt = recovered;
        }
      }
      current();
      const terminal = validateReceipt(receipt, prepared.request, command, prepared.agentId);
      const completed = await awaitAbortable(() => controls.completeProjectUpdate(command, authority!, successAudit(command, terminal)), controller.signal);
      if (completed.status !== "completed") fail("COMPOSE_INSPECTION_FAILED");
      return options.ok(request, { attachment: terminal });
    } catch (error) {
      const code = error instanceof ComposeResourceInspectionError ? error.code : error instanceof ComposeVolumeAttachmentPlanError ? error.code
        : error instanceof IdempotencyConflictError ? "IDEMPOTENCY_CONFLICT" : error instanceof FenceError ? "COMPOSE_ATTACHMENT_CONFLICT" : "COMPOSE_INSPECTION_FAILED";
      const conflict = ["IDEMPOTENCY_CONFLICT", "COMPOSE_RESOURCE_STALE", "COMPOSE_RESOURCE_IN_USE", "COMPOSE_RESOURCE_FOREIGN", "COMPOSE_ATTACHMENT_CONFLICT"].includes(code);
      await auditFailure(code);
      return reply.code(code === "COMPOSE_ATTACHMENT_FORBIDDEN" ? 403 : conflict ? 409 : 503)
        .send(options.error(request, code, "Volume attachment is unavailable or outside the supported policy."));
    } finally { clearTimeout(timer); request.raw.off("aborted", cancel); }
  });
}
