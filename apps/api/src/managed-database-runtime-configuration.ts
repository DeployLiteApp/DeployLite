import {AuthenticatedManagedDatabaseRestoreTransport} from "./managed-database-restore-transport.js";
import type {ManagedDatabaseRestoreApplyAccess} from "./managed-database-restore-apply.js";
import {AuthenticatedManagedDatabaseRestoreArchiveTransport} from "./managed-database-restore-archive-transport.js";
import type {ManagedDatabaseRestorePreparationAccess} from "./managed-database-restore-prepare.js";
import {AuthenticatedManagedDatabaseBackupTransport} from "./managed-database-backup-transport.js";
import type {ManagedDatabaseBackupAccess} from "./managed-database-backup.js";
import type {BackupInventoryReader,BackupInventoryWriter,BackupRetentionProtectionReader} from "@deploylite/domain";
import type {BackupRetentionPreviewAccess} from "./backup-retention-preview-route.js";
import type {ComposeVolumeBackupPlanAccess} from "./compose-volume-backup-plan-route.js";
import {AuthenticatedManagedDatabaseDeleteTransport} from "./managed-database-delete-transport.js";
import type {ManagedDatabaseDeleteApplyAccess} from "./managed-database-delete-apply.js";
import type {ManagedDatabaseDeletePreparationAccess} from "./managed-database-delete-prepare.js";
import {AuthenticatedManagedDatabaseLogsTransport} from "./managed-database-logs-transport.js";
import type {ManagedDatabaseLogsAccess} from "./managed-database-logs.js";
import {AuthenticatedManagedDatabaseMetricsTransport} from "./managed-database-metrics-transport.js";
import type {ManagedDatabaseMetricsAccess} from "./managed-database-metrics.js";
import {AuthenticatedManagedDatabaseHealthTransport} from "./managed-database-health-transport.js";
import type {ManagedDatabaseHealthAccess} from "./managed-database-health.js";
import { AuthenticatedManagedDatabaseStartTransport } from "./managed-database-start-transport.js";
import type { ManagedDatabaseStartAccess } from "./managed-database-start.js";
import { AuthenticatedManagedDatabaseStopTransport } from "./managed-database-stop-transport.js";
import type { ManagedDatabaseStopAccess } from "./managed-database-stop.js";
import { managedDatabaseNativeImagePolicy, parseManagedDatabaseRuntimeConfiguration, type ProjectRepository } from "@deploylite/domain";
import type { ManagedDatabaseCredentialCreationRepository } from "@deploylite/domain";
import { parseComposeResourceProjectBindings, projectUpdateControls } from "./compose-resource-runtime.js";
import { AuthenticatedManagedDatabaseRuntimeTransport } from "./managed-database-runtime-transport.js";
import type { ManagedDatabaseRuntimeApplyAccess } from "./managed-database-runtime-apply.js";
import type { ManagedDatabaseCredentialConfiguration } from "./managed-database-credentials-route.js";
import { awaitAbortable } from "@deploylite/domain";
export const MANAGED_DATABASE_PROJECT_AGENTS_ENV = "DEPLOYLITE_MANAGED_DATABASE_PROJECT_AGENTS_JSON" as const;
export function parseManagedDatabaseApiConfiguration(raw: string | undefined, rawBindings: string | undefined) {
  if (raw === undefined && rawBindings === undefined) return undefined;
  try {
    const configuration = parseManagedDatabaseRuntimeConfiguration(raw);
    if (!configuration || rawBindings === undefined || rawBindings.length > 65536) throw new Error();
    const bindings = parseComposeResourceProjectBindings(rawBindings);
    if (!bindings.length) throw new Error();
    return { configuration, bindings };
  } catch { throw new Error("Database API configuration is invalid."); }
}
/** Existing authenticated endpoint/repositories only; explicit project binding supplies no network/runtime effect. */
export async function createConfiguredManagedDatabaseApi(input: Readonly<{
  parsed: NonNullable<ReturnType<typeof parseManagedDatabaseApiConfiguration>>;
  projects: Pick<ProjectRepository, "findById">; controls: unknown; secrets?: ManagedDatabaseCredentialCreationRepository;
  agent: Readonly<{ endpoint?: string; agentId?: string; trustKey?: string }>;
  backupInventory?: (agentId:string)=>BackupInventoryWriter & Partial<BackupInventoryReader>;
  restoreProtection?: (agentId:string)=>ManagedDatabaseRestorePreparationAccess["protection"] & Partial<Pick<ManagedDatabaseRestoreApplyAccess["protection"],"assertProtected">> & Partial<BackupRetentionProtectionReader>;
  backupPlanning?: ReadonlyMap<string, ComposeVolumeBackupPlanAccess>;
}>) {
  const controls = projectUpdateControls(input.controls), secrets = input.secrets;
  let parsed: NonNullable<ReturnType<typeof parseManagedDatabaseApiConfiguration>>;
  try { parsed = parseManagedDatabaseApiConfiguration(JSON.stringify(input.parsed.configuration), JSON.stringify(input.parsed.bindings))!; }
  catch { throw new Error("Database API configuration is invalid."); }
  const { configuration, bindings } = parsed, { endpoint, agentId, trustKey } = input.agent;
  if (!controls || !secrets || !endpoint || !agentId || !trustKey) throw new Error("Database API configuration is invalid.");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), configuration.limits.deadlineMs);
  try {
    const transport = new AuthenticatedManagedDatabaseRuntimeTransport({ endpoint, agentId, trustKey, allowInsecureInternal: true, timeoutMs: configuration.limits.deadlineMs });
    if (!transport.available()) throw new Error();
    const executions = new Map<string, ManagedDatabaseRuntimeApplyAccess>();
    const backupExecutions = new Map<string,ManagedDatabaseBackupAccess>();
    const backupMaxBytes = configuration.limits.backupMaxBytes, inventoryFactory = input.backupInventory;
    if (backupMaxBytes !== undefined && (typeof controls.findProjectUpdateById !== "function" || typeof inventoryFactory !== "function")) throw new Error();
    const backupTransport = typeof controls.findProjectUpdateById === "function" && typeof inventoryFactory === "function" ? new AuthenticatedManagedDatabaseBackupTransport({endpoint,agentId,trustKey,allowInsecureInternal:true,timeoutMs:configuration.limits.deadlineMs}) : undefined;
    const backupInventory = backupTransport ? inventoryFactory!(agentId) : undefined;
    if (backupTransport && (!backupTransport.available() || !backupInventory?.available())) throw new Error();
    const restorePreparations=new Map<string,ManagedDatabaseRestorePreparationAccess>();
    const restoreExecutions=new Map<string,ManagedDatabaseRestoreApplyAccess>();
    const restoreInventory=backupInventory && typeof backupInventory.list==="function" ? backupInventory as BackupInventoryReader & BackupInventoryWriter : undefined;
    const backupProtection = backupMaxBytes !== undefined && restoreInventory && typeof input.restoreProtection === "function" ? input.restoreProtection(agentId) : undefined;
    const restoreEnabled=backupMaxBytes!==undefined && restoreInventory && typeof controls.findProjectUpdateById==="function" && typeof controls.resolveProjectUpdateConfirmation==="function" && typeof input.restoreProtection==="function";
    const restoreArchive=restoreEnabled?new AuthenticatedManagedDatabaseRestoreArchiveTransport({endpoint,agentId,trustKey,allowInsecureInternal:true,timeoutMs:configuration.limits.deadlineMs}):undefined;
    const restoreProtection=restoreEnabled?backupProtection:undefined;
    if(restoreArchive && (!restoreArchive.available() || typeof restoreProtection?.protect!=="function"))throw new Error();
    const restoreApplyProtection=restoreProtection && typeof restoreProtection.assertProtected==="function" ? restoreProtection as ManagedDatabaseRestoreApplyAccess["protection"] : undefined;
    const restoreApplyEnabled=restoreArchive && restoreInventory && restoreApplyProtection && [controls.claimConfirmedProjectUpdate,controls.completeManagedDatabaseRestore,controls.validateConfirmedProjectUpdateAuthority].every(port=>typeof port==="function");
    const restoreTransport=restoreApplyEnabled?new AuthenticatedManagedDatabaseRestoreTransport({endpoint,agentId,trustKey,allowInsecureInternal:true,timeoutMs:configuration.limits.deadlineMs}):undefined;
    if(restoreTransport && !restoreTransport.available())throw new Error();
    const stopExecutions = new Map<string, ManagedDatabaseStopAccess>();
    const startExecutions = new Map<string, ManagedDatabaseStartAccess>();
    const deletePreparations = new Map<string,ManagedDatabaseDeletePreparationAccess>();
    const deleteExecutions = new Map<string,ManagedDatabaseDeleteApplyAccess>();
    const healthExecutions = new Map<string,ManagedDatabaseHealthAccess>();
    const logsExecutions = new Map<string, ManagedDatabaseLogsAccess>();
    const logsTransport = typeof controls.findProjectUpdateById === "function" ? new AuthenticatedManagedDatabaseLogsTransport({endpoint, agentId, trustKey, allowInsecureInternal: true, timeoutMs: configuration.limits.deadlineMs}) : undefined;
    const metricsExecutions = new Map<string,ManagedDatabaseMetricsAccess>();
    const healthTransport = typeof controls.findProjectUpdateById === "function" ? new AuthenticatedManagedDatabaseHealthTransport({endpoint,agentId,trustKey,allowInsecureInternal:true,timeoutMs:configuration.limits.deadlineMs}) : undefined;
    const metricsTransport = typeof controls.findProjectUpdateById === "function" ? new AuthenticatedManagedDatabaseMetricsTransport({endpoint,agentId,trustKey,allowInsecureInternal:true,timeoutMs:configuration.limits.deadlineMs}) : undefined;
    const startEnabled = typeof controls.findProjectUpdateById === "function";
    const startTransport = startEnabled ? new AuthenticatedManagedDatabaseStartTransport({ endpoint, agentId, trustKey,
      allowInsecureInternal: true, timeoutMs: configuration.limits.deadlineMs }) : undefined;
    const stopEnabled = configuration.limits.stopGraceSeconds !== undefined;
    if (stopEnabled && typeof controls.findProjectUpdateById !== "function") throw new Error();
    const stopTransport = (stopEnabled || startEnabled) ? new AuthenticatedManagedDatabaseStopTransport({ endpoint, agentId, trustKey,
      allowInsecureInternal: true, timeoutMs: configuration.limits.deadlineMs }) : undefined;
    const deleteEnabled=stopEnabled && [controls.findProjectUpdateById,controls.resolveProjectUpdateConfirmation,controls.claimConfirmedProjectUpdate,controls.completeManagedDatabaseDelete,controls.validateConfirmedProjectUpdateAuthority,controls.findManagedDatabaseRemovals].every(port=>typeof port==="function");
    const deleteTransport=deleteEnabled?new AuthenticatedManagedDatabaseDeleteTransport({endpoint,agentId,trustKey,allowInsecureInternal:true,timeoutMs:configuration.limits.deadlineMs}):undefined;
    for (const binding of bindings) {
      if (binding.agentId !== agentId || executions.has(binding.projectId)) throw new Error();
      const project = await awaitAbortable(() => input.projects.findById(binding.projectId), controller.signal);
      if (!project || project.id !== binding.projectId) throw new Error();
      if (backupTransport && backupInventory) backupExecutions.set(binding.projectId,{controls,transport:backupTransport,originalTransport:transport,inventory:backupInventory,agentId,maxBytes:backupMaxBytes ?? 0,now:Date.now,commandTtlMs:configuration.limits.deadlineMs,deadlineMs:configuration.limits.deadlineMs});
      if(restoreArchive && restoreInventory && restoreProtection)restorePreparations.set(binding.projectId,{controls,originalTransport:transport,inventory:restoreInventory,protection:restoreProtection,archive:restoreArchive,agentId,now:Date.now,commandTtlMs:configuration.limits.deadlineMs,deadlineMs:configuration.limits.deadlineMs});
      if(restoreTransport && restoreArchive && restoreInventory && restoreApplyProtection)restoreExecutions.set(binding.projectId,{controls,originalTransport:transport,transport:restoreTransport,inventory:restoreInventory,protection:restoreApplyProtection,archive:restoreArchive,agentId,now:Date.now,commandTtlMs:configuration.limits.deadlineMs,deadlineMs:configuration.limits.deadlineMs});
      executions.set(binding.projectId, { controls, transport, agentId, now: Date.now,
        commandTtlMs: configuration.limits.deadlineMs, deadlineMs: configuration.limits.deadlineMs });
      if (healthTransport) healthExecutions.set(binding.projectId,{controls,transport:healthTransport,originalTransport:transport,agentId,now:Date.now,deadlineMs:configuration.limits.deadlineMs});
      if (logsTransport) logsExecutions.set(binding.projectId, {controls, transport: logsTransport, originalTransport: transport, agentId, now: Date.now, deadlineMs: configuration.limits.deadlineMs});
      if (metricsTransport) metricsExecutions.set(binding.projectId,{controls,transport:metricsTransport,originalTransport:transport,agentId,now:Date.now,deadlineMs:configuration.limits.deadlineMs});
      if (stopEnabled && stopTransport) stopExecutions.set(binding.projectId, { controls, transport: stopTransport, originalTransport: transport,
        agentId, now: Date.now, commandTtlMs: configuration.limits.deadlineMs, deadlineMs: configuration.limits.deadlineMs });
      if (typeof controls.findProjectUpdateById === "function" && typeof controls.resolveProjectUpdateConfirmation === "function")
        deletePreparations.set(binding.projectId,{controls,originalTransport:transport,originalStopTransport:stopTransport,agentId,now:Date.now,commandTtlMs:configuration.limits.deadlineMs,deadlineMs:configuration.limits.deadlineMs});
      if(deleteTransport)deleteExecutions.set(binding.projectId,{controls,transport:deleteTransport,originalTransport:transport,originalStopTransport:stopTransport,agentId,now:Date.now,deadlineMs:configuration.limits.deadlineMs});
      if (startTransport && stopTransport) startExecutions.set(binding.projectId, { controls, transport: startTransport, originalTransport: transport, originalStopTransport: stopTransport,
        agentId, now: Date.now, commandTtlMs: configuration.limits.deadlineMs, deadlineMs: configuration.limits.deadlineMs });
    }
    const credentials: ManagedDatabaseCredentialConfiguration = { profiles: new Map(Object.entries(configuration.profiles) as [keyof typeof configuration.profiles, typeof configuration.profiles.postgres][]),
      store: secrets, projectIds: new Set(bindings.map(binding => binding.projectId)), deadlineMs: configuration.limits.deadlineMs };
    const imagePolicy = managedDatabaseNativeImagePolicy(), backupRetentionPreviews = new Map<string, BackupRetentionPreviewAccess>();
    const planning = input.backupPlanning;
    // No empty-protection fallback: native preview is composed only from the existing durable readers.
    if (restoreInventory && backupProtection && typeof backupProtection.list === "function" && typeof backupProtection.available === "function"
      && backupProtection.available() && planning) {
      for (const binding of bindings) if (planning.has(binding.projectId)) backupRetentionPreviews.set(binding.projectId, {
        agentId, inventory: restoreInventory, protections: backupProtection as BackupRetentionProtectionReader,
        deadlineMs: configuration.limits.deadlineMs, native: {configuration: credentials, imagePolicy, planning}
      });
    }
    return { credentials, executions, restorePreparations, restoreExecutions, backupExecutions, backupRetentionPreviews, stopExecutions, startExecutions, deletePreparations, deleteExecutions, healthExecutions, metricsExecutions, logsExecutions, imagePolicy };
  } catch { throw new Error("Database API configuration is invalid."); }
  finally { clearTimeout(timer); }
}
