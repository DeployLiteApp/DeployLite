import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { composeRevisionSchema, composeResourcePageSchema, type ComposeRevisionV1, type ComposeRevisionSaved, type ComposeResourcePage } from "@deploylite/contracts";
import { validatePreparedComposeRevisionSave, buildComposeRevisionSave, replayComposeRevisionSave, composeRevisionSaveAudit, composeResourceMetadata,
  validateComposePageOptions, ComposeRevisionError, type ComposeRevisionSaveStore, type PreparedComposeRevisionSave, type ComposeRevisionPageOptions, type ComposeRevisionPage } from "@deploylite/domain";
import type { DeployLiteDb } from "../client.js";
import { auditEvents, controlCommandAudits, controlCommands, composeResources, composeRevisions, type ComposeRevisionRow } from "../schema.js";
import { redactAuditMetadata } from "./auth.js";
import { resolveControlCommandOn } from "./control-plane.js";

type Reader = Pick<DeployLiteDb, "select">;
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
