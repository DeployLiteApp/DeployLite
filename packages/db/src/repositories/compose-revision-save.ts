import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { composeRevisionSchema, composeResourcePageSchema, composeResourceOwnershipQuerySchema, composeResourceOwnershipSchema,
  type ComposeRevisionV1, type ComposeRevisionSaved, type ComposeResourcePage, type ComposeResourceOwnershipQueryV1, type ComposeResourceOwnershipV1 } from "@deploylite/contracts";
import { validatePreparedComposeRevisionSave, buildComposeRevisionSave, replayComposeRevisionSave, composeRevisionSaveAudit, composeResourceMetadata,
  composeRuntimeResourceName, validateComposePageOptions, ComposeRevisionError, type ComposeRevisionSaveStore, type PreparedComposeRevisionSave,
  type ComposeRevisionPageOptions, type ComposeRevisionPage } from "@deploylite/domain";
import type { DeployLiteDb } from "../client.js";
import { auditEvents, controlCommandAudits, controlCommands, composeResources, composeRevisions, type ComposeRevisionRow } from "../schema.js";
import { redactAuditMetadata } from "./auth.js";
import { resolveControlCommandOn } from "./control-plane.js";

type Reader = Pick<DeployLiteDb, "select">;
const MAX_RESOURCE_OWNER_SCAN = 1_000;
function revision(row: ComposeRevisionRow | undefined): ComposeRevisionV1 | null {
  if (!row) return null;
  const parsed = composeRevisionSchema.safeParse({ schemaVersion: 1, id: row.id, projectId: row.projectId, composeId: row.composeId, number: row.number,
    createdBy: row.createdBy, createdAt: row.createdAt.toISOString(), preview: row.preview });
  if (!parsed.success) throw new ComposeRevisionError("COMPOSE_REVISION_INVALID"); return parsed.data;
}
async function readRevision(db: Reader, projectId: string, id: string): Promise<ComposeRevisionV1 | null> {
  const [row] = await db.select().from(composeRevisions).where(and(eq(composeRevisions.projectId, projectId), eq(composeRevisions.id, id))).limit(1); return revision(row);
}
export class DbComposeRevisionSaveStore implements ComposeRevisionSaveStore {
  constructor(private readonly db: DeployLiteDb, private readonly options: { clock?: () => Date; injectFault?: (stage: "revision-inserted" | "command-completed" | "audit-recorded") => void | Promise<void> } = {}) {}
  available(): boolean { return true; }
  async save(input: PreparedComposeRevisionSave): Promise<ComposeRevisionSaved> {
    validatePreparedComposeRevisionSave(input);
    return this.db.transaction(async (tx) => {
      const projectId = input.preview.projectId;
      // Same project scope as the normal command ledger; also serializes competing latest revisions.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:compose:${projectId}`}, 0))`);
      const { command } = await resolveControlCommandOn(tx, input.command);
      if (command.status === "completed") return replayComposeRevisionSave(input, command, await readRevision(tx, projectId, command.id));
      const composeId = input.composeId ?? command.id;
      const [owner] = await tx.select().from(composeResources).where(eq(composeResources.id, composeId)).limit(1).for("update");
      if (input.composeId === null ? !!owner : !owner || owner.projectId !== projectId) throw new ComposeRevisionError("COMPOSE_REVISION_CONFLICT");
      const [latest] = await tx.select().from(composeRevisions).where(and(eq(composeRevisions.projectId, projectId), eq(composeRevisions.composeId, composeId))).orderBy(desc(composeRevisions.number)).limit(1);
      const next = buildComposeRevisionSave(input, command, revision(latest), this.options.clock?.() ?? new Date());
      if (!owner) await tx.insert(composeResources).values({ id: composeId, projectId, createdBy: command.actorId, createdAt: new Date(input.createdAt) });
      await tx.insert(composeRevisions).values({ id: next.revision.id, projectId, composeId, number: next.revision.number, createdBy: command.actorId, createdAt: new Date(next.revision.createdAt), preview: next.revision.preview });
      await this.options.injectFault?.("revision-inserted");
      const [completed] = await tx.update(controlCommands).set({ status: "completed", result: next.command.result, updatedAt: new Date() })
        .where(and(eq(controlCommands.id, command.id), eq(controlCommands.status, "eligible"), eq(controlCommands.inputDigest, command.inputDigest))).returning();
      if (!completed) throw new ComposeRevisionError("COMPOSE_REVISION_CONFLICT");
      await this.options.injectFault?.("command-completed");
      const audit = composeRevisionSaveAudit(input, next.command);
      await tx.insert(controlCommandAudits).values({ commandId: command.id, correlationId: command.correlationId, outcome: "completed", confirmationId: null, reason: null });
      await tx.insert(auditEvents).values({ actorUserId: command.actorId, action: audit.action, targetType: audit.targetType, targetId: audit.targetId,
        requestId: audit.requestId, correlationId: audit.correlationId, metadata: redactAuditMetadata(audit.metadata ?? {}) });
      await this.options.injectFault?.("audit-recorded");
      return { revision: next.revision, commandId: command.id, idempotent: false };
    });
  }
  findRevision(projectId: string, id: string): Promise<ComposeRevisionV1 | null> { return readRevision(this.db, projectId, id); }
  async findLatestRevision(projectId: string, composeId: string): Promise<ComposeRevisionV1 | null> {
    const [row] = await this.db.select().from(composeRevisions).where(and(eq(composeRevisions.projectId, projectId), eq(composeRevisions.composeId, composeId))).orderBy(desc(composeRevisions.number)).limit(1); return revision(row);
  }
  async findResourceOwner(raw: ComposeResourceOwnershipQueryV1): Promise<ComposeResourceOwnershipV1 | null> {
    const parsed = composeResourceOwnershipQuerySchema.safeParse(structuredClone(raw));
    if (!parsed.success) throw new ComposeRevisionError("COMPOSE_REVISION_INVALID");
    const query = parsed.data;
    const rows = await this.db.selectDistinctOn([composeRevisions.composeId]).from(composeRevisions).where(eq(composeRevisions.projectId, query.projectId))
      .orderBy(asc(composeRevisions.composeId), desc(composeRevisions.number)).limit(MAX_RESOURCE_OWNER_SCAN + 1);
    if (rows.length > MAX_RESOURCE_OWNER_SCAN) throw new ComposeRevisionError("COMPOSE_REVISION_CONFLICT");
    const matches = rows.map((row) => revision(row)!).flatMap((current) => (query.kind === "network" ? current.preview.networks : current.preview.volumes)
      .filter((resource) => resource.key === query.key).map((resource) => ({ current, resource })));
    if (matches.length > 1) throw new ComposeRevisionError("COMPOSE_REVISION_CONFLICT");
    const match = matches[0];
    if (!match || match.current.preview.configDigest !== query.expectedConfigDigest) return null;
    if (match.resource.runtimeName !== composeRuntimeResourceName(query.projectId, query.kind, query.key)) throw new ComposeRevisionError("COMPOSE_REVISION_INVALID");
    const [owner] = await this.db.select().from(composeResources)
      .where(and(eq(composeResources.projectId, query.projectId), eq(composeResources.id, match.current.composeId))).limit(1);
    if (!owner) return null;
    return composeResourceOwnershipSchema.parse({ schemaVersion: 1, projectId: match.current.projectId, composeId: match.current.composeId, ownerUserId: owner.createdBy,
      revisionId: match.current.id, revisionNumber: match.current.number, kind: query.kind, key: match.resource.key,
      runtimeName: match.resource.runtimeName, configDigest: match.current.preview.configDigest });
  }
  async listRevisions(projectId: string, composeId: string, options: ComposeRevisionPageOptions): Promise<ComposeRevisionPage> {
    validateComposePageOptions(options); const condition = and(eq(composeRevisions.projectId, projectId), eq(composeRevisions.composeId, composeId));
    const records = await this.db.select().from(composeRevisions).where(condition).orderBy(desc(composeRevisions.number)).limit(options.limit).offset(options.offset);
    const [total] = await this.db.select({ value: count() }).from(composeRevisions).where(condition);
    return { ...options, total: total?.value ?? 0, revisions: records.map((row) => revision(row)!) };
  }
  async listResources(projectId: string, options: ComposeRevisionPageOptions): Promise<ComposeResourcePage> {
    validateComposePageOptions(options);
    const rows = await this.db.selectDistinctOn([composeRevisions.composeId]).from(composeRevisions).where(eq(composeRevisions.projectId, projectId))
      .orderBy(asc(composeRevisions.composeId), desc(composeRevisions.number)).limit(options.limit).offset(options.offset);
    const [total] = await this.db.select({ value: count() }).from(composeResources).where(eq(composeResources.projectId, projectId));
    return composeResourcePageSchema.parse({ ...options, total: total?.value ?? 0, resources: rows.map((row) => composeResourceMetadata(revision(row)!)) });
  }
}
