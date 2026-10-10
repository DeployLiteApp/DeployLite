import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { deploymentSchema, transportPortApplyReceiptSchema, transportPortPreviewRequestSchema, transportPortRollbackRequestSchema,
  trustedPriorExecutionReceiptSchema, type ProjectControlAuthorityV1, type TransportPortApplyReceiptV1, type TransportPortBindingV1, type TransportPortIntentV1,
  type TransportPortTransferV1 } from "@deploylite/contracts";
import { createControlCommand, digestControlInput, IdempotencyConflictError, PolicyEvaluator, TransportPortPlanError,
  createTransportPortPlan, type AuditRepository, type ControlCommand, type ControlGrantRepository, type DeploymentRepository,
  type PreparedTransportPortApplyCommand, type ProjectRepository, type ProjectUpdateControlRepository, type TransportPortApplyCompletionStore,
  type TransportPortClaimReader, type TransportPortPlanV1, type CanonicalRoleName } from "@deploylite/domain";
import { z } from "zod";
import { isAgentPreDispatchRejection } from "./agent-transport.js";
import type { TransportPortApplyAgentTransport } from "./transport-port-apply-transport.js";

export type TransportPortApplyExecutionAccess = Readonly<{ controls: ProjectUpdateControlRepository; transport: TransportPortApplyAgentTransport; commandTtlMs: number; agentId: string }>;
type Request = FastifyRequest & { auth?: { user: { id: string; role: CanonicalRoleName } }; correlationContext?: { requestId: string; correlationId: string } };
type Options = Readonly<{ prefix: string; projects: ProjectRepository; deployments: DeploymentRepository; claims?: TransportPortClaimReader;
  applyStore?: TransportPortApplyCompletionStore; executions?: ReadonlyMap<string, TransportPortApplyExecutionAccess>; grants: ControlGrantRepository; audit: AuditRepository;
  requireAuth: preHandlerAsyncHookHandler; requireRole: preHandlerAsyncHookHandler; ok(request: unknown, data: unknown): unknown;
  error(request: unknown, code: string, message: string): unknown; now?: () => Date }>;

const identity = /^[A-Za-z0-9_-]{1,200}$/;
const paramsSchema = z.object({ projectId: z.string().regex(identity) }).strict();
const keySchema = z.string().regex(identity);
const sortBindings = (rows: TransportPortBindingV1[]) => [...rows].sort((left, right) => left.protocol.localeCompare(right.protocol) || left.publishedPort - right.publishedPort);
function authorityFor(command: ControlCommand, projectId: string): ProjectControlAuthorityV1 | null {
  const authority = command.projectExecutionAuthority;
  if (!authority || command.action !== "project.update" || command.scope.kind !== "project" || command.scope.projectId !== projectId
    || authority.projectId !== projectId || authority.commandId !== command.id || authority.inputDigest !== command.inputDigest) return null;
  return structuredClone(authority);
}
function matchesReceipt(receipt: TransportPortApplyReceiptV1, route: TransportPortIntentV1, operation: "apply" | "rollback", revisionId: string | null,
  commandId: string, correlationId: string, portTransfer?: TransportPortTransferV1): boolean {
  return receipt.commandId === commandId && receipt.correlationId === correlationId && receipt.projectId === route.projectId
    && receipt.deploymentId === route.deploymentId && receipt.protocol === route.protocol && receipt.publishedPort === route.publishedPort
    && receipt.targetPort === route.targetPort && receipt.operation === operation && receipt.rollbackRevisionId === revisionId
    && (portTransfer === undefined ? receipt.portTransfer === undefined : receipt.state === "failed" ? receipt.portTransfer === undefined
      : receipt.portTransfer?.sourceDeploymentId === portTransfer.sourceDeploymentId
        && receipt.portTransfer.sourceContainerId !== portTransfer.sourceContainerId);
}
function storedReceipt(command: ControlCommand, route?: TransportPortIntentV1, operation?: "apply" | "rollback", revisionId?: string | null): TransportPortApplyReceiptV1 | null {
  if (command.status !== "completed") return null;
  const parsed = transportPortApplyReceiptSchema.safeParse(command.result);
  if (!parsed.success || parsed.data.commandId !== command.id || (route && !matchesReceipt(parsed.data, route, operation!, revisionId!, command.id, command.correlationId))) {
    throw new Error("transport-port-receipt-invalid");
  }
  return parsed.data;
}

/** Authorized, idempotent TCP/UDP apply and revision-based rollback. Runtime changes go only through the authenticated agent. */
export function registerTransportPortApplyRoutes(app: FastifyInstance, options: Options): void {
  app.post(`${options.prefix}/projects/:projectId/transport-ports/apply`, { bodyLimit: 65_536, preHandler: [options.requireAuth, options.requireRole] },
    async (raw, reply) => handle(raw as Request, reply, "apply"));
  app.post(`${options.prefix}/projects/:projectId/transport-ports/rollback`, { bodyLimit: 65_536, preHandler: [options.requireAuth, options.requireRole] },
    async (raw, reply) => handle(raw as Request, reply, "rollback"));

  async function handle(request: Request, reply: import("fastify").FastifyReply, operation: "apply" | "rollback") {
    const auth = request.auth, context = request.correlationContext;
    if (!auth || !context) return reply.code(401).send(options.error(request, "UNAUTHENTICATED", "Authentication required."));
    const params = paramsSchema.safeParse(request.params);
    const body = operation === "apply" ? transportPortPreviewRequestSchema.safeParse(request.body) : transportPortRollbackRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
    const projectId = params.data.projectId, idempotencyKey = keySchema.safeParse(request.headers["x-control-idempotency-key"]);
    if (!idempotencyKey.success) return reply.code(400).send(options.error(request, "IDEMPOTENCY_KEY_REQUIRED", "A bounded idempotency key is required."));
    const protocol = body.data.protocol, publishedPort = body.data.publishedPort;
    const audit = async (action: string, metadata: Record<string, unknown> = {}): Promise<boolean> => {
      try { await options.audit.append({ actorUserId: auth.user.id, action, targetType: "project", targetId: projectId,
        requestId: context.requestId, correlationId: context.correlationId, metadata: { projectId, protocol, publishedPort, ...metadata } }); return true; }
      catch { return false; }
    };
    const unavailable = async (reason: string) => { await audit(`transport.port.${operation}.unavailable`, { reason });
      return reply.code(503).send(options.error(request, "TRANSPORT_PORT_APPLY_UNAVAILABLE", "TCP/UDP apply is unavailable.")); };
    let grants;
    try { grants = await options.grants.listForActor(auth.user.id); } catch { return unavailable("grant-storage-unavailable"); }
    const decision = new PolicyEvaluator().evaluate({ actorId: auth.user.id, role: auth.user.role, action: "project.update",
      scope: { kind: "project", projectId }, correlationId: context.correlationId, grants });
    if (!decision.allowed) {
      if (!await audit(`transport.port.${operation}.denied`, { reason: decision.code })) return unavailable("audit-unavailable");
      return reply.code(403).send(options.error(request, decision.code, "TCP/UDP apply is not authorized."));
    }
    const claims = options.claims, store = options.applyStore, execution = options.executions?.get(projectId);
    let claimsReady = false, storeReady = false;
    try { claimsReady = claims?.available() === true; storeReady = store?.available() === true; } catch { /* fail closed */ }
    if (!claims || !claimsReady || !store || !storeReady || !execution || !execution.transport.available()
      || !Number.isSafeInteger(execution.commandTtlMs) || execution.commandTtlMs < 1 || execution.commandTtlMs > 60_000) return unavailable("port-capability-unavailable");

    const key = idempotencyKey.data;
    let command: ControlCommand | null;
    try { command = await execution.controls.findProjectUpdateByIdempotency(auth.user.id, projectId, key); }
    catch { return unavailable("command-storage-unavailable"); }
    if (command?.status === "completed") {
      try {
        const terminal = storedReceipt(command);
        if (!terminal) return unavailable("terminal-receipt-missing");
        if (terminal.protocol !== protocol || terminal.publishedPort !== publishedPort || terminal.operation !== operation
          || (operation === "apply" && (terminal.deploymentId !== (body.data as z.infer<typeof transportPortPreviewRequestSchema>).deploymentId
            || terminal.targetPort !== (body.data as z.infer<typeof transportPortPreviewRequestSchema>).targetPort))) {
          if (!await audit(`transport.port.${operation}.rejected`, { reason: "idempotency-conflict" })) return unavailable("audit-unavailable");
          return reply.code(409).send(options.error(request, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with different port input."));
        }
        return reply.code(200).send(options.ok(request, { command, operation, receipt: terminal, applied: terminal.state !== "failed", idempotent: true }));
      } catch { return unavailable("terminal-receipt-invalid"); }
    }

    let currentClaims;
    try { currentClaims = await claims.listClaims(); } catch { return unavailable("claim-state-unavailable"); }
    let route: TransportPortIntentV1 | null = null, plan: TransportPortPlanV1 | null = null, rollbackRevisionId: string | null = null;
    let currentContainerId: string | null = null, bindings: TransportPortBindingV1[] | null = null, previousBindings: TransportPortBindingV1[] | null = null;
    let portTransfer: TransportPortTransferV1 | undefined;
    if (command?.status === "dispatching") {
      try {
        const reservation = await store.findTransportPortReservation(command.id);
        if (!reservation || reservation.operation !== operation || reservation.route.protocol !== protocol || reservation.route.publishedPort !== publishedPort) return unavailable("reservation-missing");
        if (operation === "apply" && (reservation.route.deploymentId !== (body.data as z.infer<typeof transportPortPreviewRequestSchema>).deploymentId
          || reservation.route.targetPort !== (body.data as z.infer<typeof transportPortPreviewRequestSchema>).targetPort)) return reply.code(409).send(options.error(request, "IDEMPOTENCY_CONFLICT", "Port input differs from its durable command."));
        route = reservation.route; plan = reservation.plan; rollbackRevisionId = reservation.rollbackRevisionId;
        currentContainerId = reservation.currentContainerId; bindings = reservation.bindings; previousBindings = reservation.previousBindings;
        portTransfer = reservation.portTransfer;
      } catch { return unavailable("reservation-invalid"); }
    } else if (operation === "apply") {
      const apply = body.data as z.infer<typeof transportPortPreviewRequestSchema>;
      let deployment;
      try { deployment = await options.deployments.findById(apply.deploymentId); } catch { return unavailable("deployment-storage-unavailable"); }
      if (!deployment) return reply.code(404).send(options.error(request, "NOT_FOUND", "Port target deployment was not found."));
      route = { schemaVersion: 1, projectId, deploymentId: apply.deploymentId, protocol, publishedPort, targetPort: apply.targetPort };
    } else {
      try {
        const target = await store.findRollbackTarget(projectId, protocol, publishedPort);
        if (!target) {
          if (!await audit("transport.port.rollback.rejected", { reason: "prior-binding-not-found" })) return unavailable("audit-unavailable");
          return reply.code(409).send(options.error(request, "TRANSPORT_PORT_NO_ROLLBACK", "No prior TCP/UDP binding is available to restore."));
        }
        rollbackRevisionId = target.id;
        route = { schemaVersion: 1, projectId, deploymentId: target.deploymentId, protocol, publishedPort, targetPort: target.targetPort };
      } catch { return unavailable("revision-state-invalid"); }
    }
    if (!route) return unavailable("route-unavailable");

    let rawDeployment;
    try { rawDeployment = await options.deployments.findById(route.deploymentId); } catch { return unavailable("deployment-storage-unavailable"); }
    const parsedDeployment = deploymentSchema.safeParse(rawDeployment);
    if (!parsedDeployment.success) return unavailable("target-state-invalid");
    const deployment = parsedDeployment.data, proof = trustedPriorExecutionReceiptSchema.safeParse(deployment.executionReceipt);
    const effectiveImage = deployment.stopTarget?.effectiveImage;
    const targetVerified = deployment.projectId === projectId && deployment.status === "succeeded" && deployment.finishedAt !== null
      && deployment.agentId === execution.agentId && deployment.snapshotHash !== undefined && deployment.snapshotOriginId !== undefined
      && proof.success && effectiveImage !== undefined && proof.data.deploymentId === deployment.id && proof.data.projectId === projectId
      && proof.data.runtimeHost === deployment.agentId && proof.data.snapshotHash === deployment.snapshotHash
      && proof.data.snapshotOriginId === deployment.snapshotOriginId && proof.data.candidateId === deployment.stopTarget?.candidateId
      && proof.data.effectiveImageDigest === effectiveImage.split("@")[1];
    if (!targetVerified || !proof.success || !effectiveImage) {
      if (!await audit(`transport.port.${operation}.rejected`, { reason: "target-receipt-unverified", deploymentId: route.deploymentId })) return unavailable("audit-unavailable");
      return reply.code(409).send(options.error(request, "TRANSPORT_PORT_TARGET_UNVERIFIED", "Port target lacks a matching trusted execution receipt."));
    }
    if (protocol === "tcp" && publishedPort === proof.data.hostPort) {
      if (!await audit(`transport.port.${operation}.rejected`, { reason: "runtime-health-port-conflict", deploymentId: route.deploymentId })) return unavailable("audit-unavailable");
      return reply.code(409).send(options.error(request, "TRANSPORT_PORT_CONFLICT", "The published TCP port conflicts with the deployment health port."));
    }
    if (!plan) {
      try {
        plan = createTransportPortPlan({ desired: route, currentClaims });
        if (operation === "rollback" && plan.action !== "retarget") throw new Error("rollback-target-is-current");
      } catch (error) {
        if (error instanceof TransportPortPlanError && (error.code === "port-conflict" || error.code === "ambiguous-claims")) {
          if (!await audit(`transport.port.${operation}.rejected`, { reason: error.code })) return unavailable("audit-unavailable");
          return reply.code(409).send(options.error(request, "TRANSPORT_PORT_CONFLICT", "Protocol and published port conflict with an existing claim."));
        }
        if (operation === "rollback") return reply.code(409).send(options.error(request, "TRANSPORT_PORT_STALE", "The saved port revision is no longer eligible for rollback."));
        return unavailable("claim-state-invalid");
      }
    }
    if (plan.action === "retarget" && plan.previous?.deploymentId !== route.deploymentId && !portTransfer) {
      const sourceDeploymentId = plan.previous?.deploymentId;
      if (!sourceDeploymentId || sourceDeploymentId === route.deploymentId) return unavailable("port-source-invalid");
      let rawSource;
      try { rawSource = await options.deployments.findById(sourceDeploymentId); } catch { return unavailable("source-deployment-storage-unavailable"); }
      const parsedSource = deploymentSchema.safeParse(rawSource);
      if (!parsedSource.success) return unavailable("source-state-invalid");
      const source = parsedSource.data, sourceProof = trustedPriorExecutionReceiptSchema.safeParse(source.executionReceipt);
      const sourceEffectiveImage = source.stopTarget?.effectiveImage;
      const sourceVerified = source.projectId === projectId && source.status === "succeeded" && source.finishedAt !== null
        && source.agentId === execution.agentId && source.snapshotHash !== undefined && source.snapshotOriginId !== undefined
        && sourceProof.success && sourceEffectiveImage !== undefined && sourceProof.data.deploymentId === source.id
        && sourceProof.data.projectId === projectId && sourceProof.data.runtimeHost === source.agentId
        && sourceProof.data.snapshotHash === source.snapshotHash && sourceProof.data.snapshotOriginId === source.snapshotOriginId
        && sourceProof.data.candidateId === source.stopTarget?.candidateId
        && sourceProof.data.effectiveImageDigest === sourceEffectiveImage.split("@")[1];
      if (!sourceVerified || !sourceProof.success || !sourceEffectiveImage) return reply.code(409).send(options.error(request,
        "TRANSPORT_PORT_SOURCE_UNVERIFIED", "The current port owner lacks a matching trusted execution receipt."));
      const sourcePreviousBindings = sortBindings(currentClaims.filter(claim => claim.projectId === projectId && claim.deploymentId === sourceDeploymentId)
        .map(claim => ({ protocol: claim.protocol, publishedPort: claim.publishedPort, targetPort: claim.targetPort })));
      const sourceKey = `${protocol}:${publishedPort}`;
      const sourceBinding = sourcePreviousBindings.find(binding => `${binding.protocol}:${binding.publishedPort}` === sourceKey);
      if (!sourceBinding || sourceBinding.targetPort !== plan.previous?.targetPort) return unavailable("source-claim-state-stale");
      let sourceRuntimeState;
      try { sourceRuntimeState = await store.findTransportPortRuntimeState(projectId, sourceDeploymentId); }
      catch { return unavailable("source-runtime-port-state-invalid"); }
      if (!sourceRuntimeState || sourceRuntimeState.projectId !== projectId || sourceRuntimeState.deploymentId !== sourceDeploymentId
        || JSON.stringify(sortBindings(sourceRuntimeState.bindings)) !== JSON.stringify(sourcePreviousBindings)) {
        return reply.code(409).send(options.error(request, "TRANSPORT_PORT_SOURCE_STATE_STALE", "The current port owner runtime state is unavailable or stale."));
      }
      const sourceBindings = sourcePreviousBindings.filter(binding => `${binding.protocol}:${binding.publishedPort}` !== sourceKey);
      if (sourceBindings.length > 128) return unavailable("source-binding-limit-exceeded");
      portTransfer = { sourceDeploymentId, sourceContainerId: sourceRuntimeState.containerId, sourcePreviousBindings, sourceBindings,
        sourceExecutionReceipt: sourceProof.data, sourceEffectiveImage };
    } else if (plan.action !== "retarget" || plan.previous?.deploymentId === route.deploymentId) {
      if (portTransfer) return unavailable("unexpected-port-transfer-reservation");
    }

    if (!bindings || !previousBindings || !currentContainerId) {
      previousBindings = sortBindings(currentClaims.filter(claim => claim.projectId === projectId && claim.deploymentId === route!.deploymentId)
        .map(claim => ({ protocol: claim.protocol, publishedPort: claim.publishedPort, targetPort: claim.targetPort })));
      currentContainerId = proof.data.containerId;
      let runtimeState;
      try { runtimeState = await store.findTransportPortRuntimeState(projectId, route.deploymentId); }
      catch { return unavailable("runtime-port-state-invalid"); }
      if (runtimeState) {
        if (runtimeState.projectId !== projectId || runtimeState.deploymentId !== route.deploymentId
          || JSON.stringify(sortBindings(runtimeState.bindings)) !== JSON.stringify(previousBindings)) return unavailable("runtime-port-state-stale");
        currentContainerId = runtimeState.containerId;
        previousBindings = sortBindings(runtimeState.bindings);
      }
      const bindingKey = `${protocol}:${publishedPort}`;
      const bindingsMap = new Map(previousBindings.filter(binding => `${binding.protocol}:${binding.publishedPort}` !== bindingKey)
        .map(binding => [`${binding.protocol}:${binding.publishedPort}`, binding]));
      bindingsMap.set(bindingKey, { protocol, publishedPort, targetPort: route.targetPort });
      bindings = sortBindings([...bindingsMap.values()]);
    }
    if (bindings.length > 128) {
      if (!await audit(`transport.port.${operation}.rejected`, { reason: "binding-limit-exceeded", deploymentId: route.deploymentId })) return unavailable("audit-unavailable");
      return reply.code(409).send(options.error(request, "TRANSPORT_PORT_BINDING_LIMIT", "The deployment already has the maximum supported number of transport bindings."));
    }
    const stableInput = { route, executionReceipt: proof.data, effectiveImage, operation, rollbackRevisionId,
      ...(portTransfer ? { portTransfer } : {}) };
    let tentative: ControlCommand;
    try { tentative = { ...createControlCommand({ actorId: auth.user.id, action: "project.update", scope: { kind: "project", projectId },
      input: stableInput, idempotencyKey: key, correlationId: context.correlationId,
      expiresAt: new Date((options.now?.() ?? new Date()).getTime() + execution.commandTtlMs) }), status: "eligible" }; }
    catch { return unavailable("command-preparation-failed"); }
    if (command && command.inputDigest !== tentative.inputDigest) {
      if (!await audit(`transport.port.${operation}.rejected`, { reason: "idempotency-conflict" })) return unavailable("audit-unavailable");
      return reply.code(409).send(options.error(request, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with different port input."));
    }
    if (!command) {
      try { command = (await execution.controls.resolve(tentative)).command; }
      catch (error) {
        if (error instanceof IdempotencyConflictError) return reply.code(409).send(options.error(request, error.code, "Idempotency key was already used with different port input."));
        return unavailable("command-storage-unavailable");
      }
    }
    if (command.status === "completed") {
      try { const terminal = storedReceipt(command, route, operation, rollbackRevisionId);
        if (!terminal) return unavailable("terminal-receipt-missing");
        return reply.code(200).send(options.ok(request, { command, operation, receipt: terminal, applied: terminal.state !== "failed", idempotent: true }));
      } catch { return unavailable("terminal-receipt-invalid"); }
    }

    const preparedBase: PreparedTransportPortApplyCommand = { command, route, bindings, previousBindings, currentContainerId, executionReceipt: proof.data,
      ...(portTransfer ? { portTransfer } : {}), effectiveImage, operation, rollbackRevisionId, agentId: execution.agentId };
    let authority = authorityFor(command, projectId);
    try {
      await store.reserveTransportPortApply({ command, route, plan, operation, rollbackRevisionId, currentContainerId, bindings, previousBindings,
        ...(portTransfer ? { portTransfer } : {}) });
      if (command.status === "eligible") {
        const claimed = await execution.controls.claimProjectUpdate(command);
        command = claimed.command;
        authority = claimed.authority ?? authorityFor(command, projectId);
        if (!claimed.claimed || !authority) {
          await store.releaseTransportPortApply(command.id, protocol, publishedPort);
          return reply.code(409).send(options.error(request, "PROJECT_UPDATE_BUSY", "Another project update currently owns this project."));
        }
      } else if (command.status !== "dispatching" || !authority) return unavailable("command-state-unavailable");
      await execution.controls.validateProjectUpdateAuthority(authority, (options.now?.() ?? new Date()).getTime());
      const prepared = { ...preparedBase, command };
      const agentContext = { requestId: context.requestId, correlationId: command.correlationId };
      let terminal = await execution.transport.readTransportPortApplyReceipt(prepared, authority, agentContext);
      if (!terminal) {
        try { terminal = await execution.transport.dispatchTransportPortApply(prepared, authority, agentContext); }
        catch (dispatchError) {
          if (isAgentPreDispatchRejection(dispatchError)) {
            terminal = transportPortApplyReceiptSchema.parse({ schemaVersion: 1, action: "transport.port.apply", agentId: execution.agentId,
              commandId: command.id, projectId, protocol, publishedPort, targetPort: route.targetPort, deploymentId: route.deploymentId,
              operation, rollbackRevisionId, inputDigest: command.inputDigest, correlationId: command.correlationId, containerId: null,
              state: "failed", observedAt: Math.max(0, (options.now?.() ?? new Date()).getTime()), failureReason: "docker-unavailable", redacted: true });
          } else {
            const recovered = await execution.transport.readTransportPortApplyReceipt(prepared, authority, agentContext);
            if (!recovered) throw dispatchError;
            terminal = recovered;
          }
        }
      }
      if (!matchesReceipt(terminal, route, operation, rollbackRevisionId, command.id, command.correlationId, portTransfer) || terminal.agentId !== execution.agentId
        || terminal.inputDigest !== command.inputDigest) throw new Error("transport-port-receipt-invalid");
      const auditAction = terminal.state === "failed" ? operation === "rollback" ? "transport.port.rollback.failed" : "transport.port.apply.failed"
        : operation === "rollback" ? "transport.port.rolled_back" : "transport.port.applied";
      const auditInput = { actorUserId: auth.user.id, action: auditAction, targetType: "project", targetId: projectId,
        requestId: context.requestId, correlationId: command.correlationId,
        metadata: { projectId, protocol, publishedPort, targetPort: route.targetPort, deploymentId: route.deploymentId,
          ...(portTransfer ? { sourceDeploymentId: portTransfer.sourceDeploymentId } : {}),
          agentId: execution.agentId, commandId: command.id, state: terminal.state, failureReason: terminal.failureReason } };
      const completed = await store.completeTransportPortApply({ command, authority, route, plan, operation, rollbackRevisionId, currentContainerId,
        bindings, previousBindings, ...(portTransfer ? { portTransfer } : {}), receipt: terminal, audit: auditInput });
      const revision = await store.findTransportPortRevisionByCommand(command.id);
      if (terminal.state !== "failed" && plan.action !== "no-op" && !revision) return unavailable("transport-port-revision-missing");
      return reply.code(200).send(options.ok(request, { command: completed, operation, route, receipt: terminal, applied: terminal.state !== "failed",
        rolledBack: operation === "rollback" && terminal.state !== "failed", revision, rollbackRevisionId, idempotent: false }));
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return reply.code(409).send(options.error(request, error.code, "Idempotency input conflicts with an earlier port command."));
      if (error instanceof Error && error.message === "transport-port-receipt-invalid") return reply.code(502).send(options.error(request, "TRANSPORT_PORT_RECEIPT_INVALID", "Agent returned invalid port evidence."));
      const storeCode = error instanceof Error && error.name === "TransportPortStoreError" && "code" in error ? (error as Error & { code?: unknown }).code : null;
      if (storeCode === "port-conflict" || storeCode === "stale-plan") {
        if (!await audit(`transport.port.${operation}.rejected`, { reason: storeCode })) return unavailable("audit-unavailable");
        return reply.code(409).send(options.error(request, storeCode === "port-conflict" ? "TRANSPORT_PORT_CONFLICT" : "TRANSPORT_PORT_STALE",
          "Port ownership or revision changed before apply."));
      }
      return unavailable(error instanceof Error && error.name === "TransportPortStoreError" ? "port-commit-conflict" : "agent-apply-failed");
    }
  }
}
