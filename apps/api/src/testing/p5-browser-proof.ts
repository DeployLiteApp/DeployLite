import {z} from "zod";
export const browserSourceCommit="7e4875341dbb8e1afdeff23137403528f3af6382";
const passed=z.literal("passed");
const schema=z.object({sourceCommit:z.string().regex(/^[a-f0-9]{40}$/),engine:z.enum(["postgres","mysql","mariadb","mongodb","redis"]),
 projectId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),databaseId:z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/),
 creation:passed,selection:passed,reload:passed,telemetry:passed,start:passed,stop:passed,persistence:passed,
 browser:z.literal("chromium"),context:z.literal("isolated"),requests:z.number().int().min(1).max(1000)}).strict();
export function validateBrowserProof(value:unknown,expectedSource=browserSourceCommit):boolean {
 const parsed=schema.safeParse(value);
 return /^[a-f0-9]{40}$/.test(expectedSource)&&parsed.success&&parsed.data.sourceCommit===expectedSource;
}

const deletionSchema=schema.pick({sourceCommit:true,engine:true,projectId:true,databaseId:true,browser:true,context:true,requests:true}).extend({
 preparation:passed,confirmation:passed,recovery:passed,sameOriginalKey:passed,inventory:passed,reload:passed,retainedStorage:passed
}).strict();
export function validateDeletionBrowserProof(value:unknown,expectedSource:string):boolean{
 const parsed=deletionSchema.safeParse(value);
 return /^[a-f0-9]{40}$/.test(expectedSource)&&parsed.success&&parsed.data.sourceCommit===expectedSource;
}

export type BrowserDeletionRecoveryObservation = Readonly<{
 calls: readonly Readonly<{key:string;confirmationId:string;status:number}>[];
 key:string; confirmationId:string; failures:readonly ("request"|"application"|"foreign")[];requestFailure?:string;
}>;
/** Fixed metadata only; never reflect keys, nonce identifiers or browser diagnostics. */
export function browserDeletionRecoveryFailure(value:BrowserDeletionRecoveryObservation):string|null {
 if(value.calls.length!==2)return "count";
 if(value.calls[0]!.status!==503||value.calls[1]!.status!==200)return "status";
 if(value.calls.some(call=>call.key!==value.key))return "key";
 if(value.calls.some(call=>call.confirmationId!==value.confirmationId))return "confirmation";
 for(const kind of ["foreign","application","request"] as const)if(value.failures.includes(kind)){
  if(kind==="request"&&requestFailureKinds.includes(value.requestFailure??""))return "request:"+value.requestFailure;return kind;
 }
 return null;
}

export type BrowserFixtureRequestStage="routing"|"body"|"app"|"inject"|"projection"|"response";
const requestFailureKinds=["routing","body","app","inject","projection","response","body-aborted","api-closed"];
export function browserFixtureRequestFailure(value:Readonly<{stage:BrowserFixtureRequestStage;aborted:boolean;code:unknown}>):string {
 if(value.stage==="body"&&value.aborted===true)return "body-aborted";
 if(value.stage==="inject"&&value.code==="FST_ERR_REOPENED_CLOSE_SERVER")return "api-closed";
 return ["routing","body","app","inject","projection","response"].includes(value.stage)?value.stage:"request";
}

const backupBrowserSchema=schema.pick({sourceCommit:true,engine:true,projectId:true,databaseId:true,browser:true,context:true,requests:true}).extend({
 actorId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),commandId:z.string().min(1).max(256),originalCommandId:z.string().min(1).max(256),
 archiveId:z.string().regex(/^backup_[a-f0-9]{32}$/),idempotencyKey:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),destinationId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
 manual:passed,originalSource:passed,lostReply:passed,reload:passed,sameOriginalKey:passed,inventory:passed,
 calls:z.array(z.object({key:z.string(),commandId:z.string(),archiveId:z.string(),actorId:z.string(),status:z.literal(200)}).strict()).length(2)
}).strict();
export function validateBackupBrowserProof(value:unknown,expectedSource:string):boolean{
 const parsed=backupBrowserSchema.safeParse(value);if(!/^[a-f0-9]{40}$/.test(expectedSource)||!parsed.success)return false;
 const proof=parsed.data;
 return proof.sourceCommit===expectedSource&&proof.commandId!==proof.originalCommandId&&proof.calls.every(call=>
  call.key===proof.idempotencyKey&&call.commandId===proof.commandId&&call.archiveId===proof.archiveId&&call.actorId===proof.actorId);
}

const restoreBrowserSchema=backupBrowserSchema.omit({destinationId:true,manual:true,inventory:true,calls:true}).extend({
 confirmationId:z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),preparation:passed,confirmation:passed,sameOriginalNonce:passed,
 cacheOnlyReopen:passed,expiredRecovery:passed,restoredData:passed,
 calls:z.tuple([z.object({key:z.string(),confirmationId:z.string(),actorId:z.string(),status:z.literal(503)}).strict(),
  z.object({key:z.string(),confirmationId:z.string(),actorId:z.string(),status:z.literal(200)}).strict()])
}).strict();
export function validateRestoreBrowserProof(value:unknown,expectedSource:string):boolean{
 const parsed=restoreBrowserSchema.safeParse(value);if(!/^[a-f0-9]{40}$/.test(expectedSource)||!parsed.success)return false;
 const proof=parsed.data;
 return proof.sourceCommit===expectedSource&&proof.commandId!==proof.originalCommandId&&proof.calls.every(call=>
  call.key===proof.idempotencyKey&&call.confirmationId===proof.confirmationId&&call.actorId===proof.actorId);
}
