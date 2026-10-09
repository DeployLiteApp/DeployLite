import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { COMPOSE_PREVIEW_MAX_BYTES,COMPOSE_RESOURCE_INSPECTION_CAPABILITY,composeVolumeBackupPlanApiRequestSchema,composeVolumeBackupPlanningProfileSchema,composeVolumeBackupPlanReceiptSchema,
  type ComposeVolumeBackupPlanningProfile,type ComposeVolumeBackupPlanReceiptV1 } from "@deploylite/contracts";
import { awaitAbortable,ComposeBackupPlanningError,ComposePreviewError,createComposePreview,digestControlInput,IdempotencyConflictError,PolicyEvaluator,prepareComposeVolumeBackupPlan,
  type ComposeVolumeBackupPlanStore,type PreparedComposeVolumeBackupPlan } from "@deploylite/domain";
import type { ComposeResourceRouteOptions } from "./compose-resource-inspection-route.js";

export type ComposeVolumeBackupPlanAccess=Readonly<{profiles:ReadonlyMap<string,ComposeVolumeBackupPlanningProfile>;store:ComposeVolumeBackupPlanStore}>;
type Options=ComposeResourceRouteOptions&Readonly<{planning?:ReadonlyMap<string,ComposeVolumeBackupPlanAccess>}>;
function fail(code:ConstructorParameters<typeof ComposeBackupPlanningError>[0]):never{throw new ComposeBackupPlanningError(code);}
function verifyReceipt(raw:unknown,prepared:PreparedComposeVolumeBackupPlan,now:number):ComposeVolumeBackupPlanReceiptV1{
  const parsed=composeVolumeBackupPlanReceiptSchema.safeParse(raw);if(!parsed.success)fail("COMPOSE_BACKUP_INVALID");const receipt=parsed.data;
  if(digestControlInput(receipt.plan)!==digestControlInput(prepared.plan)||(!receipt.idempotent&&receipt.commandId!==prepared.command.id)
    ||!Number.isSafeInteger(now)||Date.parse(receipt.expiresAt)<=now||Date.parse(receipt.expiresAt)>prepared.command.expiresAt.valueOf())fail("COMPOSE_BACKUP_INVALID");
  return receipt;
}
/** Explicit metadata-plan composition only; this route cannot create or copy an archive. */
export function registerComposeVolumeBackupPlanRoute(app:FastifyInstance,options:Options):void{
  app.post(`${options.prefix}/projects/:projectId/compose/volumes/backup/preview`,{bodyLimit:131_072,preHandler:[options.requireAuth,options.requireRole]},async(request,reply)=>{
    const {projectId}=z.object({projectId:z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/)}).parse(request.params),actorId=request.auth!.user.id;
    const audit=(suffix:string,reason:string)=>options.audit.append({actorUserId:actorId,action:`compose.volume.backup.plan.${suffix}`,targetType:"project",targetId:projectId,...request.correlationContext,metadata:{projectId,reason}});
    const decision=new PolicyEvaluator().evaluate({actorId,role:request.auth!.user.role,action:"project.deploy",scope:{kind:"project",projectId},correlationId:request.correlationContext.correlationId,grants:await options.grants.listForActor(actorId)});
    if(!decision.allowed){await audit("denied",decision.code);return reply.code(403).send(options.error(request,decision.code,"Backup planning is not authorized."));}
    if(!await options.projects.findById(projectId))return reply.code(404).send(options.error(request,"NOT_FOUND","Project was not found."));
    const body=composeVolumeBackupPlanApiRequestSchema.safeParse(request.body),idempotencyKey=request.headers["idempotency-key"];
    if(!body.success||typeof idempotencyKey!=="string"||!/^[A-Za-z0-9_-]{1,200}$/.test(idempotencyKey)||new TextEncoder().encode(body.data.document).length>COMPOSE_PREVIEW_MAX_BYTES){
      await audit("rejected","invalid-request");return reply.code(400).send(options.error(request,"VALIDATION_ERROR","Request validation failed."));
    }
    const input={...body.data,projectId};let receipt:ComposeVolumeBackupPlanReceiptV1;
    try{
      const preview=createComposePreview(input.document,projectId,options.imagePolicy);if(preview.configDigest!==input.expectedConfigDigest)fail("COMPOSE_BACKUP_STALE");
      const selectedInspection=options.access?.get(projectId),selectedPlan=options.planning?.get(projectId);
      if(!selectedInspection||!selectedPlan||!selectedInspection.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY)||!selectedPlan.store.available())fail("COMPOSE_BACKUP_UNAVAILABLE");
      const configured=selectedPlan.profiles.get(input.destinationId),profile=composeVolumeBackupPlanningProfileSchema.safeParse(configured);
      if(!configured||!profile.success)fail("COMPOSE_BACKUP_UNAVAILABLE");
      const profileDigest=digestControlInput(profile.data),inspection={...selectedInspection,imagePolicy:structuredClone(options.imagePolicy)},store=selectedPlan.store,profiles=selectedPlan.profiles;
      if(!Number.isSafeInteger(inspection.deadlineMs)||inspection.deadlineMs<1||inspection.deadlineMs>60_000)fail("COMPOSE_BACKUP_UNAVAILABLE");
      const controller=new AbortController(),cancel=()=>controller.abort(new ComposeBackupPlanningError("COMPOSE_BACKUP_FAILED"));
      const timer=setTimeout(cancel,inspection.deadlineMs);request.raw.once("aborted",cancel);if(request.raw.aborted)cancel();
      const current=()=>{
        if(!inspection.capabilities.has(COMPOSE_RESOURCE_INSPECTION_CAPABILITY)||!store.available())fail("COMPOSE_BACKUP_UNAVAILABLE");
        if(options.access?.get(projectId)!==selectedInspection||options.planning?.get(projectId)!==selectedPlan||selectedPlan.store!==store||selectedPlan.profiles!==profiles
          ||profiles.get(input.destinationId)!==configured||digestControlInput(configured)!==profileDigest)fail("COMPOSE_BACKUP_STALE");
      };
      try{
        const prepared=await awaitAbortable(()=>prepareComposeVolumeBackupPlan(input,{inspection,capabilities:inspection.capabilities,profiles,
          actorId,role:request.auth!.user.role,correlationId:request.correlationContext.correlationId,requestId:request.correlationContext.requestId,idempotencyKey,grants:options.grants,deadlineMs:inspection.deadlineMs},controller.signal),controller.signal);
        current();const raw=await awaitAbortable(()=>store.save(structuredClone(prepared),controller.signal),controller.signal);current();
        receipt=verifyReceipt(raw,prepared,inspection.clock.now());
      }finally{clearTimeout(timer);request.raw.off("aborted",cancel);}
    }catch(error){
      const known=error instanceof ComposeBackupPlanningError||error instanceof ComposePreviewError||error instanceof IdempotencyConflictError;
      const code=known?error.code:"COMPOSE_BACKUP_FAILED";
      const conflict=error instanceof IdempotencyConflictError||["COMPOSE_BACKUP_FOREIGN","COMPOSE_BACKUP_STALE","COMPOSE_BACKUP_IN_USE","COMPOSE_BACKUP_EXPIRED"].includes(code);
      const status=error instanceof ComposePreviewError?400:code==="COMPOSE_BACKUP_FORBIDDEN"?403:conflict?409:503;
      await audit("rejected",code);return reply.code(status).send(options.error(request,code,"Backup planning is unavailable or outside the supported policy."));
    }
    // The injected store owns the atomic shared command/plan audit; retries add no second success event.
    return options.ok(request,{backupPlan:receipt});
  });
}
