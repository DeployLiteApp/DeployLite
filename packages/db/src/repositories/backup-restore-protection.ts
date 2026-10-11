import {and,eq,sql} from "drizzle-orm";
import {managedDatabaseBackupReceiptSchema,managedDatabaseRestorePreparationSchema} from "@deploylite/contracts";
import {digestControlInput,evaluateConfirmation,managedDatabaseRestoreExecutionDigest,type ControlCommand,type ControlConfirmation,type BackupRetentionProtectionReader} from "@deploylite/domain";
import type {DeployLiteDb} from "../client.js";
import {backupRestoreProtections,backupInventory,controlCommands,controlCommandConfirmations} from "../schema.js";
function unavailable():never{throw new Error("Restore archive protection is unavailable.");}
const scope=(projectId:string,volumeKey:string,destinationId:string)=>and(eq(backupRestoreProtections.projectId,projectId),eq(backupRestoreProtections.volumeKey,volumeKey),eq(backupRestoreProtections.destinationId,destinationId));
type Transaction=Parameters<Parameters<DeployLiteDb["transaction"]>[0]>[0];
type Protection=typeof backupRestoreProtections.$inferSelect;
/** Existing retention reader, with corroborated insert-only native restore protection. Never auto-release on expiry. */
export class DbBackupRestoreProtectionStore implements BackupRetentionProtectionReader {
 constructor(private readonly db:DeployLiteDb,private readonly expectedAgentId:string,private readonly clock=Date.now){}
 available(){return true;}
 private now(){const value=this.clock();if(!Number.isSafeInteger(value)||value<0||!/^[A-Za-z0-9_-]{1,200}$/.test(this.expectedAgentId))unavailable();return value;}
 private async read(tx:Transaction,row:Protection){
  const now=this.now();
  if(!/^[a-f0-9]{64}$/.test(row.inputDigest)||!/^backup_[a-f0-9]{32}$/.test(row.archiveId)||row.restoreCommandId===row.backupCommandId
   ||!(row.createdAt instanceof Date)||!Number.isSafeInteger(row.createdAt.getTime())||row.createdAt.getTime()<0||row.createdAt.getTime()>now)unavailable();
  const [command]=await tx.select().from(controlCommands).where(eq(controlCommands.id,row.restoreCommandId)).limit(1).for("share");
  const confirmations=await tx.select().from(controlCommandConfirmations).where(eq(controlCommandConfirmations.commandId,row.restoreCommandId)).limit(2).for("share");
  const [backup]=await tx.select().from(backupInventory).where(and(eq(backupInventory.projectId,row.projectId),eq(backupInventory.volumeKey,row.volumeKey),eq(backupInventory.destinationId,row.destinationId),eq(backupInventory.archiveId,row.archiveId))).limit(1).for("share");
  if(!command||confirmations.length!==1||!backup)unavailable();const nonce=confirmations[0]!,receipt=managedDatabaseBackupReceiptSchema.parse(backup.receipt);
  if(command.id!==row.restoreCommandId||command.action!=="project.update"||command.scopeKind!=="project"||command.scopeKey!==row.projectId||command.inputDigest!==row.inputDigest
   ||!["pending_confirmation","dispatching","completed"].includes(command.status)||nonce.id!==row.confirmationId||nonce.commandId!==command.id
   ||nonce.actorUserId!==command.actorUserId||nonce.action!==command.action||nonce.scopeKind!==command.scopeKind||nonce.scopeKey!==command.scopeKey
   ||nonce.inputDigest!==row.inputDigest||nonce.classification!=="destructive"||!(nonce.expiresAt instanceof Date)||!Number.isFinite(nonce.expiresAt.getTime())
   ||nonce.expiresAt.getTime()!==command.expiresAt.getTime()||backup.commandId!==row.backupCommandId
   ||backup.projectId!==row.projectId||backup.volumeKey!==row.volumeKey||backup.destinationId!==row.destinationId||backup.archiveId!==row.archiveId
   ||receipt.agentId!==this.expectedAgentId||receipt.commandId!==row.backupCommandId||receipt.projectId!==row.projectId||receipt.volumeKey!==row.volumeKey
   ||receipt.destinationId!==row.destinationId||receipt.archiveId!==row.archiveId||receipt.archiveSha256!==row.archiveSha256||receipt.manifestSha256!==row.manifestSha256)unavailable();
  this.now();return {command,nonce,receipt};
 }
 async protect(raw:unknown,suppliedCommand:ControlCommand,suppliedConfirmation:ControlConfirmation):Promise<void>{
  try{
   const preparation=managedDatabaseRestorePreparationSchema.parse(structuredClone(raw)),command=structuredClone(suppliedCommand),confirmation=structuredClone(suppliedConfirmation),now=this.now();
   const receipt=preparation.backupReceipt,digest=managedDatabaseRestoreExecutionDigest(preparation);
   if(receipt.agentId!==this.expectedAgentId||command.action!=="project.update"||command.scope.kind!=="project"||command.scope.projectId!==preparation.projectId
    ||command.status!=="pending_confirmation"||command.projectExecutionAuthority||command.executionAuthority||command.inputDigest!==digest)unavailable();
   evaluateConfirmation(command,confirmation,new Date(now));
   const values={restoreCommandId:command.id,confirmationId:confirmation.id,projectId:receipt.projectId,volumeKey:receipt.volumeKey,destinationId:receipt.destinationId,archiveId:receipt.archiveId,
    backupCommandId:receipt.commandId,inputDigest:digest,archiveSha256:receipt.archiveSha256,manifestSha256:receipt.manifestSha256,createdAt:new Date(now)};
   await this.db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:execution:${receipt.projectId}`},0))`);
    const {command:stored,nonce,receipt:original}=await this.read(tx,values);
    if(stored.status!=="pending_confirmation"||stored.executionAuthority||stored.actorUserId!==command.actorId||stored.idempotencyKey!==command.idempotencyKey
     ||stored.correlationId!==command.correlationId||stored.expiresAt.getTime()!==command.expiresAt.getTime()||nonce.consumedAt!==null
     ||digestControlInput(original)!==digestControlInput(receipt))unavailable();
    evaluateConfirmation(command,{id:nonce.id,commandId:nonce.commandId,actorId:nonce.actorUserId,action:command.action,scope:command.scope,
     inputDigest:nonce.inputDigest,classification:"destructive",expiresAt:nonce.expiresAt,consumedAt:nonce.consumedAt},new Date(this.now()));
    const [inserted]=await tx.insert(backupRestoreProtections).values(values).onConflictDoNothing().returning();
    if(!inserted){const [existing]=await tx.select().from(backupRestoreProtections).where(eq(backupRestoreProtections.restoreCommandId,command.id)).limit(1).for("share");
     if(!existing||digestControlInput({...existing,createdAt:0})!==digestControlInput({...values,createdAt:0}))unavailable();await this.read(tx,existing);}
   });
  }catch{return unavailable();}
 }
 async list(projectId:string,volumeKey:string,destinationId:string):Promise<readonly string[]>{
  try{
   this.now();if(!/^[A-Za-z0-9_-]{1,200}$/.test(projectId)||!/^db-[A-Za-z0-9_-]{1,63}$/.test(volumeKey)||!/^[A-Za-z0-9_-]{1,200}$/.test(destinationId))unavailable();
   return await this.db.transaction(async tx=>{
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`deploylite:execution:${projectId}`},0))`);
    const rows=await tx.select().from(backupRestoreProtections).where(scope(projectId,volumeKey,destinationId)).orderBy(backupRestoreProtections.restoreCommandId).limit(10001);
    if(rows.length>10000||new Set(rows.map(row=>row.restoreCommandId)).size!==rows.length)unavailable();
    for(const row of rows){if(row.projectId!==projectId||row.volumeKey!==volumeKey||row.destinationId!==destinationId)unavailable();await this.read(tx,row);}
    return [...new Set(rows.map(row=>row.archiveId))].sort();
   });
  }catch{return unavailable();}
 }
}
