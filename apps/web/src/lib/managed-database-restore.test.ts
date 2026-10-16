import {expect,it,vi} from "vitest";
import {managedDatabaseBackupReceiptSchema,managedDatabaseHealthPreparationSchema,managedDatabaseRestoreReceiptSchema,type ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {prepareManagedDatabaseRestore,applyManagedDatabaseRestore} from "./managed-database-restore";
function fixture(engine: ManagedDatabaseEngineV1 = "postgres") {
  const now = Date.now(), base = {schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine, profileId: "profile-a",
    planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32)};
  const {profileId: _profile, ...runtime} = base;
  const original = {...runtime, action: "database.runtime", agentId: "agent-a", commandId: "original-a", inputDigest: "c".repeat(64),
    correlationId: "original-correlation", containerId: "d".repeat(64), imageId: "sha256:" + "e".repeat(64),
    volumeName: "dl-" + "1".repeat(32) + "-vol-db-orders", networkName: "dl-" + "1".repeat(32) + "-net-db-orders",
    networkId: "f".repeat(64), volumeCreatedAt: new Date(now - 3000).toISOString(), observedAt: now - 2000,
    status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true};
  const source = managedDatabaseHealthPreparationSchema.parse({...base, originalReceipt: original, originalReplayFingerprint: "2".repeat(64)});
  const formats = {postgres: "postgres-custom-gzip", mysql: "mysql-sql-gzip", mariadb: "mariadb-sql-gzip", mongodb: "mongodb-archive-gzip", redis: "volume-tar"};
  const consistency = {postgres: "native-snapshot", mysql: "global-read-lock", mariadb: "global-read-lock", mongodb: "quiesced-writes", redis: "all-consumers-stopped"};
  const receipt = managedDatabaseBackupReceiptSchema.parse({...base, action: "database.runtime.backup", agentId: "agent-a", commandId: "backup-a",
    originalCommandId: original.commandId, inputDigest: "3".repeat(64), correlationId: "backup-correlation", containerId: original.containerId,
    imageId: original.imageId, volumeName: original.volumeName, networkName: original.networkName, networkId: original.networkId,
    volumeCreatedAt: original.volumeCreatedAt, volumeKey: "db-orders", destinationId: "destination-a", sourceDigest: "4".repeat(64),
    archiveId: "backup_" + "5".repeat(32), archiveBytes: 2048, archiveSha256: "6".repeat(64), manifestSha256: "7".repeat(64),
    format: formats[engine], consistency: consistency[engine], observedAt: now - 1000, status: "created", idempotent: false, storage: "verified", redacted: true});
  const inventory = {schemaVersion: 1 as const, receipt, createdAtMs: now - 999};
  const preparation = {...source, destinationId: "destination-a", maxBytes: 4096};
  const command = {id: receipt.commandId, action: "project.update" as const, status: "completed" as const, scope: {kind: "project" as const, projectId: base.projectId},
    inputDigest: receipt.inputDigest, correlationId: receipt.correlationId, idempotencyKey: "backup-key", expiresAt: new Date(now + 60000).toISOString()};
  const response = (data: unknown) => new Response(JSON.stringify({data, error: null, requestId: "backup-request"}));
  const outcome = {command, receipt, inventory, originalBackupReplayFingerprint: "8".repeat(64), backupCreated: true as const, idempotent: false};
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response(outcome));
  return {source, preparation, receipt, inventory, command, outcome, response, fetchImpl,
    options: {apiBaseUrl: "https://api.example.test", actorId: "operator-a", fetchImpl}};
}
function restoreFixture(engine:ManagedDatabaseEngineV1="postgres"){
 const f=fixture(engine),now=Date.now();
 const selection={...f.source,archiveId:f.receipt.archiveId,destinationId:f.receipt.destinationId,expectedArchiveSha256:f.receipt.archiveSha256,expectedManifestSha256:f.receipt.manifestSha256,maxBytes:f.preparation.maxBytes};
 const command={...f.command,id:"restore-a",inputDigest:"9".repeat(64),correlationId:"restore-correlation",idempotencyKey:"restore-key",status:"pending_confirmation" as const};
 const confirmation={id:"restore-nonce",classification:"destructive" as const,expiresAt:command.expiresAt,consumedAt:null};
 const prepared={selection,idempotencyKey:"restore-key",command,confirmation};
 const {health:_health,status:_status,idempotent:_idem,...physical}=f.source.originalReceipt;
 const receipt=managedDatabaseRestoreReceiptSchema.parse({...physical,action:"database.runtime.restore",profileId:f.source.profileId,commandId:command.id,inputDigest:command.inputDigest,correlationId:command.correlationId,originalCommandId:f.source.originalReceipt.commandId,backupCommandId:f.receipt.commandId,confirmationId:confirmation.id,archiveId:f.receipt.archiveId,archiveBytes:f.receipt.archiveBytes,archiveSha256:f.receipt.archiveSha256,manifestSha256:f.receipt.manifestSha256,format:f.receipt.format,observedAt:now-500,status:"restored",storage:"original",health:"passed"});
 const completed={command:{...command,status:"completed" as const},receipt,restored:true as const,idempotent:false};
 const prepareResponse={command,confirmation,idempotent:false};
 f.fetchImpl.mockImplementation(async()=>f.response(prepareResponse));
 return {...f,selection,prepared,receipt,completed,prepareResponse};
}
it.each(["postgres","mysql","mariadb","mongodb","redis"] as const)("prepares an original %s restore selector without dispatching archive bytes",async engine=>{
 const f=restoreFixture(engine);expect(await prepareManagedDatabaseRestore(f.selection,f.options,"restore-key")).toEqual({kind:"ready",prepared:f.prepared});expect(f.fetchImpl).toHaveBeenCalledOnce();
 const [url,init]=f.fetchImpl.mock.calls[0]!;expect(String(url)).toContain("/runtime/restore/prepare");const {projectId:_project,databaseId:_database,...body}=f.selection;expect(JSON.parse(String(init!.body))).toEqual(body);expect(new Headers(init!.headers).get("idempotency-key")).toBe("restore-key");expect(new Headers(init!.headers).get("x-deploylite-expected-actor-id")).toBe("operator-a");
});
it.each(["postgres","mysql","mariadb","mongodb","redis"] as const)("applies exactly the original %s nonce and key and validates original-target receipt",async engine=>{
 const f=restoreFixture(engine);f.fetchImpl.mockImplementation(async()=>f.response(f.completed));expect(await applyManagedDatabaseRestore(f.prepared,f.options)).toMatchObject({kind:"ready",receipt:f.receipt});expect(f.fetchImpl).toHaveBeenCalledOnce();
 const [url,init]=f.fetchImpl.mock.calls[0]!;expect(String(url)).toContain("/runtime/restore/apply");const {projectId:_project,databaseId:_database,...body}=f.selection;expect(JSON.parse(String(init!.body))).toEqual({...body,confirmationId:"restore-nonce"});expect(new Headers(init!.headers).get("idempotency-key")).toBe("restore-key");expect(new Headers(init!.headers).get("x-deploylite-expected-actor-id")).toBe("operator-a");
});
it("recovers only the same original nonce and key after an unknown reply and lease expiry",async()=>{
 const f=restoreFixture(),expired=new Date(Date.now()-100).toISOString();
 f.prepared.command.expiresAt=expired;f.prepared.confirmation.expiresAt=expired;f.completed.command.expiresAt=expired;
 f.fetchImpl.mockRejectedValueOnce(new Error("private sentinel"));
 expect(await applyManagedDatabaseRestore(f.prepared,f.options)).toEqual({kind:"error",message:"Restore could not be confirmed."});expect(f.fetchImpl).toHaveBeenCalledOnce();
 f.fetchImpl.mockImplementation(async()=>f.response({...f.completed,idempotent:true}));
 expect(await applyManagedDatabaseRestore(f.prepared,f.options)).toMatchObject({kind:"ready",receipt:f.receipt,idempotent:true});expect(f.fetchImpl).toHaveBeenCalledTimes(2);
 for(const [url,init] of f.fetchImpl.mock.calls){expect(String(url)).toContain("/restore/apply");expect(new Headers(init!.headers).get("idempotency-key")).toBe("restore-key");expect(JSON.parse(String(init!.body)).confirmationId).toBe("restore-nonce");}
});
it("uses the caller's original preparation key after a lost preparation response without automatic retry",async()=>{
 const f=restoreFixture();f.fetchImpl.mockRejectedValueOnce(new Error("lost"));expect(await prepareManagedDatabaseRestore(f.selection,f.options,"restore-key")).toMatchObject({kind:"error"});expect(f.fetchImpl).toHaveBeenCalledOnce();
 f.fetchImpl.mockImplementation(async()=>f.response({...f.prepareResponse,idempotent:true}));expect(await prepareManagedDatabaseRestore(f.selection,f.options,"restore-key")).toEqual({kind:"ready",prepared:f.prepared});
 for(const [,init] of f.fetchImpl.mock.calls)expect(new Headers(init!.headers).get("idempotency-key")).toBe("restore-key");
});
it("rejects detached approval command scope hashes original resources time and private output",async()=>{
 for(const mode of ["key","command","digest","correlation","nonce","scope","original","profile","container","archive","sha","manifest","budget","future","private"]){
  const f=restoreFixture(),data=structuredClone(f.completed);
  if(mode==="key")data.command.idempotencyKey="foreign";if(mode==="command")data.receipt.commandId="foreign";if(mode==="digest")data.receipt.inputDigest="a".repeat(64);
  if(mode==="correlation")data.receipt.correlationId="foreign";if(mode==="nonce")data.receipt.confirmationId="foreign";if(mode==="scope")data.command.scope.projectId="foreign";
  if(mode==="original")data.receipt.originalCommandId="foreign";if(mode==="profile")data.receipt.profileId="foreign";if(mode==="container")data.receipt.containerId="a".repeat(64);
  if(mode==="archive")data.receipt.archiveId="backup_"+"a".repeat(32);if(mode==="sha")data.receipt.archiveSha256="a".repeat(64);if(mode==="manifest")data.receipt.manifestSha256="a".repeat(64);
  if(mode==="budget")data.receipt.archiveBytes=4097;if(mode==="future")data.receipt.observedAt=Date.now()+60000;if(mode==="private")Object.assign(data.receipt,{privatePath:"private-sentinel"});
  f.fetchImpl.mockImplementation(async()=>f.response(data));expect(await applyManagedDatabaseRestore(f.prepared,f.options)).toEqual({kind:"error",message:"Restore could not be confirmed."});expect(f.fetchImpl).toHaveBeenCalledOnce();
 }
});
it("rejects private selectors invalid actors cancelled callers and malformed saved approvals before RPC",async()=>{
 for(const mode of ["private","actor","cancelled","consumed"]){
  const f=restoreFixture(),controller=new AbortController();if(mode==="private")Object.assign(f.prepared.selection,{backupReceipt:{privatePath:"secret"}});if(mode==="actor")f.options.actorId="../foreign";if(mode==="cancelled")controller.abort();if(mode==="consumed")Object.assign(f.prepared.confirmation,{consumedAt:1000});
  expect(await applyManagedDatabaseRestore(f.prepared,{...f.options,signal:controller.signal})).toMatchObject({kind:"error"});expect(f.fetchImpl).not.toHaveBeenCalled();
 }
});
it("withholds expired or detached preparation without attempting apply or renewing its approval",async()=>{
 for(const mode of ["expired","scope","key","consumed","late","private"]){
  const f=restoreFixture(),data=structuredClone(f.prepareResponse);
  if(mode==="expired")data.confirmation.expiresAt=new Date(Date.now()-1).toISOString();if(mode==="scope")data.command.scope.projectId="foreign";if(mode==="key")data.command.idempotencyKey="foreign";
  if(mode==="consumed")Object.assign(data.confirmation,{consumedAt:1000});if(mode==="late")data.confirmation.expiresAt=new Date(Date.parse(data.command.expiresAt)+1).toISOString();if(mode==="private")Object.assign(data.command,{projectExecutionAuthority:{secret:"private"}});
  f.fetchImpl.mockImplementation(async()=>f.response(data));expect(await prepareManagedDatabaseRestore(f.selection,f.options,"restore-key")).toMatchObject({kind:"error"});expect(f.fetchImpl).toHaveBeenCalledOnce();
 }
});
it("snapshots the selected archive original nonce and actor before a suspended request",async()=>{
 const f=restoreFixture();f.fetchImpl.mockImplementation(async()=>{f.prepared.selection.expectedArchiveSha256="a".repeat(64);f.prepared.confirmation.id="foreign";f.options.actorId="foreign";return f.response(f.completed);});
 expect(await applyManagedDatabaseRestore(f.prepared,f.options)).toMatchObject({kind:"ready",receipt:f.receipt});const [,init]=f.fetchImpl.mock.calls[0]!;
 expect(new Headers(init!.headers).get("x-deploylite-expected-actor-id")).toBe("operator-a");expect(JSON.parse(String(init!.body)).confirmationId).toBe("restore-nonce");expect(JSON.parse(String(init!.body)).expectedArchiveSha256).toBe(f.receipt.archiveSha256);
});
