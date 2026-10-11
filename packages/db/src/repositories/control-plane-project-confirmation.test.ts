import {getTableColumns} from "drizzle-orm";
import type {Pool} from "pg";
import {expect,it} from "vitest";
import {createControlCommand,createConfirmation} from "@deploylite/domain";
import {createDbClient} from "../client.js";
import {controlCommands,controlCommandConfirmations,controlCommandAudits} from "../schema.js";
import {DbControlCommandRepository} from "./control-plane.js";
function fixture(){
 const command=createControlCommand({actorId:"actor1",action:"project.update",scope:{kind:"project",projectId:"project1"},input:{operation:"ci.confirmation.fixture"},idempotencyKey:"confirm-key",correlationId:"confirm-correlation",expiresAt:new Date(8000)});
 const row:Record<string,any>={id:command.id,actorUserId:command.actorId,action:command.action,scopeKind:"project",scopeKey:"project1",inputDigest:command.inputDigest,idempotencyKey:command.idempotencyKey,correlationId:command.correlationId,status:command.status,result:null,executionAuthority:null,expiresAt:command.expiresAt,createdAt:new Date(0),updatedAt:new Date(0)};
 const audits:Record<string,any>[]=[],related:Record<string,any>[]=[],confirmations:Record<string,any>[]=[],queries:{text:string;values:unknown[]}[]=[];
 const camel=(name:string)=>name.replace(/_([a-z])/g,(_,letter:string)=>letter.toUpperCase());
 let snapshot:{row:Record<string,any>;confirmations:Record<string,any>[];audits:Record<string,any>[]} | undefined;
 const storedRows=(table:any,values:Record<string,any>[])=>values.map(value=>Object.keys(getTableColumns(table)).map(key=>value[key]));
 const matches=(text:string,values:unknown[],value:Record<string,any>)=>[...text.matchAll(/"(?:control_commands|control_command_confirmations)"\."([^"]+)" = \$(\d+)/g)].every(match=>value[camel(match[1]!)]===values[Number(match[2])-1]);
 const client={query:async(query:string|{text:string},values:unknown[]=[])=>{
  const text=typeof query==="string"?query:query.text;queries.push({text,values});
  if(text.startsWith('insert into "control_command_confirmations"')||text.startsWith('insert into "control_command_audits"')){
   const names=[...text.slice(text.indexOf('(')+1,text.indexOf(')')).matchAll(/"([^"]+)"/g)].map(match=>match[1]!);
   const expressions=text.split(' values (')[1]!.split(')')[0]!.split(', '),stored:Record<string,any>={consumedAt:null,createdAt:new Date(1000)};
   names.forEach((name,index)=>{const parameter=/\$(\d+)/.exec(expressions[index]??"");if(parameter)stored[camel(name)]=values[Number(parameter[1])-1];});
   if(text.includes('"control_command_audits"'))audits.push(stored);
   else if(!confirmations.some(existing=>existing.commandId===stored.commandId))confirmations.push(stored);
   return {rows:[]};
  }
  if(text.toLowerCase()==="begin")snapshot=structuredClone({row,confirmations,audits});
  if(text.toLowerCase()==="rollback"&&snapshot){Object.assign(row,snapshot.row);confirmations.splice(0,confirmations.length,...snapshot.confirmations);audits.splice(0,audits.length,...snapshot.audits);}
  if(text.startsWith('update')){
   const rows=text.startsWith('update "control_commands"')?[row]:confirmations;
   const changed=rows.filter(value=>matches(text,values,value));
   for(const value of changed)for(const match of text.split(' where ')[0]!.matchAll(/"([^"]+)" = \$(\d+)/g)){
    const raw=values[Number(match[2])-1];value[camel(match[1]!)]=match[1]==="execution_authority"&&typeof raw==="string"?JSON.parse(raw):match[1]!.endsWith("_at")&&typeof raw==="string"?new Date(raw):raw;
   }
   return {rows:storedRows(rows===confirmations?controlCommandConfirmations:controlCommands,changed)};
  }
  if(text.startsWith('select')&&text.includes('from "control_commands"')){
   if(text.includes("::jsonb"))return {rows:storedRows(controlCommands,[row,...related])};
   const matches=[...text.matchAll(/"control_commands"\."([^"]+)" = \$(\d+)/g)].every(match=>row[camel(match[1]!) ]===values[Number(match[2])-1]);
   return {rows:matches?storedRows(controlCommands,text.includes('"control_commands"."id" =')?[row]:[row,...related]):[]};
  }
  if(text.startsWith('select')&&text.includes('from "control_command_audits"'))return {rows:storedRows(controlCommandAudits,audits)};
  if(text.startsWith('select')&&text.includes('from "control_command_confirmations"'))return {rows:storedRows(controlCommandConfirmations,confirmations.filter(value=>matches(text,values,value)))};
  return {rows:[]};
 }};
 const repository=(fault?: (stage:string)=>void)=>new DbControlCommandRepository(createDbClient(client as unknown as Pool),fault);
 return {command,row,confirmations,audits,related,queries,repository,seed(){const value=createConfirmation({command,classification:"destructive"});confirmations.push({id:value.id,commandId:value.commandId,actorUserId:value.actorId,action:value.action,scopeKind:"project",scopeKey:"project1",inputDigest:value.inputDigest,classification:value.classification,expiresAt:value.expiresAt,consumedAt:null,createdAt:new Date(1000)});return value;}};
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

it("atomically consumes the original nonce and claims one existing project fence with one audit",async()=>{
 const f=fixture(),nonce=f.seed(),result=await f.repository().claimConfirmedProjectUpdate(f.command,nonce,new Date(1000));
 expect(result).toMatchObject({accepted:true,claimed:true,reason:null,command:{status:"dispatching"},authority:{commandId:f.command.id,inputDigest:f.command.inputDigest,projectLease:{fence:2,expiresAt:8000}}});
 expect(f.confirmations[0]!.consumedAt).toEqual(new Date(1000));expect(f.audits).toHaveLength(1);expect(f.audits[0]).toMatchObject({commandId:f.command.id,confirmationId:nonce.id,outcome:"accepted",correlationId:f.command.correlationId});
 const saved=structuredClone({row:f.row,confirmations:f.confirmations,audits:f.audits});
 expect(await f.repository().claimConfirmedProjectUpdate(f.command,nonce,new Date(1001))).toMatchObject({accepted:false,claimed:false});
 expect({row:f.row,confirmations:f.confirmations,audits:f.audits}).toEqual(saved);
});
it("retains the same pending nonce when another live project command owns authority",async()=>{
 const f=fixture(),nonce=f.seed();f.related.push({...f.row,id:"competing",status:"dispatching",expiresAt:new Date(4000)});
 expect(await f.repository().claimConfirmedProjectUpdate(f.command,nonce,new Date(1000))).toMatchObject({accepted:false,claimed:false});
 expect(f.row.status).toBe("pending_confirmation");expect(f.confirmations[0]!.consumedAt).toBeNull();expect(f.audits).toHaveLength(0);
 f.related[0]!.status="completed";expect(await f.repository().claimConfirmedProjectUpdate(f.command,nonce,new Date(1001))).toMatchObject({accepted:true,claimed:true});
});
it("rejects detached or expired confirmed claims before any ledger mutation",async()=>{
 for(const patch of [{actorId:"foreign"},{idempotencyKey:"foreign"},{inputDigest:"0".repeat(64)},{expiresAt:new Date(9000)},{status:"eligible" as const}]){
  const f=fixture(),nonce=f.seed();expect(await f.repository().claimConfirmedProjectUpdate({...f.command,...patch},nonce,new Date(1000))).toMatchObject({accepted:false,claimed:false});
  expect(f.row.status).toBe("pending_confirmation");expect(f.confirmations[0]!.consumedAt).toBeNull();expect(f.audits).toHaveLength(0);
 }
 for(const patch of [{id:"foreign"},{actorId:"foreign"},{classification:"non-destructive" as const},{inputDigest:"0".repeat(64)},{consumedAt:new Date(999)},{expiresAt:new Date(9000)}]){
  const f=fixture(),nonce=f.seed();expect(await f.repository().claimConfirmedProjectUpdate(f.command,{...nonce,...patch},new Date(1000))).toMatchObject({accepted:false,claimed:false});
  expect(f.confirmations[0]!.consumedAt).toBeNull();expect(f.audits).toHaveLength(0);
 }
 for(const now of [new Date(8000),new Date(NaN)]){const f=fixture(),nonce=f.seed();expect(await f.repository().claimConfirmedProjectUpdate(f.command,nonce,now)).toMatchObject({accepted:false,claimed:false});expect(f.audits).toHaveLength(0);}
});

it("rolls back nonce command and audit together when the confirmed authority transaction fails",async()=>{
 const f=fixture(),nonce=f.seed(),before=structuredClone({row:f.row,confirmations:f.confirmations,audits:f.audits});
 await expect(f.repository(()=>{throw new Error("injected failure");}).claimConfirmedProjectUpdate(f.command,nonce,new Date(1000))).rejects.toThrow("injected failure");
 expect({row:f.row,confirmations:f.confirmations,audits:f.audits}).toEqual(before);
 expect(await f.repository().claimConfirmedProjectUpdate(f.command,nonce,new Date(1001))).toMatchObject({accepted:true,claimed:true});
});

it("corroborates one original consumed confirmation and accepted audit without ledger writes",async()=>{
 const f=fixture(),nonce=f.seed(),claimed=await f.repository().claimConfirmedProjectUpdate(f.command,nonce,new Date(1000));
 const before=structuredClone({row:f.row,confirmations:f.confirmations,audits:f.audits}),offset=f.queries.length;
 await expect(f.repository().validateConfirmedProjectUpdateAuthority(claimed.authority!,nonce.id,1001)).resolves.toBeUndefined();
 expect({row:f.row,confirmations:f.confirmations,audits:f.audits}).toEqual(before);
 expect(f.queries.slice(offset).filter(value=>/^(insert|update|delete)/.test(value.text))).toHaveLength(0);
});
it("rejects otherwise current authority without its original consumed destructive nonce",async()=>{
 for(const patch of [{consumedAt:null},{consumedAt:new Date(8000)},{consumedAt:new Date(2000)},{expiresAt:new Date(1000)},{expiresAt:new Date(9000)},{actorUserId:"foreign"},{scopeKind:"platform"},{scopeKey:"foreign"},{classification:"non-destructive"},{inputDigest:"0".repeat(64)}]){
  const f=fixture(),nonce=f.seed(),claimed=await f.repository().claimConfirmedProjectUpdate(f.command,nonce,new Date(1000));Object.assign(f.confirmations[0]!,patch);
  await expect(f.repository().validateConfirmedProjectUpdateAuthority(claimed.authority!,nonce.id,1001)).rejects.toThrow();
 }
 const f=fixture(),nonce=f.seed(),claimed=await f.repository().claimConfirmedProjectUpdate(f.command,nonce,new Date(1000));
 await expect(f.repository().validateConfirmedProjectUpdateAuthority(claimed.authority!,"foreign",1001)).rejects.toThrow();
 f.confirmations.length=0;await expect(f.repository().validateConfirmedProjectUpdateAuthority(claimed.authority!,nonce.id,1001)).rejects.toThrow();
});
it("rejects missing duplicate or detached accepted confirmation audit",async()=>{
 for(const patch of [{commandId:"foreign"},{confirmationId:"foreign"},{correlationId:"foreign"},{outcome:"rejected"}]){
  const f=fixture(),nonce=f.seed(),claimed=await f.repository().claimConfirmedProjectUpdate(f.command,nonce,new Date(1000));Object.assign(f.audits[0]!,patch);
  await expect(f.repository().validateConfirmedProjectUpdateAuthority(claimed.authority!,nonce.id,1001)).rejects.toThrow();
 }
 for(const duplicate of [false,true]){const f=fixture(),nonce=f.seed(),claimed=await f.repository().claimConfirmedProjectUpdate(f.command,nonce,new Date(1000));if(duplicate)f.audits.push({...f.audits[0]!});else f.audits.length=0;
  await expect(f.repository().validateConfirmedProjectUpdateAuthority(claimed.authority!,nonce.id,1001)).rejects.toThrow();}
});
it("rejects expired terminal detached or superseded confirmed authority",async()=>{
 for(const mode of ["expired","terminal","digest","higherFence","invalidClock"]){const f=fixture(),nonce=f.seed(),claimed=await f.repository().claimConfirmedProjectUpdate(f.command,nonce,new Date(1000));
  if(mode==="terminal")f.row.status="completed";
  if(mode==="higherFence")f.related.push({...f.row,id:"successor",executionAuthority:{...claimed.authority!,commandId:"successor",projectLease:{...claimed.authority!.projectLease,fence:3}}});
  const authority=mode==="digest"?{...claimed.authority!,inputDigest:"0".repeat(64)}:claimed.authority!;
  await expect(f.repository().validateConfirmedProjectUpdateAuthority(authority,nonce.id,mode==="expired"?8000:mode==="invalidClock"?NaN:1001)).rejects.toThrow();
 }
});
