import {getTableColumns} from "drizzle-orm";
import type {Pool} from "pg";
import {createControlCommand,createConfirmation} from "@deploylite/domain";
import {createDbClient} from "../client.js";
import {auditEvents,controlCommands,controlCommandConfirmations,controlCommandAudits} from "../schema.js";
import {DbControlCommandRepository} from "./control-plane.js";
export function fixture(){
 const command=createControlCommand({actorId:"actor1",action:"project.update",scope:{kind:"project",projectId:"project1"},input:{operation:"ci.confirmation.fixture"},idempotencyKey:"confirm-key",correlationId:"confirm-correlation",expiresAt:new Date(8000)});
 const row:Record<string,any>={id:command.id,actorUserId:command.actorId,action:command.action,scopeKind:"project",scopeKey:"project1",inputDigest:command.inputDigest,idempotencyKey:command.idempotencyKey,correlationId:command.correlationId,status:command.status,result:null,executionAuthority:null,expiresAt:command.expiresAt,createdAt:new Date(0),updatedAt:new Date(0)};
 const events:Record<string,any>[]=[],audits:Record<string,any>[]=[],related:Record<string,any>[]=[],confirmations:Record<string,any>[]=[],queries:{text:string;values:unknown[]}[]=[];
 const camel=(name:string)=>name.replace(/_([a-z])/g,(_,letter:string)=>letter.toUpperCase());
 let snapshot:{row:Record<string,any>;confirmations:Record<string,any>[];audits:Record<string,any>[];events:Record<string,any>[]} | undefined;
 const storedRows=(table:any,values:Record<string,any>[])=>values.map(value=>Object.keys(getTableColumns(table)).map(key=>value[key]));
 const matches=(text:string,values:unknown[],value:Record<string,any>)=>[...text.matchAll(/"(?:control_commands|control_command_confirmations)"\."([^"]+)" = \$(\d+)/g)].every(match=>value[camel(match[1]!)]===values[Number(match[2])-1]);
 const client={query:async(query:string|{text:string},values:unknown[]=[])=>{
  const text=typeof query==="string"?query:query.text;queries.push({text,values});
  if(text.startsWith('insert into "control_command_confirmations"')||text.startsWith('insert into "control_command_audits"')||text.startsWith('insert into "audit_events"')){
   const names=[...text.slice(text.indexOf('(')+1,text.indexOf(')')).matchAll(/"([^"]+)"/g)].map(match=>match[1]!);
   const expressions=text.split(' values (')[1]!.split(')')[0]!.split(', '),stored:Record<string,any>={consumedAt:null,createdAt:new Date(1000)};
   names.forEach((name,index)=>{const parameter=/\$(\d+)/.exec(expressions[index]??"");if(parameter)stored[camel(name)]=values[Number(parameter[1])-1];});
   if(text.startsWith('insert into "audit_events"')){if(typeof stored.metadata==="string")stored.metadata=JSON.parse(stored.metadata);events.push(stored);}
   else if(text.includes('"control_command_audits"'))audits.push(stored);
   else if(!confirmations.some(existing=>existing.commandId===stored.commandId))confirmations.push(stored);
   return {rows:[]};
  }
  if(text.toLowerCase()==="begin")snapshot=structuredClone({row,confirmations,audits,events});
  if(text.toLowerCase()==="rollback"&&snapshot){Object.assign(row,snapshot.row);confirmations.splice(0,confirmations.length,...snapshot.confirmations);audits.splice(0,audits.length,...snapshot.audits);events.splice(0,events.length,...snapshot.events);}
  if(text.startsWith('update')){
   const rows=text.startsWith('update "control_commands"')?[row]:confirmations;
   const changed=rows.filter(value=>matches(text,values,value));
   for(const value of changed)for(const match of text.split(' where ')[0]!.matchAll(/"([^"]+)" = \$(\d+)/g)){
    const raw=values[Number(match[2])-1];value[camel(match[1]!)]=(match[1]==="execution_authority"||match[1]==="result")&&typeof raw==="string"?JSON.parse(raw):match[1]!.endsWith("_at")&&typeof raw==="string"?new Date(raw):raw;
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
 return {command,row,confirmations,audits,events,related,queries,repository,seed(){const value=createConfirmation({command,classification:"destructive"});confirmations.push({id:value.id,commandId:value.commandId,actorUserId:value.actorId,action:value.action,scopeKind:"project",scopeKey:"project1",inputDigest:value.inputDigest,classification:value.classification,expiresAt:value.expiresAt,consumedAt:null,createdAt:new Date(1000)});return value;}};
}
