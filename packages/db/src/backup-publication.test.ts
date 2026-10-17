import {expect,it} from "vitest";
import {createHash} from "node:crypto";
import {PgDialect} from "drizzle-orm/pg-core";
import {backupPublicationScope,claimProjectUpdateAuthority,composeVolumeBackupExecutionDigest,managedDatabaseBackupExecutionDigest,managedDatabaseRuntimeExecutionDigest,composeRuntimeResourceName,type BackupPublicationHeld,type ControlCommand} from "@deploylite/domain";
import type {DeployLiteDb} from "./client.js";
import {controlCommands,backupRetirementReservations} from "./schema.js";
import {DbBackupPublicationBarrier} from "./repositories/backup-publication.js";
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
function fixture(native=false){
  const input={schemaVersion:1,projectId:"project-a",databaseId:"orders",engine:"postgres",profileId:"profile-a",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
  const {profileId:_profile,...receiptInput}=input;
  const receipt={...receiptInput,action:"database.runtime",agentId:"agent-a",commandId:"origin-a",inputDigest:managedDatabaseRuntimeExecutionDigest(input),correlationId:"origin-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName(input.projectId,"volume","db-orders"),networkName:composeRuntimeResourceName(input.projectId,"network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
  const preparation={...input,originalReceipt:receipt,originalReplayFingerprint:"f".repeat(64),destinationId:"destination-a",maxBytes:1048576};
  const plan={schemaVersion:1,operation:"compose.volume.backup.plan",status:"preview",executionAllowed:false,archiveCreated:false,projectId:"project-a",volumeKey:"data",configDigest:"a".repeat(64),stateDigest:"b".repeat(64),profileId:"profile-a",destinationId:"destination-a",consistency:"offline-required",verification:"integrity-and-completeness-required",limits:{maxBytes:100,maxEntries:2,maxDurationMs:1000,planTtlMs:1000},planDigest:"c".repeat(64)};
  const inputDigest=native?managedDatabaseBackupExecutionDigest(preparation):composeVolumeBackupExecutionDigest({projectId:"project-a",idempotencyKey:"backup-once",plan});
  const original:ControlCommand={id:"backup-a",actorId:"actor-a",action:"project.update",scope:{kind:"project",projectId:"project-a"},inputDigest,idempotencyKey:"backup-once",correlationId:"backup-correlation",status:"eligible",expiresAt:new Date(10000)};
  const authority=structuredClone(claimProjectUpdateAuthority([original],original,1000)!);
  const common={agentId:"agent-a",commandId:original.id,inputDigest,idempotencyKey:original.idempotencyKey,authority:structuredClone(authority),lease:structuredClone(authority.projectLease),context:{requestId:"request-a",correlationId:original.correlationId},timeoutMs:5000,cancellationRequested:false};
  const raw=native?{...preparation,...common,action:"database.runtime.backup",operation:"database.runtime.backup",requiredCapabilities:["database.runtime.backup.v1"]}:{schemaVersion:1,...common,action:"compose.volume.backup",projectId:"project-a",operation:"compose.volume.backup.execute",canonicalDocument:"services: {}",plan,requiredCapabilities:["compose.volume.backup.v1"]};
  const row={...original,actorUserId:original.actorId,scopeKind:"project",scopeKey:"project-a",executionAuthority:structuredClone(authority),result:null};
  const archiveId="backup_"+createHash("sha256").update("project-a\0backup-a\0destination-a").digest("hex").slice(0,32);
  return{raw,authority,row,archiveId,volumeKey:native?"db-orders":"data"};
}
function harness(native=false){
  const f=fixture(native),controller=new AbortController(),rows=[f.row],reservations:Record<string,unknown>[]=[],queries:{sql:string;params:unknown[];table?:unknown}[]=[];
  let now=1000,wait=async(_point:string)=>{},fault="",reenter=false;
  const broken=deferred();const state={released:false,transactions:0};
  const port={
    execute:async(query:Parameters<PgDialect["sqlToQuery"]>[0])=>{queries.push(new PgDialect().sqlToQuery(query));await wait("lock");if(fault==="lock")throw new Error("lock");},
    select(){return{from(table:unknown){
      let params:unknown[]=[];const query={where(value:Parameters<PgDialect["sqlToQuery"]>[0]){const sql=new PgDialect().sqlToQuery(value);params=sql.params;queries.push({...sql,table});return query;},limit(){return query;},for(){return query;},
        then(resolve:(value:unknown[])=>unknown,reject:(reason:unknown)=>unknown){return Promise.resolve().then(async()=>{
          await wait(table===controlCommands?"authority":"reservation");if(fault==="read")throw new Error("read");
          if(table===controlCommands)return structuredClone(rows);
          expect(table).toBe(backupRetirementReservations);
          return structuredClone(reservations.filter(row=>row.projectId===params[0]&&row.destinationId===params[1]&&row.archiveId===params[2]));
        }).then(resolve,reject);}};return query;
    }};},
    insert(){throw new Error("Forbidden insert");},update(){throw new Error("Forbidden update");},delete(){throw new Error("Forbidden delete");}
  };
  const db={transaction:async(run:(tx:typeof port)=>Promise<unknown>)=>{
    state.transactions++;if(fault==="acquire")throw new Error("acquire");
    try{const owned=run(port);const result=await Promise.race([owned,broken.promise.then(()=>{throw new Error("connection lost");})]);if(reenter)await run(port);if(fault==="commit")throw new Error("commit");if(fault==="commit-expiry")now=6000;return result;}
    finally{state.released=true;if(fault==="release-cancel")controller.abort();if(fault==="release")throw new Error("release");}
  }}as unknown as DeployLiteDb;
  return{...f,rows,reservations,queries,controller,state,tick:(value:number)=>{now=value;},fault:(value:string)=>{fault=value;},reenter:()=>{reenter=true;},breakConnection:broken.resolve,
    hold(point:string){const entered=deferred(),release=deferred();let once=false;wait=async where=>{if(where===point&&!once){once=true;entered.resolve();await release.promise;}};return{entered:entered.promise,release:release.resolve};},
    run:<T>(work:(held:BackupPublicationHeld)=>Promise<T>)=>new DbBackupPublicationBarrier(db,()=>now).run(f.raw,f.authority,controller.signal,work)};
}
it.each([false,true])("projects the authenticated %s original, preserving the existing archive algorithm",native=>{
  const h=harness(native);let scope!:ReturnType<typeof backupPublicationScope>;
  expect(()=>{scope=backupPublicationScope(h.raw);}).not.toThrow();
  expect(scope).toMatchObject({projectId:"project-a",commandId:"backup-a",correlationId:"backup-correlation",destinationId:"destination-a",volumeKey:h.volumeKey,archiveId:h.archiveId,expiresAt:10000});
  expect(Object.isFrozen(scope)).toBe(true);
});
it.each([false,true])("holds one transaction and exact project lock before %s work with held-only reads",async native=>{
  const h=harness(native),before=structuredClone(h.row);let calls=0;
  await expect(h.run(async held=>{calls++;expect(h.state.released).toBe(false);expect(Object.keys(held).sort()).toEqual(["adopt","assertCurrent","expiresAt"]);expect(held.expiresAt).toBe(6000);await held.assertCurrent();return"published";})).resolves.toBe("published");
  expect(calls).toBe(1);expect(h.state.transactions).toBe(1);expect(h.row).toEqual(before);
  expect(h.queries[0]!.params).toEqual(["deploylite:execution:project-a"]);expect(h.queries[0]!.sql).toContain("pg_advisory_xact_lock(hashtextextended(");
  for(const query of h.queries.filter(query=>query.table===controlCommands))expect(query.params).toEqual(["project","project-a","deployment","project-a"]);
  for(const query of h.queries.filter(query=>query.table===backupRetirementReservations))expect(query.params).toEqual(["project-a","destination-a",h.archiveId]);
});
it.each(["command","digest","project","correlation","lease","extra","native-preparation"])("rejects detached original %s before work",async field=>{
  const h=harness(field==="native-preparation"),raw=h.raw as Record<string,unknown>;let calls=0;
  if(field==="command")raw.commandId="foreign";
  if(field==="digest")raw.inputDigest="0".repeat(64);
  if(field==="project")raw.projectId="foreign";
  if(field==="correlation")raw.context={requestId:"other",correlationId:"foreign"};
  if(field==="lease")h.authority.projectLease.expiresAt=20000;
  if(field==="extra")raw.archiveId="caller-path";
  if(field==="native-preparation")raw.originalReplayFingerprint="bad";
  await expect(h.run(async()=>{calls++;})).rejects.toThrow("Backup publication is unavailable.");expect(calls).toBe(0);
});
it.each(["id","digest","project","correlation","idempotency","expiry","completed","actor","fence"])("rejects durable original %s mismatch without mutations",async field=>{
  const h=harness();let calls=0;
  if(field==="id")h.row.id="foreign";
  if(field==="digest")h.row.inputDigest="0".repeat(64);
  if(field==="project")h.row.scopeKey="foreign";
  if(field==="correlation")h.row.correlationId="foreign";
  if(field==="idempotency")h.row.idempotencyKey="foreign";
  if(field==="expiry")h.row.expiresAt.setTime(11000);
  if(field==="completed")h.row.status="completed";
  if(field==="actor")h.row.actorUserId="";
  if(field==="fence")h.rows.push({...structuredClone(h.row),id:"newer",executionAuthority:{...h.authority,commandId:"newer",projectLease:{...h.authority.projectLease,fence:3}}});
  const before=structuredClone(h.rows);await expect(h.run(async()=>{calls++;})).rejects.toThrow("Backup publication is unavailable.");expect(calls).toBe(0);expect(h.rows).toEqual(before);
});
it.each(["lock","authority","reservation"])("rejects cancellation/expiry after awaited %s before callback",async point=>{
  for(const cancel of [false,true]){const h=harness(),gate=h.hold(point);let calls=0;const attempt=h.run(async()=>{calls++;});await gate.entered;if(cancel)h.controller.abort();else h.tick(6000);gate.release();await expect(attempt).rejects.toThrow("Backup publication is unavailable.");expect(calls).toBe(0);}
});
it.each([NaN,-1,Infinity,8640000000000001])("rejects invalid initial clock %s without SQL",async now=>{
  const h=harness();h.tick(now);await expect(h.run(async()=>{})).rejects.toThrow("Backup publication is unavailable.");expect(h.queries).toEqual([]);
});
it("rejects canceled input and a backwards clock without dispatch",async()=>{
  const h=harness();h.controller.abort();await expect(h.run(async()=>{})).rejects.toThrow("Backup publication is unavailable.");expect(h.queries).toEqual([]);
  const b=harness(),gate=b.hold("lock");let calls=0;const attempt=b.run(async()=>{calls++;});await gate.entered;b.tick(999);gate.release();await expect(attempt).rejects.toThrow("Backup publication is unavailable.");expect(calls).toBe(0);
});
it.each([false,true])("denies every same-archive permanent reservation for %s across stores and volume aliases",async native=>{
  const h=harness(native);h.reservations.push({projectId:"project-a",destinationId:"destination-a",archiveId:h.archiveId,volumeKey:"foreign-alias",commandId:"different-retirement",expiresAt:new Date(0)});
  for(let attempt=0;attempt<2;attempt++){let calls=0;await expect(h.run(async()=>{calls++;})).rejects.toThrow("Backup publication is unavailable.");expect(calls).toBe(0);}expect(h.reservations).toHaveLength(1);
});
it("permits another archive without dropping reservation rows",async()=>{
  const h=harness();h.reservations.push({projectId:"project-a",destinationId:"destination-a",archiveId:"other",commandId:"retirement"});const before=structuredClone(h.reservations);
  await expect(h.run(async()=>"other archive")).resolves.toBe("other archive");expect(h.reservations).toEqual(before);
});
it.each(["actor","date","authority","abort","deadline","backwards"])("withholds success after final work/cleanup %s loss",async mode=>{
  const h=harness();let bytes="";await expect(h.run(async held=>{
    await held.adopt(async()=>{bytes="published";});
    if(mode==="actor")h.row.actorUserId="mutated";
    if(mode==="date")h.row.expiresAt.setTime(11000);
    if(mode==="authority")h.row.executionAuthority.projectLease.fence=3;
    if(mode==="abort")h.controller.abort();
    if(mode==="deadline")h.tick(6000);
    if(mode==="backwards")h.tick(999);
    return bytes;
  })).rejects.toThrow("Backup publication is unavailable.");expect(bytes).toBe("published");
});
it("uses first actor only as ledger provenance and rejects subsequent held-read mutation",async()=>{
  const h=harness();h.row.actorUserId="ledger-actor";let calls=0;
  await expect(h.run(async held=>{calls++;await held.assertCurrent();h.row.actorUserId="changed";await held.assertCurrent();})).rejects.toThrow("Backup publication is unavailable.");expect(calls).toBe(1);
});
it.each(["commit","release","acquire","lock","read","commit-expiry","release-cancel"])("withholds a result on transaction %s failure without retry",async point=>{
  const h=harness();h.fault(point);let calls=0;await expect(h.run(async()=>{calls++;return"published";})).rejects.toThrow("Backup publication is unavailable.");expect(calls).toBe(["acquire","lock","read"].includes(point)?0:1);expect(h.state.transactions).toBe(1);
});
it("withholds the first result if a transaction wrapper reenters its callback",async()=>{
  const h=harness();h.reenter();let calls=0;await expect(h.run(async()=>{calls++;})).rejects.toThrow("Backup publication is unavailable.");expect(calls).toBe(1);
});
it.each([false,true])("drains adopted work before normal release when callback fails=%s",async fail=>{
  const h=harness(),started=deferred(),finish=deferred();let settled=false;
  const attempt=h.run(async held=>{void held.adopt(async()=>{started.resolve();await finish.promise;settled=true;});await started.promise;if(fail)throw new Error("private callback");return"published";});
  const outcome=attempt.then(value=>({value}),()=>({error:true}));await started.promise;await Promise.resolve();expect(h.state.released).toBe(false);expect(settled).toBe(false);finish.resolve();
  expect(await outcome).toEqual(fail?{error:true}:{value:"published"});expect(settled).toBe(true);expect(h.state.released).toBe(true);
});
it("drains owned work after early connection failure without claiming the SQL lock survives",async()=>{
  const h=harness(),started=deferred(),finish=deferred();let settled=false,returned=false;
  const attempt=h.run(async held=>{await held.adopt(async()=>{started.resolve();await finish.promise;settled=true;});return"published";});
  const outcome=attempt.then(()=>{returned=true;return"success";},()=>{returned=true;return"unavailable";});await started.promise;h.breakConnection();await new Promise(resolve=>setTimeout(resolve,0));expect(h.state.released).toBe(true);expect(returned).toBe(false);finish.resolve();expect(await outcome).toBe("unavailable");expect(settled).toBe(true);
});
it("rejects leaked held context without further transaction reads or callbacks",async()=>{
  const h=harness();let held!:BackupPublicationHeld;await h.run(async value=>{held=value;});const count=h.queries.length;let calls=0;
  await expect(held.assertCurrent()).rejects.toThrow("Backup publication is unavailable.");await expect(held.adopt(async()=>{calls++;})).rejects.toThrow("Backup publication is unavailable.");expect(calls).toBe(0);expect(h.queries).toHaveLength(count);
});
it("withholds success even if callback swallows an adopted failure",async()=>{
  const h=harness();await expect(h.run(async held=>{await held.adopt(async()=>{throw new Error("owned failure");}).catch(()=>{});return"published";})).rejects.toThrow("Backup publication is unavailable.");
});
