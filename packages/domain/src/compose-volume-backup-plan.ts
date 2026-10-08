import { COMPOSE_PREVIEW_MAX_BYTES,COMPOSE_RESOURCE_INSPECTION_CAPABILITY,composeVolumeBackupPlanSchema,composeVolumeBackupPlanRequestSchema,composeVolumeBackupPlanningProfileSchema,composeVolumeBackupPlanReceiptSchema,
  type CapabilityRegistry,type CanonicalRole,type ComposeVolumeBackupPlanV1,type ComposeVolumeBackupPlanReceiptV1,type ComposeVolumeBackupPlanningProfile } from "@deploylite/contracts";
import type { AuditEventInput } from "./index.js";
import { awaitAbortable } from "./deployment-contract/docker-image-executor.js";
import { ComposeResourceInspectionError,createComposeResourceInspectionView,type ComposeAttachmentPreviewDependencies } from "./compose-resource-inspection.js";
import { createControlCommand,digestControlInput,IdempotencyConflictError,PolicyEvaluator,resolveControlCommandInMemory,type ControlCommand,type ControlGrantRepository } from "./control-plane.js";

export type ComposeVolumeBackupPlanningDependencies={inspection:ComposeAttachmentPreviewDependencies;capabilities:CapabilityRegistry;profiles:ReadonlyMap<string,ComposeVolumeBackupPlanningProfile>;
  actorId:string;role:CanonicalRole;correlationId:string;requestId:string;idempotencyKey:string;grants:ControlGrantRepository;deadlineMs:number};
export type PreparedComposeVolumeBackupPlan={command:ControlCommand;plan:ComposeVolumeBackupPlanV1;owner:string;agentId:string;requestId:string;preparedAtMs:number};
export type ComposeBackupPlanningErrorCode="COMPOSE_BACKUP_INVALID"|"COMPOSE_BACKUP_FORBIDDEN"|"COMPOSE_BACKUP_UNAVAILABLE"|"COMPOSE_BACKUP_FOREIGN"|"COMPOSE_BACKUP_STALE"|"COMPOSE_BACKUP_IN_USE"|"COMPOSE_BACKUP_FAILED"|"COMPOSE_BACKUP_EXPIRED";
export class ComposeBackupPlanningError extends Error{
  constructor(readonly code:ComposeBackupPlanningErrorCode){super("Volume backup planning is unavailable or outside policy.");this.name="ComposeBackupPlanningError";}
}
function fail(code:ComposeBackupPlanningErrorCode):never{throw new ComposeBackupPlanningError(code);}
const identifier=/^[A-Za-z0-9_-]{1,200}$/;
function binding(plan:ComposeVolumeBackupPlanV1,owner:string,agentId:string){
  const {planDigest:_digest,...intent}=plan;return{...intent,owner,agentId};
}
function fingerprint(plan:ComposeVolumeBackupPlanV1,owner:string,agentId:string):string{
  return digestControlInput(binding(plan,owner,agentId));
}
/** Plans metadata only. A stopped snapshot is not a lock or authority to copy data later. */
export async function prepareComposeVolumeBackupPlan(raw:unknown,supplied:ComposeVolumeBackupPlanningDependencies,signal?:AbortSignal):Promise<PreparedComposeVolumeBackupPlan>{
  try{
    const parsed=composeVolumeBackupPlanRequestSchema.safeParse(raw);
    if(!parsed.success||new TextEncoder().encode(parsed.data.document).length>COMPOSE_PREVIEW_MAX_BYTES)fail("COMPOSE_BACKUP_INVALID");
    const input=parsed.data,subject={actorId:supplied.actorId,role:supplied.role,correlationId:supplied.correlationId,requestId:supplied.requestId,idempotencyKey:supplied.idempotencyKey};
    if(![subject.actorId,subject.correlationId,subject.requestId,subject.idempotencyKey].every(value=>identifier.test(value))||!Number.isSafeInteger(supplied.deadlineMs)||supplied.deadlineMs<1||supplied.deadlineMs>60_000)fail("COMPOSE_BACKUP_INVALID");
    if(signal?.aborted)fail("COMPOSE_BACKUP_FAILED");
    const inspection={...supplied.inspection,imagePolicy:structuredClone(supplied.inspection.imagePolicy)},capabilities=supplied.capabilities,profiles=supplied.profiles,deadline=supplied.deadlineMs;
    const decision=new PolicyEvaluator().evaluate({actorId:subject.actorId,role:subject.role,action:"project.deploy",scope:{kind:"project",projectId:input.projectId},correlationId:subject.correlationId,grants:await supplied.grants.listForActor(subject.actorId)});
    if(!decision.allowed)fail("COMPOSE_BACKUP_FORBIDDEN");
    const selected=profiles.get(input.destinationId);
    if(!selected||!capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY))fail("COMPOSE_BACKUP_UNAVAILABLE");
    const configured=composeVolumeBackupPlanningProfileSchema.safeParse(selected);if(!configured.success)fail("COMPOSE_BACKUP_INVALID");const profile=configured.data;
    if(profile.owner!==inspection.owner||profile.agentId!==inspection.agentId||profile.projectId!==input.projectId||profile.destinationId!==input.destinationId)fail("COMPOSE_BACKUP_FOREIGN");
    const controller=new AbortController(),cancel=()=>controller.abort();signal?.addEventListener("abort",cancel,{once:true});if(signal?.aborted)cancel();
    const timer=setTimeout(cancel,deadline);
    let observed;
    try{observed=await awaitAbortable(()=>createComposeResourceInspectionView({document:input.document,projectId:input.projectId,kind:"volume",key:input.key,expectedConfigDigest:input.expectedConfigDigest},inspection,controller.signal),controller.signal);}
    finally{clearTimeout(timer);signal?.removeEventListener("abort",cancel);}
    if(signal?.aborted)fail("COMPOSE_BACKUP_FAILED");
    if(!capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY))fail("COMPOSE_BACKUP_UNAVAILABLE");
    if(profiles.get(input.destinationId)!==selected||digestControlInput(selected)!==digestControlInput(profile))fail("COMPOSE_BACKUP_STALE");
    if(observed.stateDigest!==input.expectedStateDigest)fail("COMPOSE_BACKUP_STALE");
    if(observed.containers.some(container=>container.attached&&container.running))fail("COMPOSE_BACKUP_IN_USE");
    const now=inspection.clock.now();if(!Number.isSafeInteger(now)||now<observed.observedAt||now-observed.observedAt>inspection.maxAgeMs||!Number.isSafeInteger(now+profile.planTtlMs))fail("COMPOSE_BACKUP_STALE");
    const plan=composeVolumeBackupPlanSchema.parse({schemaVersion:1,operation:"compose.volume.backup.plan",status:"preview",executionAllowed:false,archiveCreated:false,projectId:input.projectId,volumeKey:input.key,
      configDigest:observed.configDigest,stateDigest:observed.stateDigest,profileId:profile.profileId,destinationId:profile.destinationId,consistency:"offline-required",verification:"integrity-and-completeness-required",
      limits:{maxBytes:profile.maxBytes,maxEntries:profile.maxEntries,maxDurationMs:profile.maxDurationMs,planTtlMs:profile.planTtlMs},planDigest:"0".repeat(64)});
    plan.planDigest=fingerprint(plan,inspection.owner,inspection.agentId);
    const command=createControlCommand({actorId:subject.actorId,action:"project.deploy",scope:{kind:"project",projectId:input.projectId},input:binding(plan,inspection.owner,inspection.agentId),idempotencyKey:subject.idempotencyKey,correlationId:subject.correlationId,expiresAt:new Date(now+profile.planTtlMs)});
    command.status="eligible";
    return{command,plan,owner:inspection.owner,agentId:inspection.agentId,requestId:subject.requestId,preparedAtMs:now};
  }catch(error){
    if(error instanceof ComposeBackupPlanningError)throw error;
    if(error instanceof ComposeResourceInspectionError){
      if(error.code==="COMPOSE_RESOURCE_FOREIGN")fail("COMPOSE_BACKUP_FOREIGN");
      if(error.code==="COMPOSE_RESOURCE_STALE")fail("COMPOSE_BACKUP_STALE");
      if(error.code==="COMPOSE_RESOURCE_CONFLICT"||error.code==="COMPOSE_INSPECTION_INVALID")fail("COMPOSE_BACKUP_INVALID");
    }
    fail("COMPOSE_BACKUP_FAILED");
  }
}
function validatePrepared(input:PreparedComposeVolumeBackupPlan):void{
  const plan=composeVolumeBackupPlanSchema.safeParse(input.plan),c=input.command;
  if(!plan.success||![input.owner,input.agentId,input.requestId,c.id,c.actorId,c.idempotencyKey,c.correlationId].every(value=>identifier.test(value))
    ||c.action!=="project.deploy"||c.scope.kind!=="project"||c.scope.projectId!==input.plan.projectId||c.status!=="eligible"||c.result||c.executionAuthority
    ||!Number.isSafeInteger(input.preparedAtMs)||!(c.expiresAt instanceof Date)||c.expiresAt.valueOf()!==input.preparedAtMs+input.plan.limits.planTtlMs
    ||input.plan.planDigest!==fingerprint(input.plan,input.owner,input.agentId)||c.inputDigest!==input.plan.planDigest)fail("COMPOSE_BACKUP_INVALID");
}
/** Explicit memory reference using the existing shared ledger; not a durable or production fallback. */
export class InMemoryComposeVolumeBackupPlanStore{
  constructor(private readonly options:{ledger:{commands:Map<string,ControlCommand>};appendAudit:(input:AuditEventInput)=>void;clock:()=>number}){}
  async save(raw:PreparedComposeVolumeBackupPlan):Promise<ComposeVolumeBackupPlanReceiptV1>{
    try{
      const input=structuredClone(raw);validatePrepared(input);const now=this.options.clock();if(!Number.isSafeInteger(now))fail("COMPOSE_BACKUP_FAILED");
      const staged=new Map(this.options.ledger.commands),resolved=resolveControlCommandInMemory(staged,input.command),current=resolved.command;
      if(!(current.expiresAt instanceof Date)||current.expiresAt.valueOf()<=now)fail("COMPOSE_BACKUP_EXPIRED");
      if(current.actorId!==input.command.actorId||current.action!=="project.deploy"||current.scope.kind!=="project"||current.scope.projectId!==input.plan.projectId||current.inputDigest!==input.plan.planDigest
        ||current.result||current.executionAuthority||!["eligible","completed"].includes(current.status))fail("COMPOSE_BACKUP_INVALID");
      const receipt=composeVolumeBackupPlanReceiptSchema.parse({commandId:current.id,expiresAt:current.expiresAt.toISOString(),plan:structuredClone(input.plan),idempotent:current.status==="completed"});
      if(current.status==="completed")return receipt;
      const key=[...staged].find(([,candidate])=>candidate.id===current.id)?.[0];if(!key)fail("COMPOSE_BACKUP_INVALID");
      staged.set(key,structuredClone({...current,status:"completed"}));
      const audit:AuditEventInput={actorUserId:current.actorId,action:"compose.volume.backup.planned",targetType:"project",targetId:input.plan.projectId,requestId:input.requestId,correlationId:current.correlationId,
        metadata:{commandId:current.id,inputDigest:current.inputDigest,volumeKey:input.plan.volumeKey,profileId:input.plan.profileId,destinationId:input.plan.destinationId,configDigest:input.plan.configDigest,valueFingerprint:input.plan.stateDigest}};
      const effect:unknown=this.options.appendAudit(audit);if(effect!==undefined)fail("COMPOSE_BACKUP_FAILED");
      this.options.ledger.commands=staged;return receipt;
    }catch(error){if(error instanceof ComposeBackupPlanningError||error instanceof IdempotencyConflictError)throw error;fail("COMPOSE_BACKUP_FAILED");}
  }
}
