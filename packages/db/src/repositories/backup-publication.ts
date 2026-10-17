import {and,eq,or,sql} from "drizzle-orm";
import {projectControlAuthoritySchema,protocolPayloadFingerprint,type ProjectControlAuthorityV1} from "@deploylite/contracts";
import {backupPublicationScope,validateProjectUpdateAuthority,type BackupPublicationBarrier,type BackupPublicationHeld,type ControlCommand} from "@deploylite/domain";
import type {DeployLiteDb} from "../client.js";
import {backupRetirementReservations,controlCommands} from "../schema.js";
import {toCommand} from "./control-plane.js";
const unavailable=()=>new Error("Backup publication is unavailable.");
/** Unwired prerequisite. SQL/backend loss is not filesystem rollback or cross-system atomicity. */
export class DbBackupPublicationBarrier implements BackupPublicationBarrier {
  constructor(private readonly db:DeployLiteDb,private readonly clock=Date.now){}
  async run<T>(raw:unknown,submitted:ProjectControlAuthorityV1,signal:AbortSignal,work:(held:BackupPublicationHeld)=>Promise<T>):Promise<T>{
    let settlement:Promise<T>|undefined,stop=()=>{},broken=false,entered=false;
    try{
      const scope=backupPublicationScope(raw),authority=projectControlAuthoritySchema.parse(structuredClone(submitted)),clock=this.clock;
      if(protocolPayloadFingerprint(authority)!==scope.authorityFingerprint)throw unavailable();
      let previous=clock();
      if(!Number.isSafeInteger(previous)||previous<0||!Number.isSafeInteger(new Date(previous).getTime()))throw unavailable();
      const expiresAt=Math.min(scope.expiresAt,previous+scope.timeoutMs);
      const current=()=>{
        const now=clock();
        if(broken||signal.aborted||!Number.isSafeInteger(now)||now<previous||!Number.isSafeInteger(new Date(now).getTime())||now>=expiresAt)throw unavailable();
        previous=now;return now;
      };
      current();
      const result=await this.db.transaction(tx=>{
        if(entered)throw unavailable();entered=true;
        settlement=(async()=>{
          let accepting=true,live=true,adoptionFailed=false,snapshot:ControlCommand|undefined;
          const pending:Promise<void>[]=[];stop=()=>{accepting=false;};
          const assertCurrent=async()=>{
            current();if(!live)throw unavailable();
            const rows=await tx.select().from(controlCommands).where(or(
              and(eq(controlCommands.scopeKind,"project"),eq(controlCommands.scopeKey,scope.projectId)),
              and(eq(controlCommands.scopeKind,"deployment"),sql`${controlCommands.scopeKey}::jsonb ->> 0 = ${scope.projectId}`)
            ));
            const now=current(),commands=rows.map(toCommand);validateProjectUpdateAuthority(commands,authority,now);
            const command=commands.find(value=>value.id===scope.commandId);
            if(!command||command.action!=="project.update"||command.scope.kind!=="project"||command.scope.projectId!==scope.projectId
              ||command.inputDigest!==scope.inputDigest||command.correlationId!==scope.correlationId||command.idempotencyKey!==scope.idempotencyKey
              ||typeof command.actorId!=="string"||!command.actorId||command.result!==undefined
              ||!(command.expiresAt instanceof Date)||command.expiresAt.getTime()!==scope.expiresAt)throw unavailable();
            // First actor is ledger provenance, not an authenticated field invented for this port.
            if(snapshot&&(command.actorId!==snapshot.actorId||command.id!==snapshot.id||command.action!==snapshot.action
              ||command.scope.kind!==snapshot.scope.kind||command.inputDigest!==snapshot.inputDigest||command.correlationId!==snapshot.correlationId
              ||command.idempotencyKey!==snapshot.idempotencyKey||command.expiresAt.getTime()!==snapshot.expiresAt.getTime()))throw unavailable();
            snapshot??=structuredClone(command);
            const reserved=await tx.select().from(backupRetirementReservations).where(and(
              eq(backupRetirementReservations.projectId,scope.projectId),eq(backupRetirementReservations.destinationId,scope.destinationId),
              eq(backupRetirementReservations.archiveId,scope.archiveId))).limit(1);
            current();if(reserved.length)throw unavailable(); // Permanent, irrespective of retirement command, volume alias or expiry.
          };
          const track=<U>(job:Promise<U>)=>{pending.push(job.then(()=>{},()=>{adoptionFailed=true;}));return job;};
          const held:BackupPublicationHeld=Object.freeze({
            expiresAt,
            assertCurrent:()=>accepting?track(assertCurrent()):Promise.reject(unavailable()),
            adopt:<U>(operation:()=>Promise<U>)=>accepting?track((async()=>{
              await assertCurrent();if(!accepting)throw unavailable();
              const value=await operation();current();return value;
            })()):Promise.reject(unavailable())
          });
          try{
            // No driver cancellation primitive: unresolved lock/I/O can outlive the budget; never renew or release early.
            const lockKey="deploylite:execution:"+scope.projectId;
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
            current();await assertCurrent();
            let value:T;
            try{value=await work(held);}finally{accepting=false;await Promise.all(pending);}
            if(adoptionFailed)throw unavailable();
            await assertCurrent();return value;
          }finally{accepting=false;live=false;}
        })();
        return settlement;
      });
      if(settlement)await settlement;
      current();return result;
    }catch{
      broken=true;stop();
      if(settlement)await settlement.catch(()=>{});
      throw unavailable();
    }
  }
}
