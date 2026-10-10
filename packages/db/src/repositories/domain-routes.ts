import { and, asc, desc, eq, lt, ne, or, sql } from "drizzle-orm";
import { domainRouteApplyReceiptSchema, domainRouteClaimSchema, domainRouteIntentSchema, projectControlAuthoritySchema,
  domainRouteRevisionSchema, protocolPayloadFingerprint, type DomainRouteApplyReceiptV1, type DomainRouteClaimV1,
  type DomainRouteRevisionV1 } from "@deploylite/contracts";
import { domainRouteNetworkName, validateProjectUpdateAuthority, type ControlCommand, type DomainRouteApplyCompletionInput,
  type DomainRouteApplyCompletionStore, type DomainRouteApplyReservationV1, type DomainRouteClaimReader,
  type DomainRoutePlanV1 } from "@deploylite/domain";
import type { DeployLiteDb } from "../client.js";
import { auditEvents, controlCommandAudits, controlCommands, deployments, domainRouteReservations, domainRouteRevisions, domains } from "../schema.js";
import { redactAuditMetadata } from "./auth.js";
import { toCommand } from "./control-plane.js";

type DomainRouteReadRow = Readonly<{
  projectId: string;
  hostname: string;
  deploymentId: string | null;
  deploymentProjectId: string | null;
}>;

function storedPlan(raw: unknown): DomainRoutePlanV1 | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "action,previousDeploymentId,route") return null;
  const route = domainRouteIntentSchema.safeParse(value.route);
  if (!route.success || !["create", "attach", "no-op", "retarget"].includes(String(value.action))
    || !(value.previousDeploymentId === null || (typeof value.previousDeploymentId === "string" && value.previousDeploymentId.length > 0))) return null;
  return { action: value.action as DomainRoutePlanV1["action"], route: route.data, previousDeploymentId: value.previousDeploymentId as string | null };
}

function routeRevision(row: typeof domainRouteRevisions.$inferSelect | undefined): DomainRouteRevisionV1 | null {
  if (!row) return null;
  const parsed = domainRouteRevisionSchema.safeParse({
    schemaVersion: 1, id: row.id, projectId: row.projectId, domain: row.hostname, deploymentId: row.deploymentId,
    revisionNumber: row.revisionNumber, operation: row.operation, rollbackRevisionId: row.rollbackRevisionId,
    commandId: row.commandId, correlationId: row.correlationId, createdAt: row.createdAt.toISOString(), evidence: row.evidence
  });
  if (!parsed.success) throw new DomainRouteStoreError("stored-binding-invalid");
  return parsed.data;
}

export type DomainRouteStoreErrorCode = "stored-claim-invalid" | "stored-binding-invalid" | "domain-conflict" | "stale-plan" | "completion-rejected";

export class DomainRouteStoreError extends Error {
  constructor(readonly code: DomainRouteStoreErrorCode) {
    super("Stored domain route state cannot be read safely.");
    this.name = "DomainRouteStoreError";
  }
}

export class DbDomainRouteClaimReader implements DomainRouteClaimReader, DomainRouteApplyCompletionStore {
  constructor(private readonly db: DeployLiteDb) {}
  available(): boolean { return true; }

  async listClaims(): Promise<DomainRouteClaimV1[]> {
    const rows: DomainRouteReadRow[] = await this.db.select({
      projectId: domains.projectId,
      hostname: domains.hostname,
      deploymentId: domains.deploymentId,
      deploymentProjectId: deployments.projectId
    }).from(domains).leftJoin(deployments, eq(domains.deploymentId, deployments.id)).orderBy(asc(domains.hostname));

    return rows.map(row => {
      if (row.deploymentId !== null && row.deploymentProjectId !== row.projectId) {
        throw new DomainRouteStoreError("stored-binding-invalid");
      }
      const claim = domainRouteClaimSchema.safeParse({
        schemaVersion: 1,
        projectId: row.projectId,
        deploymentId: row.deploymentId,
        domain: row.hostname
      });
      if (!claim.success) throw new DomainRouteStoreError("stored-claim-invalid");
      return claim.data;
    });
  }

  async findRollbackTarget(projectId: string, hostname: string): Promise<DomainRouteRevisionV1 | null> {
    const [domain] = await this.db.select({ id: domains.id, deploymentId: domains.deploymentId, status: domains.status })
      .from(domains).where(and(eq(domains.projectId, projectId), eq(domains.hostname, hostname))).limit(1);
    if (!domain || domain.status !== "active" || !domain.deploymentId) return null;
    const [current] = await this.db.select().from(domainRouteRevisions).where(and(
      eq(domainRouteRevisions.domainId, domain.id), eq(domainRouteRevisions.projectId, projectId), eq(domainRouteRevisions.hostname, hostname)
    )).orderBy(desc(domainRouteRevisions.revisionNumber)).limit(1);
    const currentRevision = routeRevision(current);
    if (!currentRevision || currentRevision.deploymentId !== domain.deploymentId) throw new DomainRouteStoreError("stored-binding-invalid");
    const [target] = await this.db.select().from(domainRouteRevisions).where(and(
      eq(domainRouteRevisions.domainId, domain.id), lt(domainRouteRevisions.revisionNumber, currentRevision.revisionNumber),
      ne(domainRouteRevisions.deploymentId, currentRevision.deploymentId)
    )).orderBy(desc(domainRouteRevisions.revisionNumber)).limit(1);
    return routeRevision(target);
  }

  async findDomainRouteRevisionByCommand(commandId: string): Promise<DomainRouteRevisionV1 | null> {
    const [row] = await this.db.select().from(domainRouteRevisions).where(eq(domainRouteRevisions.commandId, commandId)).limit(1);
    return routeRevision(row);
  }

  async findDomainRouteReservation(commandId: string): Promise<DomainRouteApplyReservationV1 | null> {
    const [row] = await this.db.select().from(domainRouteReservations).where(eq(domainRouteReservations.commandId, commandId)).limit(1);
    if (!row) return null;
    const route = domainRouteIntentSchema.safeParse(row.route), plan = storedPlan(row.plan);
    if (!route.success || !plan || plan.route.domain !== route.data.domain
      || plan.route.projectId !== route.data.projectId || plan.route.deploymentId !== route.data.deploymentId
      || (row.operation !== "apply" && row.operation !== "rollback")
      || (row.operation === "apply") !== (row.rollbackRevisionId === null)) throw new DomainRouteStoreError("stored-binding-invalid");
    return { commandId: row.commandId, route: route.data, plan, operation: row.operation, rollbackRevisionId: row.rollbackRevisionId };
  }

  async reserveDomainRouteApply(input: Readonly<{ command: ControlCommand; route: import("@deploylite/contracts").DomainRouteIntentV1;
    plan: DomainRoutePlanV1; operation: "apply" | "rollback"; rollbackRevisionId: string | null }>): Promise<void> {
    const route = domainRouteIntentSchema.safeParse(input.route);
    if (!route.success || input.plan.route.domain !== route.data.domain || input.plan.route.projectId !== route.data.projectId
      || input.plan.route.deploymentId !== route.data.deploymentId
      || (input.operation === "apply") !== (input.rollbackRevisionId === null)
      || (input.operation === "rollback" && input.plan.action !== "retarget")
      || input.command.action !== "project.update" || input.command.scope.kind !== "project" || input.command.scope.projectId !== route.data.projectId
      || !["eligible", "dispatching"].includes(input.command.status)) throw new DomainRouteStoreError("completion-rejected");
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:execution:${route.data.projectId}`}, 0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:domain-route:${route.data.domain}`}, 0))`);
      let [reservation] = await tx.select().from(domainRouteReservations).where(eq(domainRouteReservations.hostname, route.data.domain)).limit(1).for("update");
      if (reservation?.commandId === input.command.id) {
        if (reservation.projectId !== route.data.projectId || protocolPayloadFingerprint(reservation.route) !== protocolPayloadFingerprint(route.data)
          || protocolPayloadFingerprint(reservation.plan) !== protocolPayloadFingerprint(input.plan)
          || reservation.operation !== input.operation || reservation.rollbackRevisionId !== input.rollbackRevisionId) throw new DomainRouteStoreError("completion-rejected");
        return;
      }
      if (reservation) {
        const [reservedCommand] = await tx.select().from(controlCommands).where(eq(controlCommands.id, reservation.commandId)).limit(1).for("update");
        const prior = reservedCommand ? toCommand(reservedCommand) : null;
        const priorReceipt = prior?.result && domainRouteApplyReceiptSchema.safeParse(prior.result);
        const repairable = reservation.projectId === route.data.projectId && prior?.status === "completed" && priorReceipt?.success
          && priorReceipt.data.state === "failed" && priorReceipt.data.failureReason === "config-write-failed";
        if (!repairable) throw new DomainRouteStoreError("domain-conflict");
        await tx.delete(domainRouteReservations).where(eq(domainRouteReservations.hostname, route.data.domain));
      }
      const [existing] = await tx.select().from(domains).where(eq(domains.hostname, route.data.domain)).limit(1).for("update");
      const matchesExpected = input.plan.action === "create" ? !existing
        : input.plan.action === "attach" ? Boolean(existing && existing.projectId === route.data.projectId && existing.deploymentId === null)
        : input.plan.action === "retarget" ? Boolean(existing && existing.projectId === route.data.projectId && existing.deploymentId === input.plan.previousDeploymentId)
        : input.plan.action === "no-op" ? Boolean(existing && existing.projectId === route.data.projectId && existing.deploymentId === route.data.deploymentId)
        : false;
      if (!matchesExpected) throw new DomainRouteStoreError(existing && existing.projectId !== route.data.projectId ? "domain-conflict" : "stale-plan");
      if (input.operation === "rollback") {
        const [target] = await tx.select().from(domainRouteRevisions).where(and(eq(domainRouteRevisions.id, input.rollbackRevisionId!),
          eq(domainRouteRevisions.projectId, route.data.projectId), eq(domainRouteRevisions.hostname, route.data.domain))).limit(1).for("update");
        const [currentRevision] = existing ? await tx.select().from(domainRouteRevisions).where(and(eq(domainRouteRevisions.domainId, existing.id),
          eq(domainRouteRevisions.projectId, route.data.projectId), eq(domainRouteRevisions.hostname, route.data.domain)))
          .orderBy(desc(domainRouteRevisions.revisionNumber)).limit(1).for("update") : [];
        const targetRevision = routeRevision(target);
        const currentRevisionRecord = routeRevision(currentRevision);
        if (!existing || !targetRevision || !currentRevisionRecord || currentRevisionRecord.deploymentId !== existing.deploymentId
          || target!.domainId !== existing.id || targetRevision.revisionNumber >= currentRevisionRecord.revisionNumber
          || targetRevision.deploymentId !== route.data.deploymentId || targetRevision.deploymentId === currentRevisionRecord.deploymentId) {
          throw new DomainRouteStoreError("stale-plan");
        }
      }
      await tx.insert(domainRouteReservations).values({ hostname: route.data.domain, projectId: route.data.projectId, commandId: input.command.id,
        route: route.data, plan: input.plan, operation: input.operation, rollbackRevisionId: input.rollbackRevisionId });
    });
  }

  async releaseDomainRouteApply(commandId: string, hostname: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [reservation] = await tx.select().from(domainRouteReservations).where(eq(domainRouteReservations.hostname, hostname)).limit(1).for("update");
      if (reservation?.commandId === commandId) await tx.delete(domainRouteReservations).where(eq(domainRouteReservations.hostname, hostname));
    });
  }

  async completeDomainRouteApply(input: DomainRouteApplyCompletionInput): Promise<ControlCommand> {
    const route = domainRouteIntentSchema.safeParse(input.route);
    const receipt = domainRouteApplyReceiptSchema.safeParse(input.receipt);
    const authority = projectControlAuthoritySchema.safeParse(input.authority);
    if (!route.success || !receipt.success || !authority.success || input.command.action !== "project.update" || input.command.scope.kind !== "project"
      || input.command.scope.projectId !== route.data.projectId || input.command.id !== authority.data.commandId
      || input.command.inputDigest !== authority.data.inputDigest || authority.data.projectId !== route.data.projectId
      || input.plan.route.projectId !== route.data.projectId || input.plan.route.deploymentId !== route.data.deploymentId
      || input.plan.route.domain !== route.data.domain
      || (input.operation === "apply") !== (input.rollbackRevisionId === null)
      || (input.operation === "rollback" && input.plan.action !== "retarget")
      || receipt.data.commandId !== input.command.id || receipt.data.projectId !== route.data.projectId
      || receipt.data.deploymentId !== route.data.deploymentId || receipt.data.domain !== route.data.domain
      || receipt.data.inputDigest !== input.command.inputDigest || receipt.data.agentId !== input.audit.metadata?.agentId
      || (receipt.data.state !== "failed" && receipt.data.networkName !== domainRouteNetworkName(route.data.projectId))
      || input.audit.action !== (receipt.data.state === "failed"
        ? input.operation === "rollback" ? "domain.route.rollback.failed" : "domain.route.failed"
        : input.operation === "rollback" ? "domain.route.rolled_back" : "domain.route.applied")
      || input.audit.actorUserId !== input.command.actorId || input.audit.targetType !== "project" || input.audit.targetId !== route.data.projectId
      || input.audit.requestId.length === 0 || input.audit.correlationId !== input.command.correlationId) {
      throw new DomainRouteStoreError("completion-rejected");
    }
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:execution:${route.data.projectId}`}, 0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:domain-route:${route.data.domain}`}, 0))`);
      const [storedCommand] = await tx.select().from(controlCommands).where(eq(controlCommands.id, input.command.id)).limit(1).for("update");
      if (!storedCommand) throw new DomainRouteStoreError("completion-rejected");
      const current = toCommand(storedCommand);
      if (current.status === "completed") {
        if (current.action !== "project.update" || !current.projectExecutionAuthority
          || protocolPayloadFingerprint(current.projectExecutionAuthority) !== protocolPayloadFingerprint(authority.data)
          || protocolPayloadFingerprint(current.result) !== protocolPayloadFingerprint(receipt.data)) throw new DomainRouteStoreError("completion-rejected");
        return current;
      }
      if (current.status !== "dispatching" || current.action !== "project.update" || current.scope.kind !== "project"
        || current.scope.projectId !== route.data.projectId || current.inputDigest !== receipt.data.inputDigest
        || !current.projectExecutionAuthority || protocolPayloadFingerprint(current.projectExecutionAuthority) !== protocolPayloadFingerprint(authority.data)) {
        throw new DomainRouteStoreError("completion-rejected");
      }
      const relatedRows = await tx.select().from(controlCommands).where(or(
        and(eq(controlCommands.scopeKind, "project"), eq(controlCommands.scopeKey, route.data.projectId)),
        and(eq(controlCommands.scopeKind, "deployment"), sql`${controlCommands.scopeKey}::jsonb ->> 0 = ${route.data.projectId}`)
      ));
      try { validateProjectUpdateAuthority(relatedRows.map(toCommand), authority.data); }
      catch { throw new DomainRouteStoreError("completion-rejected"); }

      const [reservation] = await tx.select().from(domainRouteReservations).where(eq(domainRouteReservations.hostname, route.data.domain)).limit(1).for("update");
      if (!reservation || reservation.commandId !== input.command.id || reservation.projectId !== route.data.projectId
        || protocolPayloadFingerprint(reservation.route) !== protocolPayloadFingerprint(route.data)
        || protocolPayloadFingerprint(reservation.plan) !== protocolPayloadFingerprint(input.plan)
        || reservation.operation !== input.operation || reservation.rollbackRevisionId !== input.rollbackRevisionId) throw new DomainRouteStoreError("completion-rejected");

      let completedRevision: DomainRouteRevisionV1 | null = null;
      if (receipt.data.state !== "failed") {
        const [existing] = await tx.select().from(domains).where(eq(domains.hostname, route.data.domain)).limit(1).for("update");
        const matchesExpected = input.plan.action === "create" ? !existing
          : input.plan.action === "attach" ? Boolean(existing && existing.projectId === route.data.projectId && existing.deploymentId === null)
          : input.plan.action === "retarget" ? Boolean(existing && existing.projectId === route.data.projectId && existing.deploymentId === input.plan.previousDeploymentId)
        : input.plan.action === "no-op" ? Boolean(existing && existing.projectId === route.data.projectId && existing.deploymentId === route.data.deploymentId)
          : false;
        if (!matchesExpected) throw new DomainRouteStoreError(existing && existing.projectId !== route.data.projectId ? "domain-conflict" : "stale-plan");
        const metadata = { schemaVersion: 1, agentId: receipt.data.agentId, networkName: receipt.data.networkName,
          networkId: receipt.data.networkId, containerId: receipt.data.targetContainerId, routeFile: receipt.data.fileName,
          configDigest: receipt.data.contentDigest, commandId: input.command.id };
        let domainId = existing?.id;
        if (existing) {
          await tx.update(domains).set({ deploymentId: route.data.deploymentId, status: "active", metadata, updatedAt: new Date() }).where(eq(domains.id, existing.id));
        } else {
          const [inserted] = await tx.insert(domains).values({ projectId: route.data.projectId, hostname: route.data.domain, deploymentId: route.data.deploymentId,
            status: "active", metadata }).returning({ id: domains.id });
          domainId = inserted?.id;
        }
        if (input.plan.action !== "no-op") {
          if (!domainId) throw new DomainRouteStoreError("completion-rejected");
          const [latest] = await tx.select().from(domainRouteRevisions).where(and(eq(domainRouteRevisions.domainId, domainId),
            eq(domainRouteRevisions.projectId, route.data.projectId), eq(domainRouteRevisions.hostname, route.data.domain)))
            .orderBy(desc(domainRouteRevisions.revisionNumber)).limit(1).for("update");
          if (input.operation === "rollback") {
            const [target] = await tx.select().from(domainRouteRevisions).where(and(eq(domainRouteRevisions.id, input.rollbackRevisionId!),
              eq(domainRouteRevisions.domainId, domainId), eq(domainRouteRevisions.projectId, route.data.projectId),
              eq(domainRouteRevisions.hostname, route.data.domain))).limit(1).for("update");
            const targetRevision = routeRevision(target);
            const latestRevision = routeRevision(latest);
            if (!targetRevision || !latestRevision || latestRevision.deploymentId !== input.plan.previousDeploymentId
              || targetRevision.revisionNumber >= latestRevision.revisionNumber || targetRevision.deploymentId !== route.data.deploymentId) {
              throw new DomainRouteStoreError("stale-plan");
            }
          }
          const revisionNumber = (latest?.revisionNumber ?? 0) + 1;
          const [revisionRow] = await tx.insert(domainRouteRevisions).values({
            domainId, projectId: route.data.projectId, hostname: route.data.domain, deploymentId: route.data.deploymentId,
            revisionNumber, operation: input.operation, commandId: input.command.id,
            rollbackRevisionId: input.rollbackRevisionId, createdBy: input.command.actorId, correlationId: input.command.correlationId,
            evidence: { state: receipt.data.state, contentDigest: receipt.data.contentDigest, observedAt: receipt.data.observedAt, redacted: true }
          }).returning();
          completedRevision = routeRevision(revisionRow);
        }
      }

      const [completed] = await tx.update(controlCommands).set({ status: "completed", result: receipt.data, updatedAt: new Date() })
        .where(and(eq(controlCommands.id, input.command.id), eq(controlCommands.status, "dispatching"))).returning();
      if (!completed) throw new DomainRouteStoreError("completion-rejected");
      await tx.insert(controlCommandAudits).values({ commandId: input.command.id, confirmationId: null, correlationId: input.command.correlationId,
        outcome: receipt.data.state === "failed" ? "failed" : "completed", reason: receipt.data.failureReason });
      await tx.insert(auditEvents).values({ actorUserId: input.audit.actorUserId, action: input.audit.action, targetType: input.audit.targetType,
        targetId: input.audit.targetId, requestId: input.audit.requestId, correlationId: input.audit.correlationId,
        metadata: redactAuditMetadata({ ...(input.audit.metadata ?? {}), commandId: input.command.id, inputDigest: input.command.inputDigest,
          routeRevisionId: completedRevision?.id ?? null, routeRevisionNumber: completedRevision?.revisionNumber ?? null,
          rollbackRevisionId: input.operation === "rollback" ? input.rollbackRevisionId : null }) });
      if (receipt.data.state !== "failed" || receipt.data.failureReason !== "config-write-failed") {
        await tx.delete(domainRouteReservations).where(eq(domainRouteReservations.hostname, route.data.domain));
      }
      return toCommand(completed);
    });
  }
}
