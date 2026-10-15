import {createHash} from "node:crypto";
import {constants,type Stats} from "node:fs";
import {lstat,open,type FileHandle} from "node:fs/promises";
import {join} from "node:path";
import {protocolPayloadFingerprint,type Clock} from "@deploylite/contracts";
import {awaitAbortable,managedDatabaseRestoreExecutionBinding} from "@deploylite/domain";
import {nativeBackupArchiveManifestSchema} from "./docker-managed-database-backup-archive.js";
import {composeBackupFilesystem} from "./docker-compose-volume-backup.js";

type FileInfo=Stats;
type Options=Readonly<{destinations:ReadonlyMap<string,string>;expectedAgentId:string;clock:Clock;maxBytes:number;maxDurationMs:number}>;
function unavailable():never{throw new Error("Native restore archive is unavailable.");}
function sameFile(a:FileInfo,b:FileInfo){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mode===b.mode&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
function privateFile(info:FileInfo,limit:number){if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||!Number.isSafeInteger(info.size)||info.size<1||info.size>limit)unavailable();}

/** Read-only integrity observation. No bytes/path, restore grant or native decode acceptance. */
export function createPrivateNativeRestoreArchive(supplied:Options){
 let options:Options;
 try{
  options={...supplied,destinations:new Map(supplied.destinations)};
  if(!/^[A-Za-z0-9_-]{1,200}$/.test(options.expectedAgentId)||!Number.isSafeInteger(options.maxBytes)||options.maxBytes<1
   ||!Number.isSafeInteger(options.maxDurationMs)||options.maxDurationMs<1||options.maxDurationMs>2147483647)unavailable();
 }catch{return unavailable();}
 return {async verify(raw:unknown,external:AbortSignal){
  const controller=new AbortController(),cancel=()=>controller.abort(),handles=new Set<FileHandle>();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   external.addEventListener("abort",cancel,{once:true});if(external.aborted)cancel();
   const {backupReceipt:receipt}=managedDatabaseRestoreExecutionBinding(raw),start=options.clock.now(),deadline=start+options.maxDurationMs;
   function current(){const now=options.clock.now();if(controller.signal.aborted||external.aborted||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(deadline)
    ||!Number.isSafeInteger(now)||now<start||now>=deadline||receipt.agentId!==options.expectedAgentId||receipt.archiveBytes>options.maxBytes)unavailable();}
   async function read<T>(work:()=>Promise<T>){current();const result=await awaitAbortable(work,controller.signal);current();return result;}
   current();timer=setTimeout(cancel,options.maxDurationMs);
   const configured=options.destinations.get(receipt.destinationId);if(!configured)unavailable();
   const expectedId="backup_"+createHash("sha256").update(receipt.projectId+"\0"+receipt.commandId+"\0"+receipt.destinationId).digest("hex").slice(0,32);
   if(receipt.archiveId!==expectedId)unavailable();
   const root=await read(()=>composeBackupFilesystem.safeDirectory(configured,true)),directory=await read(()=>composeBackupFilesystem.safeDirectory(join(root.path,receipt.archiveId),true));
   async function openOwned(path:string){
    current();const pending=open(path,constants.O_RDONLY|constants.O_NOFOLLOW);let adopted=false;
    try{const handle=await awaitAbortable(()=>pending,controller.signal);adopted=true;handles.add(handle);current();return handle;}
    catch(error){if(!adopted)void pending.then(handle=>handle.close().catch(()=>{}),()=>{});throw error;}
   }
   const files:Array<{path:string;handle:FileHandle;info:FileInfo}>=[];
   async function inspect(path:string,limit:number,collect:boolean){
    const info=await read(()=>lstat(path));privateFile(info,limit);
    const handle=await openOwned(path),opened=await read(()=>handle.stat());if(!sameFile(info,opened))unavailable();
    files.push({path,handle,info});
    const hash=createHash("sha256"),buffer=Buffer.alloc(Math.min(65536,limit+1)),chunks:Buffer[]=[];let bytes=0;
    for(;;){
     const result=await read(()=>handle.read(buffer,0,Math.min(buffer.length,limit-bytes+1),bytes));if(result.bytesRead===0)break;
     bytes+=result.bytesRead;if(bytes>info.size||bytes>limit)unavailable();const value=buffer.subarray(0,result.bytesRead);hash.update(value);if(collect)chunks.push(Buffer.from(value));
    }
    if(bytes!==info.size||!sameFile(info,await read(()=>handle.stat())))unavailable();
    return {sha256:hash.digest("hex"),bytes:collect?Buffer.concat(chunks):undefined};
   }
   const manifest=await inspect(join(directory.path,"manifest.json"),8192,true);
   if(manifest.sha256!==receipt.manifestSha256)unavailable();
   const parsed=nativeBackupArchiveManifestSchema.parse(JSON.parse(manifest.bytes!.toString("utf8")));
   const expected={schemaVersion:1,projectId:receipt.projectId,commandId:receipt.commandId,inputDigest:receipt.inputDigest,agentId:receipt.agentId,
    correlationId:receipt.correlationId,destinationId:receipt.destinationId,sourceDigest:receipt.sourceDigest,format:receipt.format,archiveBytes:receipt.archiveBytes,archiveSha256:receipt.archiveSha256};
   if(protocolPayloadFingerprint(parsed)!==protocolPayloadFingerprint(expected))unavailable();
   const data=await inspect(join(directory.path,"archive.bin"),receipt.archiveBytes,false);if(data.sha256!==receipt.archiveSha256)unavailable();
   for(const file of files){if(!sameFile(file.info,await read(()=>file.handle.stat()))||!sameFile(file.info,await read(()=>lstat(file.path))))unavailable();}
   for(const [path,initial] of [[root.path,root.info],[directory.path,directory.info]] as const){const latest=await read(()=>composeBackupFilesystem.safeDirectory(path,true));if(latest.info.dev!==initial.dev||latest.info.ino!==initial.ino||latest.info.mode!==initial.mode)unavailable();}
   current();return Object.freeze({archiveId:receipt.archiveId,archiveBytes:receipt.archiveBytes,archiveSha256:receipt.archiveSha256,manifestSha256:receipt.manifestSha256,format:receipt.format,integrity:"verified" as const,redacted:true as const});
  }catch{return unavailable();}
  finally{controller.abort();if(timer)clearTimeout(timer);external.removeEventListener("abort",cancel);await Promise.allSettled([...handles].map(handle=>handle.close()));}
 }};
}
