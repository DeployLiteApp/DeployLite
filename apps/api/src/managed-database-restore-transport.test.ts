import {expect,it,vi} from "vitest";
import {signAgentTransport} from "@deploylite/config";
import {MANAGED_DATABASE_RESTORE_PATH,MANAGED_DATABASE_RESTORE_RECEIPT_PATH} from "@deploylite/contracts";
import {composeRuntimeResourceName,managedDatabaseRuntimeExecutionDigest,managedDatabaseBackupExecutionDigest,managedDatabaseBackupSourceDigest,prepareManagedDatabaseRestoreConfirmation} from "@deploylite/domain";
import {isAgentPreDispatchRejection} from "./agent-transport.js";
import {AuthenticatedManagedDatabaseRestoreTransport} from "./managed-database-restore-transport.js";
const engines=["postgres","mysql","mariadb","mongodb","redis"] as const;
function fixture(engine:typeof engines[number]="postgres"){
 const base={schemaVersion:1,projectId:"p1",databaseId:"orders",engine,profileId:"approved",planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32)};
 const originalReceipt={schemaVersion:1,projectId:base.projectId,databaseId:base.databaseId,engine:base.engine,action:"database.runtime",agentId:"agent-a",commandId:"creation-a",inputDigest:managedDatabaseRuntimeExecutionDigest(base),planDigest:base.planDigest,environmentFingerprint:base.environmentFingerprint,correlationId:"creation-correlation",containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:composeRuntimeResourceName("p1","volume","db-orders"),networkName:composeRuntimeResourceName("p1","network","db-orders"),networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:1000,status:"ready",health:"passed",storage:"verified",idempotent:false,redacted:true};
 const target={...base,originalReceipt,originalReplayFingerprint:"f".repeat(64)},capture={...target,destinationId:"destination-a",maxBytes:1048576};
 const {status:_status,health:_health,inputDigest:_digest,correlationId:_correlation,...resources}=originalReceipt;
 const backupReceipt={...resources,profileId:base.profileId,action:"database.runtime.backup",commandId:"backup-a",originalCommandId:originalReceipt.commandId,inputDigest:managedDatabaseBackupExecutionDigest(capture),correlationId:"backup-correlation",observedAt:2000,destinationId:capture.destinationId,sourceDigest:managedDatabaseBackupSourceDigest(capture),volumeKey:"db-orders",archiveId:"backup_"+"a".repeat(32),archiveBytes:4,archiveSha256:"a".repeat(64),manifestSha256:"b".repeat(64),format:{postgres:"postgres-custom-gzip",mysql:"mysql-sql-gzip",mariadb:"mariadb-sql-gzip",mongodb:"mongodb-archive-gzip",redis:"volume-tar"}[engine],consistency:{postgres:"native-snapshot",mysql:"global-read-lock",mariadb:"global-read-lock",mongodb:"quiesced-writes",redis:"all-consumers-stopped"}[engine],status:"created",idempotent:false};
 const preparation={...target,backupReceipt,maxBytes:capture.maxBytes};

 const intent=prepareManagedDatabaseRestoreConfirmation({preparation,actorId:"operator",idempotencyKey:"restore-once",correlationId:"restore-correlation",now:3000,commandTtlMs:5000});
 const authority={schemaVersion:1 as const,projectId:base.projectId,commandId:intent.command.id,action:"project.update" as const,inputDigest:intent.command.inputDigest,projectLease:{leaseId:"unit-lease",projectId:base.projectId,fence:2,expiresAt:8000}};
 const command={...intent.command,status:"dispatching" as const,projectExecutionAuthority:authority},prepared={command,input:preparation,agentId:"agent-a",confirmationId:intent.confirmation.id},context={requestId:"restore-request",correlationId:command.correlationId};
 const receipt={...base,action:"database.runtime.restore",agentId:"agent-a",commandId:command.id,originalCommandId:originalReceipt.commandId,backupCommandId:backupReceipt.commandId,confirmationId:prepared.confirmationId,inputDigest:command.inputDigest,correlationId:command.correlationId,containerId:originalReceipt.containerId,imageId:originalReceipt.imageId,volumeName:originalReceipt.volumeName,networkName:originalReceipt.networkName,networkId:originalReceipt.networkId,volumeCreatedAt:originalReceipt.volumeCreatedAt,archiveId:backupReceipt.archiveId,archiveBytes:backupReceipt.archiveBytes,archiveSha256:backupReceipt.archiveSha256,manifestSha256:backupReceipt.manifestSha256,format:backupReceipt.format,observedAt:3000,status:"restored",storage:"original",health:"passed",redacted:true};
 const cache={schemaVersion:1,action:receipt.action,agentId:"agent-a",commandId:command.id,confirmationId:prepared.confirmationId,correlationId:command.correlationId,receipt};
 const trustKey="unit-restore-key-"+"x".repeat(64),clock={now:3000};
 const signed=(url:unknown,init:RequestInit|undefined,value:unknown)=>{const path=new URL(String(url)).pathname,text=JSON.stringify(value);return new Response(text,{headers:{"x-deploylite-response-signature":signAgentTransport(`POST ${path}\n${init?.body}\n${text}`,trustKey)}});};
 const fetchResponse:typeof fetch=async(url,init)=>String(url).endsWith("/capabilities")?new Response(JSON.stringify({schemaVersion:1,agentId:"agent-a",capabilities:["database.runtime.restore.v1"],protocolVersions:[1]}),{headers:{"x-deploylite-request-signature":String((init?.headers as Record<string,string>)["x-deploylite-signature"])}}):signed(url,init,String(url).endsWith("/receipt")?cache:receipt);
 const fetcher=vi.fn(fetchResponse),options={endpoint:"https://agent.test",agentId:"agent-a",trustKey,timeoutMs:5000,fetch:fetcher,now:()=>clock.now};
 return {intent,prepared,authority,context,receipt,cache,clock,signed,fetchResponse,fetcher,options,transport:new AuthenticatedManagedDatabaseRestoreTransport(options)};
}
it.each(engines)("signs %s original confirmed apply and exact response without private execution data",async engine=>{
 const f=fixture(engine);await expect(f.transport.dispatch(f.prepared as any,f.authority,f.context)).resolves.toEqual(f.receipt);
 const [url,init]=f.fetcher.mock.calls[1]!;expect(url).toBe("https://agent.test"+MANAGED_DATABASE_RESTORE_PATH);expect(init?.redirect).toBe("error");
 expect((init?.headers as Record<string,string>)["x-deploylite-signature"]).toBe(signAgentTransport(`POST ${MANAGED_DATABASE_RESTORE_PATH}\n${init?.body}`,f.options.trustKey));
 const body=JSON.parse(String(init?.body));expect(body.confirmationId).toBe(f.intent.confirmation.id);expect(body.authority).toEqual(f.authority);for(const key of ["sealedEnvironment","argv","path","bytes","password"])expect(body).not.toHaveProperty(key);expect(f.intent.confirmation.consumedAt).toBeNull();
});
it("reads original signed cache after lease expiry and capability removal without dispatch",async()=>{
 const f=fixture();f.clock.now=9000;f.fetcher.mockImplementationOnce(async(_url,init)=>new Response(JSON.stringify({schemaVersion:1,agentId:"agent-a",capabilities:[],protocolVersions:[1]}),{headers:{"x-deploylite-request-signature":String((init?.headers as Record<string,string>)["x-deploylite-signature"])}}));
 await expect(f.transport.readReceipt(f.prepared as any,f.authority,f.context)).resolves.toEqual(f.receipt);expect(f.fetcher.mock.calls[1]![0]).toBe("https://agent.test"+MANAGED_DATABASE_RESTORE_RECEIPT_PATH);
 expect(JSON.parse(String(f.fetcher.mock.calls[1]![1]?.body))).not.toHaveProperty("cancellationRequested");
});
it("returns explicit authenticated cache absence without an effect",async()=>{const f=fixture();f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/capabilities")?f.fetchResponse(url,init):f.signed(url,init,{...f.cache,receipt:null}));await expect(f.transport.readReceipt(f.prepared as any,f.authority,f.context)).resolves.toBeNull();expect(f.fetcher.mock.calls.map(([url])=>url)).not.toContain("https://agent.test"+MANAGED_DATABASE_RESTORE_PATH);});
it.each(["digest","agent","authority","correlation","expiry"])("refuses detached %s apply before fetching",async mode=>{
 const f=fixture(),prepared=mode==="digest"?{...f.prepared,command:{...f.prepared.command,inputDigest:"0".repeat(64)}}:mode==="agent"?{...f.prepared,agentId:"foreign"}:f.prepared;
 if(mode==="expiry")f.clock.now=8000;
 const error=await f.transport.dispatch(prepared as any,mode==="authority"?{...f.authority,commandId:"foreign"}:f.authority,mode==="correlation"?{...f.context,correlationId:"foreign"}:f.context).catch(error=>error);expect(isAgentPreDispatchRejection(error)).toBe(true);expect(f.fetcher).not.toHaveBeenCalled();
});
it.each(["signature","archive","nonce","source","private","late"])("refuses detached %s response after POST without claiming no effect",async mode=>{
 const f=fixture(),patch=mode==="archive"?{archiveSha256:"0".repeat(64)}:mode==="nonce"?{confirmationId:"foreign"}:mode==="source"?{containerId:"0".repeat(64)}:mode==="private"?{bytes:"private"}:mode==="late"?{observedAt:8000}:{};
 f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith("/capabilities")?f.fetchResponse(url,init):mode==="signature"?new Response(JSON.stringify(f.receipt)):f.signed(url,init,{...f.receipt,...patch}));
 const error=await f.transport.dispatch(f.prepared as any,f.authority,f.context).catch(error=>error);expect(error).toBeInstanceOf(Error);expect(isAgentPreDispatchRejection(error)).toBe(false);expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it("bounds hung signed response and pre-cancelled request without posting",async()=>{
 const f=fixture();f.fetcher.mockImplementation(()=>new Promise(()=>{}));await expect(new AuthenticatedManagedDatabaseRestoreTransport({...f.options,timeoutMs:5}).dispatch(f.prepared as any,f.authority,f.context)).rejects.toThrow();
 const g=fixture(),controller=new AbortController();controller.abort();await expect(g.transport.dispatch(g.prepared as any,g.authority,{...g.context,signal:controller.signal})).rejects.toThrow();expect(g.fetcher).not.toHaveBeenCalled();
});

it.each(["pending","detached-authority"])("denies %s command before signed effects",async mode=>{
 const f=fixture(),command=mode==="pending"?{...f.prepared.command,status:"pending_confirmation"}: {...f.prepared.command,projectExecutionAuthority:{...f.authority,projectLease:{...f.authority.projectLease,fence:3}}};
 const error=await f.transport.dispatch({...f.prepared,command} as any,f.authority,f.context).catch(error=>error);
 expect(isAgentPreDispatchRejection(error)).toBe(true);expect(f.fetcher).not.toHaveBeenCalled();
});
