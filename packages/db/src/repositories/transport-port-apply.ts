import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import { projectControlAuthoritySchema, protocolPayloadFingerprint, transportPortApplyReceiptSchema, transportPortIntentSchema,
  transportPortBindingSchema, transportPortRevisionSchema, transportPortRuntimeStateSchema, type TransportPortRevisionV1 } from "@deploylite/contracts";
import { validateProjectUpdateAuthority, type ControlCommand, type TransportPortApplyCompletionInput, type TransportPortApplyCompletionStore,
  type TransportPortApplyReservationV1, type TransportPortClaimReader, type TransportPortPlanV1, type TransportPortRuntimeState } from "@deploylite/domain";
import type { DeployLiteDb } from "../client.js";
import { auditEvents, controlCommandAudits, controlCommands, transportPortClaims, transportPortReservations, transportPortRevisions,
  transportPortRuntimeStates } from "../schema.js";
import { redactAuditMetadata } from "./auth.js";
import { toCommand } from "./control-plane.js";
import { DbTransportPortClaimReader } from "./transport-port-claims.js";

function storedPlan(raw: unknown): TransportPortPlanV1 | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "action,previous,route") return null;
  const route = transportPortIntentSchema.safeParse(value.route);
  if (!route.success || !["create", "attach", "no-op", "retarget"].includes(String(value.action))) return null;
  const previous = value.previous;
  if (previous !== null && (typeof previous !== "object" || previous === null || Array.isArray(previous)
    || typeof (previous as Record<string, unknown>).deploymentId !== "string"
    || !Number.isInteger((previous as Record<string, unknown>).targetPort))) return null;
  return { action: value.action as TransportPortPlanV1["action"], route: route.data,
    previous: previous as TransportPortPlanV1["previous"] };
}

function toRevision(row: typeof transportPortRevisions.$inferSelect | undefined): TransportPortRevisionV1 | null {
  if (!row) return null;
  const parsed = transportPortRevisionSchema.safeParse({ schemaVersion: 1, id: row.id, projectId: row.projectId, protocol: row.protocol,
    publishedPort: row.publishedPort, deploymentId: row.deploymentId, targetPort: row.targetPort, revisionNumber: row.revisionNumber,
    operation: row.operation, rollbackRevisionId: row.rollbackRevisionId, commandId: row.commandId, correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(), evidence: row.evidence });
  if (!parsed.success) throw new TransportPortStoreError("stored-binding-invalid");
  return parsed.data;
}

function parseBindings(raw: unknown) {
  if (!Array.isArray(raw) || raw.length > 128) return null;
  const bindings: import("@deploylite/contracts").TransportPortBindingV1[] = [];
  for (const value of raw) { const parsed = transportPortBindingSchema.safeParse(value); if (!parsed.success) return null; bindings.push(parsed.data); }
  const keys = new Set<string>();
  for (const binding of bindings) { const key = `${binding.protocol}:${binding.publishedPort}`; if (keys.has(key)) return null; keys.add(key); }
  return bindings;
}

function matchesRouteBinding(bindings: readonly import("@deploylite/contracts").TransportPortBindingV1[], route: import("@deploylite/contracts").TransportPortIntentV1): boolean {
  return bindings.some(binding => binding.protocol === route.protocol && binding.publishedPort === route.publishedPort && binding.targetPort === route.targetPort);
}

export type TransportPortStoreErrorCode = "stored-binding-invalid" | "port-conflict" | "stale-plan" | "completion-rejected";
export class TransportPortStoreError extends Error {
  constructor(readonly code: TransportPortStoreErrorCode) { super("Stored transport port state cannot be changed safely."); this.name = "TransportPortStoreError"; }
}

/** PostgreSQL claim reader plus durable reservation/revision and atomic apply completion. */
export class DbTransportPortApplyStore implements TransportPortClaimReader, TransportPortApplyCompletionStore {
  private readonly reader: DbTransportPortClaimReader;
  constructor(private readonly db: DeployLiteDb) { this.reader = new DbTransportPortClaimReader(db); }
  available(): boolean { return true; }
  listClaims() { return this.reader.listClaims(); }

  async findRollbackTarget(projectId: string, protocol: "tcp" | "udp", publishedPort: number): Promise<TransportPortRevisionV1 | null> {
    const [claim] = await this.db.select().from(transportPortClaims).where(and(eq(transportPortClaims.projectId, projectId),
      eq(transportPortClaims.protocol, protocol), eq(transportPortClaims.publishedPort, publishedPort))).limit(1);
    if (!claim || !claim.deploymentId) return null;
    const [current] = await this.db.select().from(transportPortRevisions).where(and(eq(transportPortRevisions.projectId, projectId),
      eq(transportPortRevisions.protocol, protocol), eq(transportPortRevisions.publishedPort, publishedPort)))
      .orderBy(desc(transportPortRevisions.revisionNumber)).limit(1);
    const currentRevision = toRevision(current);
    if (!currentRevision || currentRevision.deploymentId !== claim.deploymentId || currentRevision.targetPort !== claim.targetPort) {
      throw new TransportPortStoreError("stored-binding-invalid");
    }
    const [target] = await this.db.select().from(transportPortRevisions).where(and(eq(transportPortRevisions.projectId, projectId),
      eq(transportPortRevisions.protocol, protocol), eq(transportPortRevisions.publishedPort, publishedPort),
      or(ne(transportPortRevisions.deploymentId, currentRevision.deploymentId), ne(transportPortRevisions.targetPort, currentRevision.targetPort))))
      .orderBy(desc(transportPortRevisions.revisionNumber)).limit(1);
    return toRevision(target);
  }

  async findTransportPortRevisionByCommand(commandId: string): Promise<TransportPortRevisionV1 | null> {
    const [row] = await this.db.select().from(transportPortRevisions).where(eq(transportPortRevisions.commandId, commandId)).limit(1);
    return toRevision(row);
  }

  async findTransportPortRuntimeState(projectId: string, deploymentId: string): Promise<TransportPortRuntimeState | null> {
    const [row] = await this.db.select().from(transportPortRuntimeStates).where(and(eq(transportPortRuntimeStates.projectId, projectId),
      eq(transportPortRuntimeStates.deploymentId, deploymentId))).limit(1);
    if (!row) return null;
    const bindings = parseBindings(row.bindings);
    const parsed = transportPortRuntimeStateSchema.safeParse({ projectId: row.projectId, deploymentId: row.deploymentId,
      containerId: row.containerId, bindings });
    if (!bindings || !parsed.success) throw new TransportPortStoreError("stored-binding-invalid");
    return parsed.data;
  }

  async findTransportPortReservation(commandId: string): Promise<TransportPortApplyReservationV1 | null> {
    const [row] = await this.db.select().from(transportPortReservations).where(eq(transportPortReservations.commandId, commandId)).limit(1);
    if (!row) return null;
    const route = transportPortIntentSchema.safeParse(row.route), plan = storedPlan(row.plan);
    const bindings = parseBindings(row.bindings), previousBindings = parseBindings(row.previousBindings);
    if (!route.success || !plan || !bindings || !previousBindings || !/^[a-f0-9]{64}$/.test(row.currentContainerId)
      || !matchesRouteBinding(bindings, route.data) || plan.route.projectId !== route.data.projectId || plan.route.deploymentId !== route.data.deploymentId
      || plan.route.protocol !== route.data.protocol || plan.route.publishedPort !== route.data.publishedPort
      || (row.operation !== "apply" && row.operation !== "rollback") || (row.operation === "apply") !== (row.rollbackRevisionId === null)) {
      throw new TransportPortStoreError("stored-binding-invalid");
    }
    return { commandId: row.commandId, route: route.data, plan, operation: row.operation, rollbackRevisionId: row.rollbackRevisionId,
      currentContainerId: row.currentContainerId, bindings, previousBindings };
  }

  async reserveTransportPortApply(input: Readonly<{ command: ControlCommand; route: import("@deploylite/contracts").TransportPortIntentV1; plan: TransportPortPlanV1;
    operation: "apply" | "rollback"; rollbackRevisionId: string | null; currentContainerId: string;
    bindings: import("@deploylite/contracts").TransportPortBindingV1[]; previousBindings: import("@deploylite/contracts").TransportPortBindingV1[] }>): Promise<void> {
    const route = transportPortIntentSchema.safeParse(input.route);
    const bindings = parseBindings(input.bindings), previousBindings = parseBindings(input.previousBindings);
    if (!route.success || input.plan.route.projectId !== route.data.projectId || input.plan.route.deploymentId !== route.data.deploymentId
      || input.plan.route.protocol !== route.data.protocol || input.plan.route.publishedPort !== route.data.publishedPort
      || input.plan.route.targetPort !== route.data.targetPort || (input.operation === "apply") !== (input.rollbackRevisionId === null)
      || !/^[a-f0-9]{64}$/.test(input.currentContainerId) || !bindings || !previousBindings || !matchesRouteBinding(bindings, route.data)
      || (input.operation === "rollback" && input.plan.action !== "retarget") || input.command.action !== "project.update"
      || input.command.scope.kind !== "project" || input.command.scope.projectId !== route.data.projectId
      || !["eligible", "dispatching"].includes(input.command.status)) throw new TransportPortStoreError("completion-rejected");
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:execution:${route.data.projectId}`}, 0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:transport-port:${route.data.protocol}:${route.data.publishedPort}`}, 0))`);
      const [reservation] = await tx.select().from(transportPortReservations).where(and(eq(transportPortReservations.protocol, route.data.protocol),
        eq(transportPortReservations.publishedPort, route.data.publishedPort))).limit(1).for("update");
      if (reservation?.commandId === input.command.id) {
        if (reservation.projectId !== route.data.projectId || protocolPayloadFingerprint(reservation.route) !== protocolPayloadFingerprint(route.data)
          || protocolPayloadFingerprint(reservation.plan) !== protocolPayloadFingerprint(input.plan) || reservation.operation !== input.operation
          || reservation.rollbackRevisionId !== input.rollbackRevisionId || reservation.currentContainerId !== input.currentContainerId
          || protocolPayloadFingerprint(reservation.bindings) !== protocolPayloadFingerprint(bindings)
          || protocolPayloadFingerprint(reservation.previousBindings) !== protocolPayloadFingerprint(previousBindings)) throw new TransportPortStoreError("completion-rejected");
        return;
      }
      if (reservation) throw new TransportPortStoreError("port-conflict");

      const [existing] = await tx.select().from(transportPortClaims).where(and(eq(transportPortClaims.protocol, route.data.protocol),
        eq(transportPortClaims.publishedPort, route.data.publishedPort))).limit(1).for("update");
      const matchesExpected = input.plan.action === "create" ? !existing
        : input.plan.action === "attach" ? Boolean(existing && existing.projectId === route.data.projectId && existing.deploymentId === null)
        : input.plan.action === "retarget" ? Boolean(existing && existing.projectId === route.data.projectId
          && existing.deploymentId === input.plan.previous?.deploymentId && existing.targetPort === input.plan.previous.targetPort)
        : input.plan.action === "no-op" ? Boolean(existing && existing.projectId === route.data.projectId
          && existing.deploymentId === route.data.deploymentId && existing.targetPort === route.data.targetPort) : false;
      if (!matchesExpected) throw new TransportPortStoreError(existing && existing.projectId !== route.data.projectId ? "port-conflict" : "stale-plan");

      const deploymentClaims = await tx.select().from(transportPortClaims).where(and(eq(transportPortClaims.projectId, route.data.projectId),
        eq(transportPortClaims.deploymentId, route.data.deploymentId)));
      const storedPrevious = parseBindings(deploymentClaims.map(claim => ({ protocol: claim.protocol, publishedPort: claim.publishedPort, targetPort: claim.targetPort })));
      if (!storedPrevious) throw new TransportPortStoreError("stored-binding-invalid");
      if (protocolPayloadFingerprint([...storedPrevious].sort((a, b) => a.protocol.localeCompare(b.protocol) || a.publishedPort - b.publishedPort))
        !== protocolPayloadFingerprint(previousBindings)) throw new TransportPortStoreError("stale-plan");
      const [runtimeStateRow] = await tx.select().from(transportPortRuntimeStates).where(and(eq(transportPortRuntimeStates.projectId, route.data.projectId),
        eq(transportPortRuntimeStates.deploymentId, route.data.deploymentId))).limit(1).for("update");
      if (runtimeStateRow) {
        const runtimeBindings = parseBindings(runtimeStateRow.bindings);
        if (runtimeStateRow.containerId !== input.currentContainerId || !runtimeBindings
          || protocolPayloadFingerprint(runtimeBindings) !== protocolPayloadFingerprint(previousBindings)) throw new TransportPortStoreError("stale-plan");
      }
      const expectedBindings = new Map(previousBindings.filter(binding => !(binding.protocol === route.data.protocol && binding.publishedPort === route.data.publishedPort))
        .map(binding => [`${binding.protocol}:${binding.publishedPort}`, binding]));
      expectedBindings.set(`${route.data.protocol}:${route.data.publishedPort}`, { protocol: route.data.protocol,
        publishedPort: route.data.publishedPort, targetPort: route.data.targetPort });
      if (protocolPayloadFingerprint([...expectedBindings.values()].sort((a, b) => a.protocol.localeCompare(b.protocol) || a.publishedPort - b.publishedPort))
        !== protocolPayloadFingerprint(bindings)) throw new TransportPortStoreError("stale-plan");

      if (input.operation === "rollback") {
        const [target] = await tx.select().from(transportPortRevisions).where(and(eq(transportPortRevisions.id, input.rollbackRevisionId!),
          eq(transportPortRevisions.projectId, route.data.projectId), eq(transportPortRevisions.protocol, route.data.protocol),
          eq(transportPortRevisions.publishedPort, route.data.publishedPort))).limit(1).for("update");
        const [current] = existing ? await tx.select().from(transportPortRevisions).where(and(eq(transportPortRevisions.projectId, route.data.projectId),
          eq(transportPortRevisions.protocol, route.data.protocol), eq(transportPortRevisions.publishedPort, route.data.publishedPort)))
          .orderBy(desc(transportPortRevisions.revisionNumber)).limit(1).for("update") : [];
        const targetRevision = toRevision(target), currentRevision = toRevision(current);
        if (!existing || !targetRevision || !currentRevision || currentRevision.deploymentId !== existing.deploymentId
          || currentRevision.targetPort !== existing.targetPort || targetRevision.revisionNumber >= currentRevision.revisionNumber
          || targetRevision.deploymentId !== route.data.deploymentId || targetRevision.targetPort !== route.data.targetPort) {
          throw new TransportPortStoreError("stale-plan");
        }
      }
      await tx.insert(transportPortReservations).values({ protocol: route.data.protocol, publishedPort: route.data.publishedPort,
        projectId: route.data.projectId, commandId: input.command.id, route: route.data, plan: input.plan,
        currentContainerId: input.currentContainerId, bindings, previousBindings,
        operation: input.operation, rollbackRevisionId: input.rollbackRevisionId });
    });
  }

  async releaseTransportPortApply(commandId: string, protocol: "tcp" | "udp", publishedPort: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [reservation] = await tx.select().from(transportPortReservations).where(and(eq(transportPortReservations.protocol, protocol),
        eq(transportPortReservations.publishedPort, publishedPort))).limit(1).for("update");
      if (reservation?.commandId === commandId) await tx.delete(transportPortReservations).where(and(eq(transportPortReservations.protocol, protocol), eq(transportPortReservations.publishedPort, publishedPort)));
    });
  }

  async completeTransportPortApply(input: TransportPortApplyCompletionInput): Promise<ControlCommand> {
    const route = transportPortIntentSchema.safeParse(input.route), receipt = transportPortApplyReceiptSchema.safeParse(input.receipt), authority = projectControlAuthoritySchema.safeParse(input.authority);
    const bindings = parseBindings(input.bindings), previousBindings = parseBindings(input.previousBindings);
    if (!route.success || !receipt.success || !authority.success || input.command.action !== "project.update" || input.command.scope.kind !== "project"
      || input.command.scope.projectId !== route.data.projectId || input.command.id !== authority.data.commandId
      || input.command.inputDigest !== authority.data.inputDigest || authority.data.projectId !== route.data.projectId
      || input.plan.route.projectId !== route.data.projectId || input.plan.route.deploymentId !== route.data.deploymentId
      || input.plan.route.protocol !== route.data.protocol || input.plan.route.publishedPort !== route.data.publishedPort
      || input.plan.route.targetPort !== route.data.targetPort || (input.operation === "apply") !== (input.rollbackRevisionId === null)
      || !/^[a-f0-9]{64}$/.test(input.currentContainerId) || !bindings || !previousBindings || !matchesRouteBinding(bindings, route.data)
      || (input.operation === "rollback" && input.plan.action !== "retarget")
      || receipt.data.commandId !== input.command.id || receipt.data.projectId !== route.data.projectId || receipt.data.deploymentId !== route.data.deploymentId
      || receipt.data.protocol !== route.data.protocol || receipt.data.publishedPort !== route.data.publishedPort || receipt.data.targetPort !== route.data.targetPort
      || receipt.data.operation !== input.operation || receipt.data.rollbackRevisionId !== input.rollbackRevisionId
      || receipt.data.inputDigest !== input.command.inputDigest || receipt.data.agentId !== input.audit.metadata?.agentId
      || input.audit.action !== (receipt.data.state === "failed" ? input.operation === "rollback" ? "transport.port.rollback.failed" : "transport.port.apply.failed"
        : input.operation === "rollback" ? "transport.port.rolled_back" : "transport.port.applied")
      || input.audit.actorUserId !== input.command.actorId || input.audit.targetType !== "project" || input.audit.targetId !== route.data.projectId
      || !input.audit.requestId || input.audit.correlationId !== input.command.correlationId) throw new TransportPortStoreError("completion-rejected");
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:execution:${route.data.projectId}`}, 0))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:transport-port:${route.data.protocol}:${route.data.publishedPort}`}, 0))`);
      const [storedCommand] = await tx.select().from(controlCommands).where(eq(controlCommands.id, input.command.id)).limit(1).for("update");
      if (!storedCommand) throw new TransportPortStoreError("completion-rejected");
      const current = toCommand(storedCommand);
      if (current.status === "completed") {
        if (current.action !== "project.update" || !current.projectExecutionAuthority
          || protocolPayloadFingerprint(current.projectExecutionAuthority) !== protocolPayloadFingerprint(authority.data)
          || protocolPayloadFingerprint(current.result) !== protocolPayloadFingerprint(receipt.data)) throw new TransportPortStoreError("completion-rejected");
        return current;
      }
      if (current.status !== "dispatching" || current.scope.kind !== "project" || current.scope.projectId !== route.data.projectId
        || current.inputDigest !== receipt.data.inputDigest || !current.projectExecutionAuthority
        || protocolPayloadFingerprint(current.projectExecutionAuthority) !== protocolPayloadFingerprint(authority.data)) throw new TransportPortStoreError("completion-rejected");
      const relatedRows = await tx.select().from(controlCommands).where(or(
        and(eq(controlCommands.scopeKind, "project"), eq(controlCommands.scopeKey, route.data.projectId)),
        and(eq(controlCommands.scopeKind, "deployment"), sql`${controlCommands.scopeKey}::jsonb ->> 0 = ${route.data.projectId}`)
      ));
      try { validateProjectUpdateAuthority(relatedRows.map(toCommand), authority.data); } catch { throw new TransportPortStoreError("completion-rejected"); }

      const [reservation] = await tx.select().from(transportPortReservations).where(and(eq(transportPortReservations.protocol, route.data.protocol),
        eq(transportPortReservations.publishedPort, route.data.publishedPort))).limit(1).for("update");
      if (!reservation || reservation.commandId !== input.command.id || reservation.projectId !== route.data.projectId
        || protocolPayloadFingerprint(reservation.route) !== protocolPayloadFingerprint(route.data)
        || protocolPayloadFingerprint(reservation.plan) !== protocolPayloadFingerprint(input.plan)
        || reservation.operation !== input.operation || reservation.rollbackRevisionId !== input.rollbackRevisionId
        || reservation.currentContainerId !== input.currentContainerId || protocolPayloadFingerprint(reservation.bindings) !== protocolPayloadFingerprint(bindings)
        || protocolPayloadFingerprint(reservation.previousBindings) !== protocolPayloadFingerprint(previousBindings)) throw new TransportPortStoreError("completion-rejected");

      let revision: TransportPortRevisionV1 | null = null;
      if (receipt.data.state !== "failed") {
        const [existing] = await tx.select().from(transportPortClaims).where(and(eq(transportPortClaims.protocol, route.data.protocol),
          eq(transportPortClaims.publishedPort, route.data.publishedPort))).limit(1).for("update");
        const matchesExpected = input.plan.action === "create" ? !existing
          : input.plan.action === "attach" ? Boolean(existing && existing.projectId === route.data.projectId && existing.deploymentId === null)
          : input.plan.action === "retarget" ? Boolean(existing && existing.projectId === route.data.projectId
            && existing.deploymentId === input.plan.previous?.deploymentId && existing.targetPort === input.plan.previous.targetPort)
          : input.plan.action === "no-op" ? Boolean(existing && existing.projectId === route.data.projectId
            && existing.deploymentId === route.data.deploymentId && existing.targetPort === route.data.targetPort) : false;
        if (!matchesExpected) throw new TransportPortStoreError(existing && existing.projectId !== route.data.projectId ? "port-conflict" : "stale-plan");
        const deploymentClaims = await tx.select().from(transportPortClaims).where(and(eq(transportPortClaims.projectId, route.data.projectId),
          eq(transportPortClaims.deploymentId, route.data.deploymentId)));
        const storedPrevious = parseBindings(deploymentClaims.map(claim => ({ protocol: claim.protocol, publishedPort: claim.publishedPort, targetPort: claim.targetPort })));
        const sortedPrevious = previousBindings.slice().sort((a, b) => a.protocol.localeCompare(b.protocol) || a.publishedPort - b.publishedPort);
        if (!storedPrevious || protocolPayloadFingerprint(storedPrevious.slice().sort((a, b) => a.protocol.localeCompare(b.protocol) || a.publishedPort - b.publishedPort))
          !== protocolPayloadFingerprint(sortedPrevious)) throw new TransportPortStoreError("stale-plan");
        const [runtimeStateRow] = await tx.select().from(transportPortRuntimeStates).where(and(eq(transportPortRuntimeStates.projectId, route.data.projectId),
          eq(transportPortRuntimeStates.deploymentId, route.data.deploymentId))).limit(1).for("update");
        if (runtimeStateRow) {
          const runtimeBindings = parseBindings(runtimeStateRow.bindings);
          if (runtimeStateRow.containerId !== input.currentContainerId || !runtimeBindings
            || protocolPayloadFingerprint(runtimeBindings) !== protocolPayloadFingerprint(sortedPrevious)) throw new TransportPortStoreError("stale-plan");
        }
        if (input.operation === "rollback") {
          const [target] = await tx.select().from(transportPortRevisions).where(and(eq(transportPortRevisions.id, input.rollbackRevisionId!),
            eq(transportPortRevisions.projectId, route.data.projectId), eq(transportPortRevisions.protocol, route.data.protocol),
            eq(transportPortRevisions.publishedPort, route.data.publishedPort))).limit(1).for("update");
          const [latest] = await tx.select().from(transportPortRevisions).where(and(eq(transportPortRevisions.projectId, route.data.projectId),
            eq(transportPortRevisions.protocol, route.data.protocol), eq(transportPortRevisions.publishedPort, route.data.publishedPort)))
            .orderBy(desc(transportPortRevisions.revisionNumber)).limit(1).for("update");
          const targetRevision = toRevision(target), latestRevision = toRevision(latest);
          if (!targetRevision || !latestRevision || latestRevision.deploymentId !== input.plan.previous?.deploymentId
            || latestRevision.targetPort !== input.plan.previous?.targetPort || targetRevision.revisionNumber >= latestRevision.revisionNumber
            || targetRevision.deploymentId !== route.data.deploymentId || targetRevision.targetPort !== route.data.targetPort) throw new TransportPortStoreError("stale-plan");
        }
        await tx.insert(transportPortClaims).values({ protocol: route.data.protocol, publishedPort: route.data.publishedPort,
          projectId: route.data.projectId, deploymentId: route.data.deploymentId, targetPort: route.data.targetPort, updatedAt: new Date() })
          .onConflictDoUpdate({ target: [transportPortClaims.protocol, transportPortClaims.publishedPort],
            set: { projectId: route.data.projectId, deploymentId: route.data.deploymentId, targetPort: route.data.targetPort, updatedAt: new Date() } });
        if (input.plan.action !== "no-op") {
          const [latest] = await tx.select().from(transportPortRevisions).where(and(eq(transportPortRevisions.projectId, route.data.projectId),
            eq(transportPortRevisions.protocol, route.data.protocol), eq(transportPortRevisions.publishedPort, route.data.publishedPort)))
            .orderBy(desc(transportPortRevisions.revisionNumber)).limit(1).for("update");
          const [inserted] = await tx.insert(transportPortRevisions).values({ projectId: route.data.projectId, protocol: route.data.protocol,
            publishedPort: route.data.publishedPort, deploymentId: route.data.deploymentId, targetPort: route.data.targetPort,
            revisionNumber: (latest?.revisionNumber ?? 0) + 1, operation: input.operation, commandId: input.command.id,
            rollbackRevisionId: input.rollbackRevisionId, createdBy: input.command.actorId, correlationId: input.command.correlationId,
            evidence: { state: receipt.data.state, observedAt: receipt.data.observedAt, redacted: true } }).returning();
          const parsedRevision = toRevision(inserted);
          if (!parsedRevision) throw new TransportPortStoreError("completion-rejected");
          revision = parsedRevision;
        }
        await tx.insert(transportPortRuntimeStates).values({ projectId: route.data.projectId, deploymentId: route.data.deploymentId,
          containerId: receipt.data.containerId!, bindings, commandId: input.command.id, updatedAt: new Date() })
          .onConflictDoUpdate({ target: [transportPortRuntimeStates.projectId, transportPortRuntimeStates.deploymentId],
            set: { containerId: receipt.data.containerId!, bindings, commandId: input.command.id, updatedAt: new Date() } });
      }
      const [completed] = await tx.update(controlCommands).set({ status: "completed", result: receipt.data, updatedAt: new Date() })
        .where(and(eq(controlCommands.id, input.command.id), eq(controlCommands.status, "dispatching"))).returning();
      if (!completed) throw new TransportPortStoreError("completion-rejected");
      await tx.insert(controlCommandAudits).values({ commandId: input.command.id, confirmationId: null,
        correlationId: input.command.correlationId, outcome: receipt.data.state === "failed" ? "failed" : "completed", reason: receipt.data.failureReason });
      await tx.insert(auditEvents).values({ actorUserId: input.audit.actorUserId, action: input.audit.action, targetType: "project",
        targetId: route.data.projectId, requestId: input.audit.requestId, correlationId: input.audit.correlationId,
        metadata: redactAuditMetadata({ ...(input.audit.metadata ?? {}), commandId: input.command.id, inputDigest: input.command.inputDigest,
          transportPortRevisionId: revision?.id ?? null, transportPortRevisionNumber: revision?.revisionNumber ?? null,
          rollbackRevisionId: input.operation === "rollback" ? input.rollbackRevisionId : null }) });
      await tx.delete(transportPortReservations).where(and(eq(transportPortReservations.protocol, route.data.protocol), eq(transportPortReservations.publishedPort, route.data.publishedPort)));
      return toCommand(completed);
    });
  }
}
