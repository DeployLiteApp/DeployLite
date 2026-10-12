// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import {managedDatabaseBackupReceiptSchema,managedDatabaseHealthPreparationSchema,managedDatabaseRestoreReceiptSchema,type ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {prepareManagedDatabaseRestore,applyManagedDatabaseRestore} from "@/lib/managed-database-restore";
import {ManagedDatabaseRestoreControl, readRecoverableManagedDatabaseRestores} from "./managed-database-restore-control";
vi.mock("@/lib/managed-database-restore",async importOriginal=>({...await importOriginal<object>(),prepareManagedDatabaseRestore:vi.fn(),applyManagedDatabaseRestore:vi.fn()}));
const prepare=vi.mocked(prepareManagedDatabaseRestore),apply=vi.mocked(applyManagedDatabaseRestore);
afterEach(()=>{cleanup();vi.resetAllMocks();vi.restoreAllMocks();sessionStorage.clear();});
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
function setup(){
 const f=restoreFixture();prepare.mockImplementation(async(_raw,_options,key)=>({kind:"ready",prepared:{...f.prepared,idempotencyKey:key,command:{...f.prepared.command,idempotencyKey:key}}}));
 apply.mockResolvedValue({kind:"ready",receipt:f.receipt,idempotent:false});const onRestored=vi.fn(),onBusyChange=vi.fn();
 return {...f,onRestored,props:{selection:f.selection,apiBaseUrl:"https://api.example.test",actorId:"operator-a",currentState:"running" as const,onRestored,onBusyChange}};
}
async function open(){fireEvent.click(screen.getByRole("button",{name:"Restore backup"}));await screen.findByRole("dialog",{name:"Restore database"});}
it("prepares only on click and requires a separate destructive confirmation",async()=>{
 const f=setup();render(<ManagedDatabaseRestoreControl {...f.props}/>);expect(prepare).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();await open();
 expect(screen.getByText("Restore replaces current database data with this backup.")).toBeTruthy();expect(apply).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"Confirm restore"}));await waitFor(()=>expect(f.onRestored).toHaveBeenCalledOnce());
 expect(apply.mock.calls[0]![0]).toMatchObject({confirmation:{id:"restore-nonce"},idempotencyKey:prepare.mock.calls[0]![2]});expect(apply.mock.calls[0]![1]).toMatchObject({actorId:"operator-a"});
});
it("cancels an unused approval and reopens the exact same key and nonce",async()=>{
 const f=setup();render(<ManagedDatabaseRestoreControl {...f.props}/>);await open();fireEvent.click(screen.getByRole("button",{name:"Cancel"}));await open();expect(prepare).toHaveBeenCalledOnce();expect(apply).not.toHaveBeenCalled();
});
it("recovers an unknown apply after reload without preparation or automatic execution",async()=>{
 const f=setup();apply.mockResolvedValueOnce({kind:"error",message:"private sentinel"});const view=render(<ManagedDatabaseRestoreControl {...f.props}/>);await open();
 fireEvent.click(screen.getByRole("button",{name:"Confirm restore"}));await screen.findByRole("button",{name:"Retry original restore"});const original=apply.mock.calls[0]![0];expect(apply).toHaveBeenCalledOnce();view.unmount();
 render(<ManagedDatabaseRestoreControl {...f.props} currentState={null}/>);fireEvent.click(await screen.findByRole("button",{name:"Retry restore confirmation"}));await screen.findByRole("dialog");expect(prepare).toHaveBeenCalledOnce();expect(apply).toHaveBeenCalledOnce();
 fireEvent.click(screen.getByRole("button",{name:"Retry original restore"}));await waitFor(()=>expect(f.onRestored).toHaveBeenCalledOnce());expect(apply.mock.calls[1]![0]).toEqual(original);
});
it("withholds the first destructive apply when the original unused approval expired",async()=>{
 const f=setup(),expired=new Date(Date.now()-1).toISOString();prepare.mockImplementation(async(_raw,_options,key)=>({kind:"ready",prepared:{...f.prepared,idempotencyKey:key,command:{...f.prepared.command,idempotencyKey:key,expiresAt:expired},confirmation:{...f.prepared.confirmation,expiresAt:expired}}}));
 render(<ManagedDatabaseRestoreControl {...f.props}/>);await open();expect((screen.getByRole("button",{name:"Confirm restore"}) as HTMLButtonElement).disabled).toBe(true);expect(apply).not.toHaveBeenCalled();
});
it("refuses preparation if the original retry state cannot be saved",async()=>{
 const f=setup();render(<ManagedDatabaseRestoreControl {...f.props}/>);vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("quota private sentinel");});
 fireEvent.click(screen.getByRole("button",{name:"Restore backup"}));await screen.findByText("The original restore request could not be saved.");expect(prepare).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();
});
it("aborts an old actor's preparation and withholds its approval after actor change",async()=>{
 const f=setup();let finish!:(value:Awaited<ReturnType<typeof prepare>>)=>void;prepare.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const view=render(<ManagedDatabaseRestoreControl {...f.props}/>);fireEvent.click(screen.getByRole("button",{name:"Restore backup"}));await waitFor(()=>expect(prepare).toHaveBeenCalledOnce());
 const signal=prepare.mock.calls[0]![1].signal!;view.rerender(<ManagedDatabaseRestoreControl {...f.props} actorId="operator-b"/>);expect(signal.aborted).toBe(true);
 const key=prepare.mock.calls[0]![2];finish({kind:"ready",prepared:{...f.prepared,idempotencyKey:key,command:{...f.prepared.command,idempotencyKey:key}}});await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());expect(apply).not.toHaveBeenCalled();
});
it("retains an active original preparation through equivalent parent source rerenders",async()=>{
 const f=setup();let finish!:(value:Awaited<ReturnType<typeof prepare>>)=>void;prepare.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 const view=render(<ManagedDatabaseRestoreControl {...f.props}/>);fireEvent.click(screen.getByRole("button",{name:"Restore backup"}));await waitFor(()=>expect(prepare).toHaveBeenCalledOnce());
 const signal=prepare.mock.calls[0]![1].signal!,key=prepare.mock.calls[0]![2];view.rerender(<ManagedDatabaseRestoreControl {...f.props} selection={structuredClone(f.selection)}/>);
 expect(signal.aborted).toBe(false);finish({kind:"ready",prepared:{...f.prepared,idempotencyKey:key,command:{...f.prepared.command,idempotencyKey:key}}});await screen.findByRole("dialog");expect(prepare).toHaveBeenCalledOnce();
});
it("persists the original uncertain nonce before apply and withholds apply if that write fails",async()=>{
 const f=setup();render(<ManagedDatabaseRestoreControl {...f.props}/>);await open();
 vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("private quota");});
 fireEvent.click(screen.getByRole("button",{name:"Confirm restore"}));await screen.findByText("The original restore request could not be saved.");expect(apply).not.toHaveBeenCalled();expect(prepare).toHaveBeenCalledOnce();
});
it("recovers a lost preparation across reload using the same original key without automatic preparation",async()=>{
 const f=setup();prepare.mockResolvedValueOnce({kind:"error",message:"private sentinel"});const view=render(<ManagedDatabaseRestoreControl {...f.props}/>);
 fireEvent.click(screen.getByRole("button",{name:"Restore backup"}));await screen.findByRole("button",{name:"Retry restore preparation"});const key=prepare.mock.calls[0]![2];view.unmount();
 render(<ManagedDatabaseRestoreControl {...f.props}/>);const button=await screen.findByRole("button",{name:"Retry restore preparation"});expect(prepare).toHaveBeenCalledOnce();fireEvent.click(button);await screen.findByRole("dialog");
 expect(prepare.mock.calls[1]![2]).toBe(key);expect(prepare.mock.calls[1]![0]).toEqual(prepare.mock.calls[0]![0]);expect(apply).not.toHaveBeenCalled();
});
it("allows only explicit original apply recovery after an unknown result and original approval expiry",async()=>{
 const f=setup();apply.mockResolvedValueOnce({kind:"error",message:"unknown"});const view=render(<ManagedDatabaseRestoreControl {...f.props}/>);await open();fireEvent.click(screen.getByRole("button",{name:"Confirm restore"}));await screen.findByRole("button",{name:"Retry original restore"});
 const original=apply.mock.calls[0]![0];view.unmount();vi.spyOn(Date,"now").mockReturnValue(Date.now()+61000);
 render(<ManagedDatabaseRestoreControl {...f.props} currentState={null}/>);fireEvent.click(await screen.findByRole("button",{name:"Retry restore confirmation"}));await screen.findByRole("dialog");expect(apply).toHaveBeenCalledOnce();expect(prepare).toHaveBeenCalledOnce();
 fireEvent.click(screen.getByRole("button",{name:"Retry original restore"}));await waitFor(()=>expect(f.onRestored).toHaveBeenCalledOnce());expect(apply.mock.calls[1]![0]).toEqual(original);
});
it("keeps the original nonce after confirmation persistence fails and never prepares another approval",async()=>{
 const f=setup(),real=Storage.prototype.setItem;let writes=0;
 vi.spyOn(Storage.prototype,"setItem").mockImplementation(function(this:Storage,key,value){if(++writes===4)throw new Error("quota");real.call(this,key,value);});
 render(<ManagedDatabaseRestoreControl {...f.props}/>);await open();fireEvent.click(screen.getByRole("button",{name:"Confirm restore"}));await screen.findByRole("button",{name:"Retry original restore"});expect(f.onRestored).not.toHaveBeenCalled();
 const original=apply.mock.calls[0]![0];fireEvent.click(screen.getByRole("button",{name:"Retry original restore"}));await waitFor(()=>expect(f.onRestored).toHaveBeenCalledOnce());expect(apply.mock.calls[1]![0]).toEqual(original);expect(prepare).toHaveBeenCalledOnce();
});
it("aborts an old actor's apply and withholds its result from the replacement actor",async()=>{
 const f=setup();let finish!:(value:Awaited<ReturnType<typeof apply>>)=>void;apply.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const view=render(<ManagedDatabaseRestoreControl {...f.props}/>);await open();
 const button=screen.getByRole("button",{name:"Confirm restore"});fireEvent.click(button);fireEvent.click(button);expect(apply).toHaveBeenCalledOnce();const signal=apply.mock.calls[0]![1].signal!;
 view.rerender(<ManagedDatabaseRestoreControl {...f.props} actorId="operator-b"/>);expect(signal.aborted).toBe(true);finish({kind:"ready",receipt:f.receipt,idempotent:false});await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());expect(f.onRestored).not.toHaveBeenCalled();expect(apply).toHaveBeenCalledOnce();
});
it("blocks malformed original journal state rather than silently creating another key",()=>{
 const f=setup(),scope=JSON.stringify([f.props.apiBaseUrl,f.props.actorId,f.selection]);sessionStorage.setItem("deploylite.native-restore:"+scope,'{"key":"foreign"}');
 render(<ManagedDatabaseRestoreControl {...f.props}/>);const button=screen.getByRole("button",{name:"Restore backup"});expect((button as HTMLButtonElement).disabled).toBe(true);fireEvent.click(button);expect(prepare).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();
});

it("recovers only this actor API and original source and preserves selectors without any RPC",()=>{
 const f=setup(),saved={key:f.prepared.idempotencyKey,selection:f.selection,prepared:f.prepared,uncertainApply:true,confirmedReceipt:null};
 const slot="deploylite.native-restore:"+JSON.stringify([f.props.apiBaseUrl,f.props.actorId,f.selection]);sessionStorage.setItem(slot,JSON.stringify(saved));
 expect(readRecoverableManagedDatabaseRestores(f.source,f.props.apiBaseUrl,f.props.actorId)).toEqual([f.selection]);
 expect(readRecoverableManagedDatabaseRestores(f.source,f.props.apiBaseUrl,"operator-b")).toEqual([]);
 expect(readRecoverableManagedDatabaseRestores(f.source,"https://other.example.test",f.props.actorId)).toEqual([]);
 expect(readRecoverableManagedDatabaseRestores({...f.source,originalReceipt:{...f.source.originalReceipt,containerId:"a".repeat(64)}},f.props.apiBaseUrl,f.props.actorId)).toEqual([]);
 expect(prepare).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();
});
it("rejects a detached or contradictory completed receipt before clearing an original pending recovery",()=>{
 for(const mode of ["nonce","uncertainty"]){
  const f=setup(),receipt={...f.receipt,confirmationId:mode==="nonce"?"foreign":f.receipt.confirmationId};
  const saved={key:f.prepared.idempotencyKey,selection:f.selection,prepared:f.prepared,uncertainApply:mode==="uncertainty",confirmedReceipt:receipt};
  sessionStorage.setItem("deploylite.native-restore:"+JSON.stringify([f.props.apiBaseUrl,f.props.actorId,f.selection]),JSON.stringify(saved));
  expect(()=>readRecoverableManagedDatabaseRestores(f.source,f.props.apiBaseUrl,f.props.actorId)).toThrow();expect(prepare).not.toHaveBeenCalled();expect(apply).not.toHaveBeenCalled();sessionStorage.clear();
 }
});
