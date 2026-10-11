import {getTableColumns} from "drizzle-orm";
import type {Pool} from "pg";
import {expect,it} from "vitest";
import {createControlCommand,createConfirmation} from "@deploylite/domain";
import {createDbClient} from "../client.js";
import {controlCommands,controlCommandConfirmations} from "../schema.js";
import {DbControlCommandRepository} from "./control-plane.js";
function fixture(){
 const command=createControlCommand({actorId:"actor1",action:"project.update",scope:{kind:"project",projectId:"project1"},input:{operation:"ci.confirmation.fixture"},idempotencyKey:"confirm-key",correlationId:"confirm-correlation",expiresAt:new Date(8000)});
 const row:Record<string,any>={id:command.id,actorUserId:command.actorId,action:command.action,scopeKind:"project",scopeKey:"project1",inputDigest:command.inputDigest,idempotencyKey:command.idempotencyKey,correlationId:command.correlationId,status:command.status,result:null,executionAuthority:null,expiresAt:command.expiresAt,createdAt:new Date(0),updatedAt:new Date(0)};
 const confirmations:Record<string,any>[]=[],queries:{text:string;values:unknown[]}[]=[];
 const camel=(name:string)=>name.replace(/_([a-z])/g,(_,letter:string)=>letter.toUpperCase());
 const client={query:async(query:string|{text:string},values:unknown[]=[])=>{
  const text=typeof query==="string"?query:query.text;queries.push({text,values});
  if(text.startsWith('insert into "control_command_confirmations"')){
   const names=[...text.slice(text.indexOf('(')+1,text.indexOf(')')).matchAll(/"([^"]+)"/g)].map(match=>match[1]!);
   const expressions=text.split(' values (')[1]!.split(')')[0]!.split(', '),stored:Record<string,any>={consumedAt:null,createdAt:new Date(1000)};
   names.forEach((name,index)=>{const parameter=/\$(\d+)/.exec(expressions[index]??"");if(parameter)stored[camel(name)]=values[Number(parameter[1])-1];});
   if(!confirmations.some(existing=>existing.commandId===stored.commandId))confirmations.push(stored);
   return {rows:[]};
  }
  if(text.startsWith('select')&&text.includes('from "control_commands"')){
   const matches=[...text.matchAll(/"control_commands"\."([^"]+)" = \$(\d+)/g)].every(match=>row[camel(match[1]!) ]===values[Number(match[2])-1]);
   return {rows:matches?[Object.keys(getTableColumns(controlCommands)).map(key=>row[key])]:[]};
  }
  if(text.startsWith('select')&&text.includes('from "control_command_confirmations"'))return {rows:confirmations.map(value=>Object.keys(getTableColumns(controlCommandConfirmations)).map(key=>value[key]))};
  return {rows:[]};
 }};
 const repository=()=>new DbControlCommandRepository(createDbClient(client as unknown as Pool));
 return {command,row,confirmations,queries,repository,seed(){const value=createConfirmation({command,classification:"destructive"});confirmations.push({id:value.id,commandId:value.commandId,actorUserId:value.actorId,action:value.action,scopeKind:"project",scopeKey:"project1",inputDigest:value.inputDigest,classification:value.classification,expiresAt:value.expiresAt,consumedAt:null,createdAt:new Date(1000)});return value;}};
}
it("persists and recovers one original pending destructive nonce without consuming or issuing authority",async()=>{
 const f=fixture(),first=await f.repository().resolveProjectUpdateConfirmation(f.command,new Date(1000));expect(first).not.toBeNull();
 const recovered=await f.repository().resolveProjectUpdateConfirmation(f.command,new Date(1001));expect(recovered).toEqual(first);expect(f.confirmations).toHaveLength(1);expect(recovered).toMatchObject({commandId:f.command.id,actorId:f.command.actorId,classification:"destructive",inputDigest:f.command.inputDigest,consumedAt:null,expiresAt:f.command.expiresAt});
 expect(f.row.status).toBe("pending_confirmation");expect(f.row.executionAuthority).toBeNull();expect(f.queries.some(value=>value.text.includes('pg_advisory_xact_lock'))).toBe(true);
 expect(f.queries.filter(value=>value.text.startsWith('update')||value.text.startsWith('delete'))).toHaveLength(0);
 const query=f.queries.find(value=>value.text.startsWith('select')&&value.text.includes('from "control_commands"'))!;expect(query.text).toContain('"actor_user_id"');expect(query.text).toContain('"scope_key"');expect(query.text).toContain('for update');
});
it("returns the already stored nonce across repository recreation without renewing or replacing it",async()=>{
 const f=fixture(),original=f.seed();expect(await f.repository().resolveProjectUpdateConfirmation(f.command,new Date(2000))).toEqual(original);
 expect(f.queries.filter(value=>value.text.startsWith('insert'))).toHaveLength(0);expect(f.confirmations).toHaveLength(1);
});
it("refuses detached command actor action scope digest correlation key expiry and nonpending state",async()=>{
 for(const patch of [{actorId:"foreign"},{action:"project.delete" as const},{scope:{kind:"project" as const,projectId:"foreign"}},{inputDigest:"0".repeat(64)},{correlationId:"foreign"},{idempotencyKey:"foreign"},{expiresAt:new Date(9000)},{status:"eligible" as const},{status:"dispatching" as const},{status:"completed" as const}]){
  const f=fixture();expect(await f.repository().resolveProjectUpdateConfirmation({...f.command,...patch},new Date(1000))).toBeNull();expect(f.confirmations).toHaveLength(0);
 }
});
it("never replaces expired consumed detached ordinary or duplicate stored confirmations",async()=>{
 for(const patch of [{actorUserId:"foreign"},{scopeKey:"foreign"},{scopeKind:"platform"},{inputDigest:"0".repeat(64)},{classification:"normal"},{expiresAt:new Date(1000)},{expiresAt:new Date(9000)},{expiresAt:new Date(NaN)},{consumedAt:new Date(1000)}]){
  const f=fixture();f.seed();Object.assign(f.confirmations[0]!,patch);expect(await f.repository().resolveProjectUpdateConfirmation(f.command,new Date(1000))).toBeNull();expect(f.queries.filter(value=>value.text.startsWith('insert'))).toHaveLength(0);
 }
 const f=fixture();f.seed();f.seed();expect(await f.repository().resolveProjectUpdateConfirmation(f.command,new Date(1000))).toBeNull();
});
it("rejects expired commands and invalid clocks without writes",async()=>{
 for(const now of [new Date(8000),new Date(NaN)]){const f=fixture();expect(await f.repository().resolveProjectUpdateConfirmation(f.command,now)).toBeNull();expect(f.confirmations).toHaveLength(0);}
});
