import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { z } from "zod";
import { deploymentSchema, domainRouteApplyReceiptSchema, domainRoutePreviewRequestSchema, DOMAIN_ROUTE_APPLY_CAPABILITY,
  domainRouteRollbackRequestSchema, transportPortRuntimeStateSchema, trustedPriorExecutionReceiptSchema, type DomainRouteApplyReceiptV1, type DomainRouteIntentV1,
  type ProjectControlAuthorityV1 } from "@deploylite/contracts";
import { createControlCommand, digestControlInput, DomainRoutePlanError, IdempotencyConflictError, PolicyEvaluator,
  createDomainRoutePlan, type AuditRepository, type ControlGrantRepository, type ControlCommand, type DomainRouteApplyCompletionStore,
  type DomainRouteClaimReader, type DomainRoutePlanV1, type DeploymentRepository, type PreparedDomainRouteApplyCommand,
  type TransportPortApplyCompletionStore, type ProjectRepository, type ProjectUpdateControlRepository } from "@deploylite/domain";
import { isAgentPreDispatchRejection } from "./agent-transport.js";

export type DomainRouteApplyAgentTransport = Readonly<{
  available(): boolean;
  dispatchDomainRouteApply(prepared: PreparedDomainRouteApplyCommand, authority: ProjectControlAuthorityV1,
    context: Readonly<{ requestId: string; correlationId: string; signal?: AbortSignal }>): Promise<DomainRouteApplyReceiptV1>;
  readDomainRouteApplyReceipt(prepared: PreparedDomainRouteApplyCommand, authority: ProjectControlAuthorityV1,
    context: Readonly<{ requestId: string; correlationId: string; signal?: AbortSignal }>): Promise<DomainRouteApplyReceiptV1 | null>;
}>;
export type DomainRouteApplyExecutionAccess = Readonly<{ controls: ProjectUpdateControlRepository; transport: DomainRouteApplyAgentTransport; commandTtlMs: number; agentId: string }>;

type Request = FastifyRequest & { auth?: { user: { id: string; role: import("@deploylite/contracts").CanonicalRole } }; correlationContext?: { requestId: string; correlationId: string } };
type Options = Readonly<{
  prefix: string; projects: ProjectRepository; deployments: DeploymentRepository; grants: ControlGrantRepository; audit: AuditRepository;
  claims?: DomainRouteClaimReader; applyStore?: DomainRouteApplyCompletionStore;
  transportRuntime?: Pick<TransportPortApplyCompletionStore, "available" | "findTransportPortRuntimeState">;
  executions?: ReadonlyMap<string, DomainRouteApplyExecutionAccess>;
  requireAuth: preHandlerAsyncHookHandler; requireRole: preHandlerAsyncHookHandler;
  ok(request: unknown, data: unknown): unknown; error(request: unknown, code: string, message: string): unknown;
  now?: () => Date;
}>;

const identity = /^[A-Za-z0-9_-]{1,200}$/;
const paramsSchema = z.object({ projectId: z.string().regex(identity) }).strict();
const keySchema = z.string().regex(identity);

function authorityFor(command: ControlCommand, projectId: string): ProjectControlAuthorityV1 | null {
  const authority = command.projectExecutionAuthority;
  if (!authority || command.action !== "project.update" || command.scope.kind !== "project" || command.scope.projectId !== projectId
    || authority.projectId !== projectId || authority.commandId !== command.id || authority.inputDigest !== command.inputDigest) return null;
  return structuredClone(authority);
}

function validateTerminalReceipt(receipt: unknown, prepared: PreparedDomainRouteApplyCommand): DomainRouteApplyReceiptV1 {
  const parsed = domainRouteApplyReceiptSchema.safeParse(receipt);
  if (!parsed.success || parsed.data.agentId !== prepared.agentId || parsed.data.commandId !== prepared.command.id
    || parsed.data.projectId !== prepared.route.projectId || parsed.data.domain !== prepared.route.domain
    || parsed.data.deploymentId !== prepared.route.deploymentId || parsed.data.inputDigest !== prepared.command.inputDigest
    || parsed.data.correlationId !== prepared.command.correlationId) throw new Error("route-receipt-invalid");
  return parsed.data;
}

function storedReceipt(command: ControlCommand, prepared: PreparedDomainRouteApplyCommand): DomainRouteApplyReceiptV1 | null {
  if (command.status !== "completed") return null;
  const receipt = domainRouteApplyReceiptSchema.safeParse(command.result);
  if (!receipt.success) throw new Error("route-receipt-invalid");
  return validateTerminalReceipt(receipt.data, prepared);
}

async function currentDomainReceipt(receipt: import("@deploylite/contracts").TrustedPriorExecutionReceiptV1, options: Options) {
  if (!options.transportRuntime) return receipt;
  if (!options.transportRuntime.available()) throw new Error("Runtime storage unavailable");
  const row = await options.transportRuntime.findTransportPortRuntimeState(receipt.projectId, receipt.deploymentId);
  if (!row) return receipt;
  const state = transportPortRuntimeStateSchema.parse(row);
  if (state.projectId !== receipt.projectId || state.deploymentId !== receipt.deploymentId) throw new Error("Runtime identity mismatch");
  return trustedPriorExecutionReceiptSchema.parse({...receipt, containerId: state.containerId});
}

export function registerDomainRouteApplyRoute(app: FastifyInstance, options: Options): void {
  app.post(`${options.prefix}/projects/:projectId/domains/apply`, { bodyLimit: 65_536, preHandler: [options.requireAuth, options.requireRole] }, async (rawRequest, reply) => {
    const request = rawRequest as Request;
    const auth = request.auth, context = request.correlationContext;
    if (!auth || !context) return reply.code(401).send(options.error(request, "UNAUTHENTICATED", "Authentication required."));
    const params = paramsSchema.safeParse(request.params), body = domainRoutePreviewRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
    const projectId = params.data.projectId, idempotencyKey = keySchema.safeParse(request.headers["x-control-idempotency-key"]);
    if (!idempotencyKey.success) return reply.code(400).send(options.error(request, "IDEMPOTENCY_KEY_REQUIRED", "A bounded idempotency key is required."));

    const auditFailure = async (action: string, reason: string): Promise<boolean> => {
      try {
        await options.audit.append({ actorUserId: auth.user.id, action, targetType: "project", targetId: projectId,
          requestId: context.requestId, correlationId: context.correlationId,
          metadata: { projectId, domain: body.data.domain, deploymentId: body.data.deploymentId, reason } });
        return true;
      } catch { return false; }
    };
    const unavailable = async (reason: string) => {
      await auditFailure("domain.route.apply.unavailable", reason);
      return reply.code(503).send(options.error(request, "DOMAIN_ROUTE_APPLY_UNAVAILABLE", "Domain route apply is unavailable."));
    };

    let grants;
    try { grants = await options.grants.listForActor(auth.user.id); }
    catch { return unavailable("grant-storage-unavailable"); }
    const decision = new PolicyEvaluator().evaluate({ actorId: auth.user.id, role: auth.user.role, action: "project.update",
      scope: { kind: "project", projectId }, correlationId: context.correlationId, grants });
    if (!decision.allowed) {
      if (!await auditFailure("domain.route.apply.denied", decision.code)) return unavailable("audit-unavailable");
      return reply.code(403).send(options.error(request, decision.code, "Domain route apply is not authorized."));
    }

    let project;
    try { project = await options.projects.findById(projectId); }
    catch { return unavailable("project-storage-unavailable"); }
    if (!project) {
      if (!await auditFailure("domain.route.apply.rejected", "project-not-found")) return unavailable("audit-unavailable");
      return reply.code(404).send(options.error(request, "NOT_FOUND", "Project was not found."));
    }

    const claims = options.claims, store = options.applyStore, execution = options.executions?.get(projectId);
    let claimsReady = false, storeReady = false;
    try { claimsReady = claims?.available() === true; storeReady = store?.available() === true; } catch { /* fail closed below */ }
    if (!claims || !claimsReady || !store || !storeReady || !execution || !execution.transport.available()
      || !Number.isSafeInteger(execution.commandTtlMs) || execution.commandTtlMs < 1 || execution.commandTtlMs > 60_000) return unavailable("route-capability-unavailable");

    const routeCandidate = { schemaVersion: 1 as const, projectId, deploymentId: body.data.deploymentId, domain: body.data.domain };
    let rawDeployment;
    try { rawDeployment = await options.deployments.findById(body.data.deploymentId); }
    catch { return unavailable("deployment-storage-unavailable"); }
    if (!rawDeployment) {
      if (!await auditFailure("domain.route.apply.rejected", "target-not-found")) return unavailable("audit-unavailable");
      return reply.code(404).send(options.error(request, "NOT_FOUND", "Route target deployment was not found."));
    }
    const parsedDeployment = deploymentSchema.safeParse(rawDeployment);
    if (!parsedDeployment.success) return unavailable("target-state-invalid");
    const deployment = parsedDeployment.data;
    if (deployment.projectId !== projectId) {
      if (!await auditFailure("domain.route.apply.rejected", "target-project-mismatch")) return unavailable("audit-unavailable");
      return reply.code(409).send(options.error(request, "DOMAIN_ROUTE_TARGET_CONFLICT", "Route target is not eligible for this project."));
    }
    const receipt = trustedPriorExecutionReceiptSchema.safeParse(deployment.executionReceipt);
    const effectiveImage = deployment.stopTarget?.effectiveImage;
    const targetVerified = receipt.success && effectiveImage !== undefined && deployment.status === "succeeded" && deployment.finishedAt !== null
      && deployment.agentId === execution.agentId
      && deployment.snapshotHash !== undefined && deployment.snapshotOriginId !== undefined
      && receipt.data.deploymentId === deployment.id && receipt.data.projectId === deployment.projectId
      && receipt.data.runtimeHost === deployment.agentId && receipt.data.snapshotHash === deployment.snapshotHash
      && receipt.data.snapshotOriginId === deployment.snapshotOriginId && receipt.data.candidateId === deployment.stopTarget?.candidateId
      && receipt.data.effectiveImageDigest === effectiveImage.split("@")[1];
    if (!targetVerified || !receipt.success || !effectiveImage) {
      if (!await auditFailure("domain.route.apply.rejected", "target-receipt-unverified")) return unavailable("audit-unavailable");
      return reply.code(409).send(options.error(request, "DOMAIN_ROUTE_TARGET_UNVERIFIED", "Route target lacks a matching trusted execution receipt."));
    }
    let command: ControlCommand | null;
    try { command = await execution.controls.findProjectUpdateByIdempotency(auth.user.id, projectId, idempotencyKey.data); }
    catch { return unavailable("command-storage-unavailable"); }
    if (command?.status === "completed") {
      // Replay binds the original execution identity, not a later transport replacement.
      // The digest check below still rejects a different route, proof, or operation.
      const terminal = domainRouteApplyReceiptSchema.safeParse(command.result);
      if (!terminal.success) return unavailable("terminal-receipt-invalid");
      if (terminal.data.targetContainerId !== null) receipt.data = { ...receipt.data, containerId: terminal.data.targetContainerId };
    } else {
      try { receipt.data = await currentDomainReceipt(receipt.data, options); } catch { return unavailable("runtime-port-state-invalid"); }
    }
    const route = { schemaVersion: 1 as const, projectId, deploymentId: deployment.id, domain: body.data.domain } satisfies DomainRouteIntentV1;

    let tentative: ControlCommand;
    try {
      tentative = { ...createControlCommand({ actorId: auth.user.id, action: "project.update", scope: { kind: "project", projectId },
        input: { route, executionReceipt: receipt.data, effectiveImage }, idempotencyKey: idempotencyKey.data,
        correlationId: context.correlationId, expiresAt: new Date((options.now?.() ?? new Date()).getTime() + execution.commandTtlMs) }), status: "eligible" };
    } catch { return unavailable("command-preparation-failed"); }
    const preparedBase: PreparedDomainRouteApplyCommand = { command: tentative, route, executionReceipt: receipt.data, effectiveImage, agentId: execution.agentId };

    if (command && command.inputDigest !== tentative.inputDigest) {
      if (!await auditFailure("domain.route.apply.rejected", "idempotency-conflict")) return unavailable("audit-unavailable");
      return reply.code(409).send(options.error(request, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with different route input."));
    }
    if (command?.status === "completed") {
      try {
        const prepared = { ...preparedBase, command };
        const result = storedReceipt(command, prepared);
        if (!result) return unavailable("terminal-receipt-missing");
        return reply.code(200).send(options.ok(request, { command, route, receipt: result, applied: result.state !== "failed", idempotent: true }));
      } catch { return unavailable("terminal-receipt-invalid"); }
    }

    let plan;
    try {
      const currentClaims = await claims.listClaims();
      plan = createDomainRoutePlan({ desired: routeCandidate, currentClaims });
    } catch (error) {
      if (error instanceof DomainRoutePlanError && (error.code === "domain-conflict" || error.code === "ambiguous-claims")) {
        if (!await auditFailure("domain.route.apply.rejected", error.code)) return unavailable("audit-unavailable");
        return reply.code(409).send(options.error(request, "DOMAIN_ROUTE_CONFLICT", "Domain ownership conflicts with an existing route claim."));
      }
      if (error instanceof DomainRoutePlanError && error.code === "desired-invalid") return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
      return unavailable("claim-state-invalid");
    }
    if (!command) {
      try { command = (await execution.controls.resolve(tentative)).command; }
      catch (error) {
        if (error instanceof IdempotencyConflictError) return reply.code(409).send(options.error(request, error.code, "Idempotency key was already used with different route input."));
        return unavailable("command-storage-unavailable");
      }
    }
    const prepared = { ...preparedBase, command };
    let authority = authorityFor(command, projectId);
    try {
      await store.reserveDomainRouteApply({ command, route, plan, operation: "apply", rollbackRevisionId: null });
      if (command.status === "eligible") {
        const claimed = await execution.controls.claimProjectUpdate(command);
        command = claimed.command;
        authority = claimed.authority ?? authorityFor(command, projectId);
        if (!claimed.claimed || !authority) {
          await store.releaseDomainRouteApply(command.id, route.domain);
          return reply.code(409).send(options.error(request, "DOMAIN_ROUTE_BUSY", "Another project update currently owns this project."));
        }
      } else if (command.status !== "dispatching" || !authority) {
        return unavailable("command-state-unavailable");
      }
      await execution.controls.validateProjectUpdateAuthority(authority, (options.now?.() ?? new Date()).getTime());
      const controlContext = { requestId: context.requestId, correlationId: command.correlationId };
      let terminal = await execution.transport.readDomainRouteApplyReceipt({ ...prepared, command }, authority, controlContext);
      if (!terminal) {
        try { terminal = await execution.transport.dispatchDomainRouteApply({ ...prepared, command }, authority, controlContext); }
        catch (dispatchError) {
          if (isAgentPreDispatchRejection(dispatchError)) {
            const unavailableReceipt: DomainRouteApplyReceiptV1 = domainRouteApplyReceiptSchema.parse({
              schemaVersion: 1, action: "domain.route.apply", agentId: prepared.agentId, commandId: command.id, projectId,
              domain: route.domain, deploymentId: route.deploymentId, inputDigest: command.inputDigest, correlationId: command.correlationId,
              networkName: null, networkId: null, targetContainerId: null, traefikContainerId: null, fileName: null, contentDigest: null,
              state: "failed", observedAt: Math.max(0, (options.now?.() ?? new Date()).getTime()), failureReason: "traefik-unavailable", redacted: true
            });
            terminal = unavailableReceipt;
          } else {
            const recovered = await execution.transport.readDomainRouteApplyReceipt({ ...prepared, command }, authority, controlContext);
            if (!recovered) throw dispatchError;
            terminal = recovered;
          }
        }
      }
      const validated = validateTerminalReceipt(terminal, { ...prepared, command });
      const audit = { actorUserId: auth.user.id, action: validated.state === "failed" ? "domain.route.failed" : "domain.route.applied",
        targetType: "project", targetId: projectId, requestId: context.requestId, correlationId: command.correlationId,
        metadata: { projectId, domain: route.domain, deploymentId: route.deploymentId, agentId: prepared.agentId,
          commandId: command.id, state: validated.state, failureReason: validated.failureReason, networkName: validated.networkName,
          networkId: validated.networkId, targetContainerId: validated.targetContainerId, fileName: validated.fileName, contentDigest: validated.contentDigest } };
      const completed = await store.completeDomainRouteApply({ command, authority, route, plan, operation: "apply", rollbackRevisionId: null, receipt: validated, audit });
      return reply.code(200).send(options.ok(request, { command: completed, route, receipt: validated, applied: validated.state !== "failed", idempotent: false }));
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return reply.code(409).send(options.error(request, error.code, "Idempotency input conflicts with an earlier command."));
      if (error instanceof Error && error.message === "route-receipt-invalid") return reply.code(502).send(options.error(request, "DOMAIN_ROUTE_RECEIPT_INVALID", "Agent returned invalid route evidence."));
      const storeCode = error instanceof Error && error.name === "DomainRouteStoreError" && "code" in error
        ? (error as Error & { code?: unknown }).code : null;
      if (storeCode === "domain-conflict" || storeCode === "stale-plan") {
        if (!await auditFailure("domain.route.apply.rejected", storeCode)) return unavailable("audit-unavailable");
        return reply.code(409).send(options.error(request, storeCode === "domain-conflict" ? "DOMAIN_ROUTE_CONFLICT" : "DOMAIN_ROUTE_STALE",
          "Route ownership or expected domain state changed before apply."));
      }
      return unavailable(error instanceof Error && error.name === "DomainRouteStoreError" ? "route-commit-conflict" : "agent-apply-failed");
    }
  });

  registerDomainRouteRollbackRoute(app, options);
}

function registerDomainRouteRollbackRoute(app: FastifyInstance, options: Options): void {
  app.post(`${options.prefix}/projects/:projectId/domains/rollback`, { bodyLimit: 65_536, preHandler: [options.requireAuth, options.requireRole] }, async (rawRequest, reply) => {
    const request = rawRequest as Request;
    const auth = request.auth, context = request.correlationContext;
    if (!auth || !context) return reply.code(401).send(options.error(request, "UNAUTHENTICATED", "Authentication required."));
    const params = paramsSchema.safeParse(request.params), body = domainRouteRollbackRequestSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send(options.error(request, "VALIDATION_ERROR", "Request validation failed."));
    const projectId = params.data.projectId, domain = body.data.domain;
    const idempotencyKey = keySchema.safeParse(request.headers["x-control-idempotency-key"]);
    if (!idempotencyKey.success) return reply.code(400).send(options.error(request, "IDEMPOTENCY_KEY_REQUIRED", "A bounded idempotency key is required."));

    const auditFailure = async (action: string, reason: string): Promise<boolean> => {
      try {
        await options.audit.append({ actorUserId: auth.user.id, action, targetType: "project", targetId: projectId,
          requestId: context.requestId, correlationId: context.correlationId, metadata: { projectId, domain, reason } });
        return true;
      } catch { return false; }
    };
    const unavailable = async (reason: string) => {
      await auditFailure("domain.route.rollback.unavailable", reason);
      return reply.code(503).send(options.error(request, "DOMAIN_ROUTE_ROLLBACK_UNAVAILABLE", "Domain route rollback is unavailable."));
    };

    let grants;
    try { grants = await options.grants.listForActor(auth.user.id); }
    catch { return unavailable("grant-storage-unavailable"); }
    const decision = new PolicyEvaluator().evaluate({ actorId: auth.user.id, role: auth.user.role, action: "project.update",
      scope: { kind: "project", projectId }, correlationId: context.correlationId, grants });
    if (!decision.allowed) {
      if (!await auditFailure("domain.route.rollback.denied", decision.code)) return unavailable("audit-unavailable");
      return reply.code(403).send(options.error(request, decision.code, "Domain route rollback is not authorized."));
    }
    let project;
    try { project = await options.projects.findById(projectId); }
    catch { return unavailable("project-storage-unavailable"); }
    if (!project) {
      if (!await auditFailure("domain.route.rollback.rejected", "project-not-found")) return unavailable("audit-unavailable");
      return reply.code(404).send(options.error(request, "NOT_FOUND", "Project was not found."));
    }

    const claims = options.claims, store = options.applyStore, execution = options.executions?.get(projectId);
    let claimsReady = false, storeReady = false;
    try { claimsReady = claims?.available() === true; storeReady = store?.available() === true; } catch { /* fail closed below */ }
    if (!claims || !claimsReady || !store || !storeReady || !execution || !execution.transport.available()
      || !Number.isSafeInteger(execution.commandTtlMs) || execution.commandTtlMs < 1 || execution.commandTtlMs > 60_000) return unavailable("route-capability-unavailable");

    const commandInput = { operation: "rollback", domain };
    const tentative: ControlCommand = { ...createControlCommand({ actorId: auth.user.id, action: "project.update",
      scope: { kind: "project", projectId }, input: commandInput, idempotencyKey: idempotencyKey.data,
      correlationId: context.correlationId, expiresAt: new Date((options.now?.() ?? new Date()).getTime() + execution.commandTtlMs) }), status: "eligible" };
    let command: ControlCommand | null;
    try { command = await execution.controls.findProjectUpdateByIdempotency(auth.user.id, projectId, idempotencyKey.data); }
    catch { return unavailable("command-storage-unavailable"); }
    if (command && command.inputDigest !== tentative.inputDigest) {
      if (!await auditFailure("domain.route.rollback.rejected", "idempotency-conflict")) return unavailable("audit-unavailable");
      return reply.code(409).send(options.error(request, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with different route input."));
    }

    const completedResponse = async (completed: ControlCommand) => {
      const receipt = domainRouteApplyReceiptSchema.safeParse(completed.result);
      if (!receipt.success || receipt.data.projectId !== projectId || receipt.data.domain !== domain
        || receipt.data.commandId !== completed.id || receipt.data.inputDigest !== completed.inputDigest
        || receipt.data.correlationId !== completed.correlationId || receipt.data.agentId !== execution.agentId) return unavailable("terminal-receipt-invalid");
      let revision = null;
      try { revision = await store.findDomainRouteRevisionByCommand(completed.id); }
      catch { return unavailable("route-revision-storage-unavailable"); }
      if (receipt.data.state !== "failed" && (!revision || revision.operation !== "rollback" || !revision.rollbackRevisionId)) return unavailable("rollback-revision-missing");
      const route = { schemaVersion: 1 as const, projectId, deploymentId: receipt.data.deploymentId, domain };
      return reply.code(200).send(options.ok(request, { command: completed, operation: "rollback", route, receipt: receipt.data,
        applied: receipt.data.state !== "failed", rolledBack: receipt.data.state !== "failed", rollbackRevisionId: revision?.rollbackRevisionId ?? null,
        routeRevisionId: revision?.id ?? null, idempotent: true }));
    };
    if (command?.status === "completed") return completedResponse(command);

    let routeRevisionId: string | null = null, route: DomainRouteIntentV1 | null = null;
    let storedPlan: DomainRoutePlanV1 | null = null;
    if (command) {
      try {
        const reservation = await store.findDomainRouteReservation(command.id);
        if (reservation) {
          if (reservation.operation !== "rollback" || !reservation.rollbackRevisionId) return unavailable("rollback-reservation-invalid");
          route = reservation.route;
          storedPlan = reservation.plan;
          routeRevisionId = reservation.rollbackRevisionId;
        } else if (command.status === "dispatching") return unavailable("rollback-reservation-missing");
      } catch { return unavailable("rollback-reservation-invalid"); }
    }
    if (!route) {
      let target;
      try { target = await store.findRollbackTarget(projectId, domain); }
      catch { return unavailable("route-revision-state-invalid"); }
      if (!target) {
        if (!await auditFailure("domain.route.rollback.rejected", "prior-route-not-found")) return unavailable("audit-unavailable");
        return reply.code(409).send(options.error(request, "DOMAIN_ROUTE_NO_ROLLBACK", "No prior route binding is available to restore."));
      }
      routeRevisionId = target.id;
      route = { schemaVersion: 1, projectId, deploymentId: target.deploymentId, domain };
    }

    let rawDeployment;
    try { rawDeployment = await options.deployments.findById(route.deploymentId); }
    catch { return unavailable("deployment-storage-unavailable"); }
    if (!rawDeployment) return reply.code(409).send(options.error(request, "DOMAIN_ROUTE_TARGET_CONFLICT", "The prior route target is unavailable."));
    const parsedDeployment = deploymentSchema.safeParse(rawDeployment);
    if (!parsedDeployment.success) return unavailable("target-state-invalid");
    const deployment = parsedDeployment.data;
    const trusted = trustedPriorExecutionReceiptSchema.safeParse(deployment.executionReceipt);
    const effectiveImage = deployment.stopTarget?.effectiveImage;
    const targetVerified = deployment.projectId === projectId && deployment.status === "succeeded" && deployment.finishedAt !== null
      && deployment.agentId === execution.agentId && deployment.snapshotHash !== undefined && deployment.snapshotOriginId !== undefined
      && trusted.success && effectiveImage !== undefined
      && trusted.data.deploymentId === deployment.id && trusted.data.projectId === projectId && trusted.data.runtimeHost === deployment.agentId
      && trusted.data.snapshotHash === deployment.snapshotHash && trusted.data.snapshotOriginId === deployment.snapshotOriginId
      && trusted.data.candidateId === deployment.stopTarget?.candidateId && trusted.data.effectiveImageDigest === effectiveImage.split("@")[1];
    if (!targetVerified || !trusted.success || !effectiveImage) {
      if (!await auditFailure("domain.route.rollback.rejected", "target-receipt-unverified")) return unavailable("audit-unavailable");
      return reply.code(409).send(options.error(request, "DOMAIN_ROUTE_TARGET_UNVERIFIED", "The prior route target lacks a matching trusted execution receipt."));
    }

    try { trusted.data = await currentDomainReceipt(trusted.data, options); } catch { return unavailable("runtime-port-state-invalid"); }
    let plan = storedPlan;
    if (!plan) {
      try {
        plan = createDomainRoutePlan({ desired: route, currentClaims: await claims.listClaims() });
        if (plan.action !== "retarget") throw new Error("rollback-target-is-current");
      } catch {
        if (!await auditFailure("domain.route.rollback.rejected", "stale-route-revision")) return unavailable("audit-unavailable");
        return reply.code(409).send(options.error(request, "DOMAIN_ROUTE_STALE", "The prior route binding is no longer eligible for rollback."));
      }
    }

    if (!command) {
      try { command = (await execution.controls.resolve(tentative)).command; }
      catch (error) {
        if (error instanceof IdempotencyConflictError) return reply.code(409).send(options.error(request, error.code, "Idempotency key was already used with different route input."));
        return unavailable("command-storage-unavailable");
      }
      if (command.inputDigest !== tentative.inputDigest) return reply.code(409).send(options.error(request, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with different route input."));
      if (command.status === "completed") return completedResponse(command);
    }

    const preparedBase: PreparedDomainRouteApplyCommand = { command, route, executionReceipt: trusted.data, effectiveImage, agentId: execution.agentId };
    let authority = authorityFor(command, projectId);
    try {
      await store.reserveDomainRouteApply({ command, route, plan, operation: "rollback", rollbackRevisionId: routeRevisionId });
      if (command.status === "eligible") {
        const claimed = await execution.controls.claimProjectUpdate(command);
        command = claimed.command;
        authority = claimed.authority ?? authorityFor(command, projectId);
        if (!claimed.claimed || !authority) {
          await store.releaseDomainRouteApply(command.id, route.domain);
          return reply.code(409).send(options.error(request, "DOMAIN_ROUTE_BUSY", "Another project update currently owns this project."));
        }
      } else if (command.status !== "dispatching" || !authority) return unavailable("command-state-unavailable");
      await execution.controls.validateProjectUpdateAuthority(authority, (options.now?.() ?? new Date()).getTime());
      const controlContext = { requestId: context.requestId, correlationId: command.correlationId };
      let terminal = await execution.transport.readDomainRouteApplyReceipt({ ...preparedBase, command }, authority, controlContext);
      if (!terminal) {
        try { terminal = await execution.transport.dispatchDomainRouteApply({ ...preparedBase, command }, authority, controlContext); }
        catch (dispatchError) {
          if (isAgentPreDispatchRejection(dispatchError)) {
            terminal = domainRouteApplyReceiptSchema.parse({ schemaVersion: 1, action: "domain.route.apply", agentId: execution.agentId,
              commandId: command.id, projectId, domain: route.domain, deploymentId: route.deploymentId, inputDigest: command.inputDigest,
              correlationId: command.correlationId, networkName: null, networkId: null, targetContainerId: null, traefikContainerId: null,
              fileName: null, contentDigest: null, state: "failed", observedAt: Math.max(0, (options.now?.() ?? new Date()).getTime()),
              failureReason: "traefik-unavailable", redacted: true });
          } else {
            const recovered = await execution.transport.readDomainRouteApplyReceipt({ ...preparedBase, command }, authority, controlContext);
            if (!recovered) throw dispatchError;
            terminal = recovered;
          }
        }
      }
      const validated = validateTerminalReceipt(terminal, { ...preparedBase, command });
      const audit = { actorUserId: auth.user.id, action: validated.state === "failed" ? "domain.route.rollback.failed" : "domain.route.rolled_back",
        targetType: "project", targetId: projectId, requestId: context.requestId, correlationId: command.correlationId,
        metadata: { projectId, domain, deploymentId: route.deploymentId, agentId: execution.agentId, commandId: command.id,
          state: validated.state, failureReason: validated.failureReason, networkName: validated.networkName, networkId: validated.networkId,
          targetContainerId: validated.targetContainerId, fileName: validated.fileName, contentDigest: validated.contentDigest,
          rollbackRevisionId: routeRevisionId } };
      const completed = await store.completeDomainRouteApply({ command, authority, route, plan, operation: "rollback",
        rollbackRevisionId: routeRevisionId, receipt: validated, audit });
      const revision = await store.findDomainRouteRevisionByCommand(command.id);
      if (validated.state !== "failed" && (!revision || revision.rollbackRevisionId !== routeRevisionId)) return unavailable("rollback-revision-missing");
      return reply.code(200).send(options.ok(request, { command: completed, operation: "rollback", route, receipt: validated,
        applied: validated.state !== "failed", rolledBack: validated.state !== "failed", rollbackRevisionId: routeRevisionId,
        routeRevisionId: revision?.id ?? null, idempotent: false }));
    } catch (error) {
      if (error instanceof IdempotencyConflictError) return reply.code(409).send(options.error(request, error.code, "Idempotency input conflicts with an earlier route command."));
      if (error instanceof Error && error.message === "route-receipt-invalid") return reply.code(502).send(options.error(request, "DOMAIN_ROUTE_RECEIPT_INVALID", "Agent returned invalid route evidence."));
      const storeCode = error instanceof Error && error.name === "DomainRouteStoreError" && "code" in error
        ? (error as Error & { code?: unknown }).code : null;
      if (storeCode === "domain-conflict" || storeCode === "stale-plan") {
        if (!await auditFailure("domain.route.rollback.rejected", String(storeCode))) return unavailable("audit-unavailable");
        return reply.code(409).send(options.error(request, "DOMAIN_ROUTE_STALE", "Route ownership or revision changed before rollback."));
      }
      return unavailable(error instanceof Error && error.name === "DomainRouteStoreError" ? "route-commit-conflict" : "agent-rollback-failed");
    }
  });
}
