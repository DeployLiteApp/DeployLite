import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { managedDatabaseProfileRequestSchema } from "@deploylite/contracts";
import { awaitAbortable, digestControlInput, managedDatabaseCredentialKey, prepareManagedDatabaseInventory, PolicyEvaluator,
  type EnvSecretValueRepository, type EncryptedEnvSecretValueRecord, type ManagedDatabaseInventoryPreparation } from "@deploylite/domain";
import type { ManagedDatabaseRuntimePreviewOptions } from "./managed-database-runtime-preview.js";
import type { ManagedDatabaseRuntimeApplyAccess } from "./managed-database-runtime-apply.js";
import type { ManagedDatabaseStopAccess } from "./managed-database-stop.js";
import { recoverManagedDatabaseSources } from "./managed-database-source-recovery.js";
import {validateManagedDatabaseRemovalHistory, isOriginalManagedDatabaseRemoved} from "./managed-database-inventory-removals.js";
export type ManagedDatabaseInventoryRouteOptions = ManagedDatabaseRuntimePreviewOptions & Readonly<{
  inventory: Pick<EnvSecretValueRepository, "listEncryptedByProject">;
  runtimeExecutions?: ReadonlyMap<string, ManagedDatabaseRuntimeApplyAccess>;
  stopExecutions?: ReadonlyMap<string, ManagedDatabaseStopAccess>;
}>;
const paramsSchema = managedDatabaseProfileRequestSchema.pick({projectId: true}).strict(), querySchema = z.object({}).strict();
/** Existing private secret rows and immutable original caches; current grants own every read. */
export function registerManagedDatabaseInventoryRoute(app: FastifyInstance, options: ManagedDatabaseInventoryRouteOptions): void {
  app.get(`${options.prefix}/projects/:projectId/databases`, {preHandler: [options.requireAuth, options.requireRole]}, async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const reject = (status: number, code: string) => reply.code(status).send(options.error(request, code, "Database inventory is unavailable or outside policy."));
    if (!params.success || !querySchema.safeParse(request.query).success || request.body !== undefined) return reject(400, "VALIDATION_ERROR");
    const user = request.auth?.user, context = request.correlationContext;
    if (!user || !context) return reject(401, "UNAUTHENTICATED");
    const projectId = params.data.projectId, configuration = options.configuration, deadlineMs = configuration?.deadlineMs;
    const validDeadline = Number.isSafeInteger(deadlineMs) && deadlineMs! > 0 && deadlineMs! <= 60000;
    const controller = new AbortController(), cancel = () => controller.abort(), startedAt = Date.now();
    const timer = setTimeout(cancel, validDeadline ? deadlineMs : 60000);
    request.raw.once("aborted", cancel); if (request.raw.aborted) cancel();
    const bounded = <T>(work: () => Promise<T>) => awaitAbortable(work, controller.signal);
    const authorize = async () => new PolicyEvaluator().evaluate({actorId: user.id, role: user.role, action: "project.update",
      scope: {kind: "project", projectId}, correlationId: context.correlationId, grants: await bounded(() => options.grants.listForActor(user.id))}).allowed;
    try {
      if (!await authorize()) return reject(403, "FORBIDDEN");
      const project = await bounded(() => options.projects.findById(projectId));
      if (!project) return reject(404, "NOT_FOUND");
      const cipher = options.cipher, store = configuration?.store ?? options.secrets, projectIds = configuration?.projectIds;
      const runtime = options.runtimeExecutions?.get(projectId), stop = options.stopExecutions?.get(projectId);
      if (!configuration || !validDeadline || !cipher || !store || project.id !== projectId || (projectIds !== undefined && !projectIds.has(projectId))
        || !runtime || !stop || runtime.controls !== stop.controls || runtime.transport !== stop.originalTransport || runtime.agentId !== stop.agentId
        || typeof runtime.controls.findProjectUpdatesByInputDigest !== "function" || !runtime.transport.available()) return reject(503, "DATABASE_RUNTIME_UNAVAILABLE");
      const profiles = configuration.profiles, configuredStore = configuration.store, profileDigest = digestControlInput([...profiles]);
      const policy = structuredClone(options.imagePolicy), policyDigest = digestControlInput(policy);
      const inventory = options.inventory, list = inventory.listEncryptedByProject, find = store.find, decrypt = cipher.decrypt, fingerprint = cipher.fingerprint;
      const removalReader = runtime.controls.findManagedDatabaseRemovals;
      const runtimeSnapshot = {...runtime}, stopSnapshot = {...stop};
      const current = () => {
        try {return !controller.signal.aborted && Date.now() >= startedAt && Date.now() < startedAt + deadlineMs!
          && options.configuration === configuration && configuration.deadlineMs === deadlineMs && configuration.profiles === profiles
          && digestControlInput([...profiles]) === profileDigest && configuration.projectIds === projectIds && (projectIds === undefined || projectIds.has(projectId))
          && configuration.store === configuredStore && (configuration.store ?? options.secrets) === store && store.find === find
          && options.cipher === cipher && cipher.decrypt === decrypt && cipher.fingerprint === fingerprint
          && digestControlInput(options.imagePolicy) === policyDigest && options.inventory === inventory && inventory.listEncryptedByProject === list
          && options.runtimeExecutions?.get(projectId) === runtime && options.stopExecutions?.get(projectId) === stop
          && runtime.controls.findManagedDatabaseRemovals === removalReader
          && Object.entries(runtimeSnapshot).every(([key, value]) => runtime[key as keyof typeof runtime] === value)
          && Object.entries(stopSnapshot).every(([key, value]) => stop[key as keyof typeof stop] === value);
        } catch {return false;}
      };
      const fence = async () => {if (!current() || !await authorize() || !current()) throw new Error("unavailable");};
      const readRows = async () => {
        const rows = await bounded(() => list.call(inventory, projectId)); await fence();
        return rows.map(row => ({...row, encryptedValue: Buffer.from(row.encryptedValue)}));
      };
      const rowsDigest = (rows: readonly EncryptedEnvSecretValueRecord[]) => digestControlInput(rows.filter(row => row.key.startsWith("DEPLOYLITE_DATABASE_"))
        .map(row => ({...row, encryptedValue: Buffer.from(row.encryptedValue)})).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
      const sameSelectedRow = async (item: ManagedDatabaseInventoryPreparation, rows: readonly EncryptedEnvSecretValueRecord[]) => {
        const key = managedDatabaseCredentialKey(projectId, item.preparation.databaseId), original = rows.find(row => row.key === key && row.scope === "project");
        const selected = await bounded(() => find.call(store, projectId, key)); await fence();
        if (!original || !selected || !Buffer.isBuffer(selected.encryptedValue) || !selected.encryptedValue.equals(original.encryptedValue)
          || selected.id !== original.id || selected.projectId !== projectId || selected.key !== key || selected.scope !== original.scope
          || selected.keyVersion !== original.keyVersion || selected.valueFingerprint !== original.valueFingerprint || selected.valuePresent !== original.valuePresent) throw new Error("unavailable");
      };
      await fence();
      const rows = await readRows(), initialDigest = rowsDigest(rows);
      const prepared = prepareManagedDatabaseInventory(projectId, rows, {cipher, imagePolicy: policy, profiles}); await fence();
      const readRemovals = async () => {
        if (!removalReader) return null;
        const commands = await bounded(() => removalReader.call(runtime.controls, projectId)); await fence();
        return validateManagedDatabaseRemovalHistory(projectId, commands);
      };
      const removals = await readRemovals();
      const databases = [];
      for (const item of prepared) {
        await sameSelectedRow(item, rows);
        const sources = await recoverManagedDatabaseSources({controls: runtime.controls, originalTransport: runtime.transport, stopTransport: stop.transport,
          agentId: runtime.agentId, deadlineMs: runtime.deadlineMs, now: runtime.now}, {preparation: item.preparation, context, authorize, current, signal: controller.signal});
        await fence();
        if (sources.source && !removals) throw new Error("Retirement history is unavailable");
        if (!sources.source || !isOriginalManagedDatabaseRemoved(sources.source, removals!.receipts)) databases.push({...item, ...sources});
      }
      await bounded(() => options.audit.append({actorUserId: user.id, action: "database.inventory.read", targetType: "project", targetId: projectId,
        ...context, metadata: {databaseCount: databases.length, redacted: true}})); await fence();
      const freshRows = await readRows();
      if (rowsDigest(freshRows) !== initialDigest || digestControlInput(prepareManagedDatabaseInventory(projectId, freshRows, {cipher, imagePolicy: policy, profiles})) !== digestControlInput(prepared)) throw new Error("unavailable");
      for (const item of prepared) await sameSelectedRow(item, freshRows);
      const freshRemovals = await readRemovals();
      if (freshRemovals?.fingerprint !== removals?.fingerprint) throw new Error("Retirement history changed");
      await fence();
      const response = options.ok(request, {databases});
      if (Buffer.byteLength(JSON.stringify(response), "utf8") > 2 * 1024 * 1024) throw new Error("unavailable");
      await fence(); return response;
    } catch {return reject(503, "DATABASE_RUNTIME_UNAVAILABLE");}
    finally {clearTimeout(timer); request.raw.off("aborted", cancel);}
  });
}
