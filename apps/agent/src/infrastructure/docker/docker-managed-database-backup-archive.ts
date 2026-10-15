import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat,mkdir,mkdtemp,open,link,rm,type FileHandle} from "node:fs/promises";
import {join} from "node:path";
import {z} from "zod";
import {protocolPayloadFingerprint,type Clock} from "@deploylite/contracts";
import {awaitAbortable} from "@deploylite/domain";
import {composeBackupFilesystem,type ComposeVolumeBackupAuthority} from "./docker-compose-volume-backup.js";
const identity=z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),digest=z.string().regex(/^[a-f0-9]{64}$/),positive=z.number().int().safe().positive();
const bindingSchema=z.object({projectId:identity,commandId:identity,inputDigest:digest,agentId:identity,correlationId:identity,destinationId:identity,sourceDigest:digest,
 format:z.enum(["postgres-custom-gzip","mysql-sql-gzip","mariadb-sql-gzip","mongodb-archive-gzip","volume-tar"])}).strict();
const manifestSchema=bindingSchema.extend({schemaVersion:z.literal(1),archiveBytes:positive,archiveSha256:digest}).strict();
export {manifestSchema as nativeBackupArchiveManifestSchema};
export type NativeBackupArchiveBinding=z.infer<typeof bindingSchema>;
export type NativeBackupProducer=(write:(bytes:Uint8Array)=>Promise<void>,signal:AbortSignal)=>Promise<{bytes:number;sha256:string}>;
function fail():never {throw new Error("Native archive is unavailable.");}
type DirectoryInfo=Awaited<ReturnType<typeof lstat>>;
async function removeOwned(path:string|undefined,original:DirectoryInfo|undefined){
 if(!path||!original)return;
 try {const current=await lstat(path);if(current.isDirectory()&&!current.isSymbolicLink()&&current.dev===original.dev&&current.ino===original.ino)await rm(path,{recursive:true,force:true});}catch{/* preserve unrecognized paths */}
}
/** Existing allowlisted filesystem destination model; no engine effect, public bytes or caller path. */
export function createPrivateNativeBackupArchive(supplied:{destinations:ReadonlyMap<string,string>;clock:Clock;maxBytes:number;maxDurationMs:number}){
 const options={...supplied,destinations:new Map(supplied.destinations)};
 if(!positive.safeParse(options.maxBytes).success||!positive.max(2147483647).safeParse(options.maxDurationMs).success)fail();
 return {async write(raw:unknown,producer:NativeBackupProducer,authority:ComposeVolumeBackupAuthority,external:AbortSignal){
  const controller=new AbortController(),cancel=()=>controller.abort();external.addEventListener("abort",cancel,{once:true});if(external.aborted)cancel();
  let timer:ReturnType<typeof setTimeout>|undefined,temporary:string|undefined,tempInfo:DirectoryInfo|undefined,final:string|undefined,finalInfo:DirectoryInfo|undefined,handle:FileHandle|undefined,published=false,accepting=false;
  try {
   const binding=bindingSchema.parse(structuredClone(raw)),start=options.clock.now(),deadline=Math.min(start+options.maxDurationMs,authority.expiresAt??Number.MAX_SAFE_INTEGER);
   function current(){const now=options.clock.now();if(controller.signal.aborted||external.aborted||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(now)||now<start||!Number.isSafeInteger(deadline)||now>=deadline
    ||binding.projectId!==authority.projectId||binding.commandId!==authority.commandId||binding.inputDigest!==authority.inputDigest)fail();}
   async function gate(){current();await awaitAbortable(()=>authority.assertValid(),controller.signal);current();}
   async function read<T>(work:()=>Promise<T>){current();const result=await awaitAbortable(work,controller.signal);current();return result;}
   current();timer=setTimeout(cancel,deadline-start);await gate();
   const configured=options.destinations.get(binding.destinationId);if(!configured)fail();
   const root=await read(()=>composeBackupFilesystem.safeDirectory(configured,true));
   const archiveId="backup_"+createHash("sha256").update(binding.projectId+"\0"+binding.commandId+"\0"+binding.destinationId).digest("hex").slice(0,32);
   final=join(root.path,archiveId);
   async function rootCurrent(){const value=await read(()=>composeBackupFilesystem.safeDirectory(configured!,true));if(value.info.dev!==root.info.dev||value.info.ino!==root.info.ino)fail();}
   function receipt(manifest:z.infer<typeof manifestSchema>,bytes:Buffer,idempotent:boolean){return {archiveId,archiveBytes:manifest.archiveBytes,archiveSha256:manifest.archiveSha256,manifestSha256:createHash("sha256").update(bytes).digest("hex"),idempotent,redacted:true as const};}
   async function existing(){
    try {await read(()=>lstat(final!));}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw error;}
    await read(()=>composeBackupFilesystem.safeDirectory(final!,true));
    const manifestPath=join(final!,"manifest.json"),info=await read(()=>lstat(manifestPath));if(info.isSymbolicLink()||!info.isFile()||info.size>8192||(info.mode&0o077)!==0)fail();
    const input=await open(manifestPath,constants.O_RDONLY|constants.O_NOFOLLOW);let bytes:Buffer;
    try {bytes=await read(()=>input.readFile());}finally{await input.close();}
    const manifest=manifestSchema.parse(JSON.parse(bytes.toString("utf8"))),{schemaVersion:_version,archiveBytes:_bytes,archiveSha256:_sha,...stored}=manifest;
    if(protocolPayloadFingerprint(stored)!==protocolPayloadFingerprint(binding)||manifest.archiveBytes>options.maxBytes)fail();
    const path=join(final!,"archive.bin"),dataInfo=await read(()=>lstat(path));if(dataInfo.isSymbolicLink()||!dataInfo.isFile()||dataInfo.size!==manifest.archiveBytes||(dataInfo.mode&0o077)!==0)fail();
    const actual=await read(()=>composeBackupFilesystem.hashFile(path,controller.signal));if(actual.bytes!==manifest.archiveBytes||actual.sha256!==manifest.archiveSha256)fail();
    await rootCurrent();await gate();return receipt(manifest,bytes,true);
   }
   const previous=await existing();if(previous)return previous;
   await gate();await mkdir(final,{mode:0o700});finalInfo=await lstat(final);current();
   temporary=await mkdtemp(join(root.path,".pending-"+archiveId+"-"));tempInfo=await lstat(temporary);current();
   const dataPath=join(temporary,"archive.bin");handle=await open(dataPath,"wx",0o600);current();
   const hash=createHash("sha256");let bytes=0,reserved=0,writeFailure=false,writes=Promise.resolve();accepting=true;
   const write=(chunk:Uint8Array):Promise<void>=>{
    let value:Buffer;
    try {current();if(!accepting||!(chunk instanceof Uint8Array)||chunk.length>options.maxBytes-reserved)fail();reserved+=chunk.length;value=Buffer.from(chunk);}
    catch {writeFailure=true;const rejected=Promise.reject(new Error("Native archive is unavailable."));void rejected.catch(()=>undefined);return rejected;}
    const step=writes.then(async()=>{
     if(writeFailure)fail();await gate();let offset=0;
     while(offset<value.length){current();const result=await handle!.write(value,offset,value.length-offset,null);current();if(result.bytesWritten<1)fail();offset+=result.bytesWritten;}
     hash.update(value);bytes+=value.length;
    });
    writes=step.catch(()=>{writeFailure=true;});return step;
   };
   const reported=await read(()=>producer(write,controller.signal));accepting=false;await read(()=>writes);if(writeFailure)fail();await gate();
   if(bytes<1||reported.bytes!==bytes||reported.sha256!==hash.digest("hex"))fail();
   await handle.sync();await handle.close();handle=undefined;current();
   const actual=await read(()=>composeBackupFilesystem.hashFile(dataPath,controller.signal));if(actual.bytes!==bytes||actual.sha256!==reported.sha256)fail();
   const manifest=manifestSchema.parse({...binding,schemaVersion:1,archiveBytes:bytes,archiveSha256:actual.sha256}),manifestBytes=Buffer.from(JSON.stringify(manifest));
   const manifestPath=join(temporary,"manifest.json"),output=await open(manifestPath,"wx",0o600);
   try {await output.writeFile(manifestBytes);await output.sync();}finally{await output.close();}
   await rootCurrent();await gate();
   const before=await read(()=>lstat(final!));if(before.dev!==finalInfo.dev||before.ino!==finalInfo.ino||before.isSymbolicLink())fail();
   await link(dataPath,join(final,"archive.bin"));current();await gate();await link(manifestPath,join(final,"manifest.json"));published=true;current();
   for(const path of [final,root.path]){const directory=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY);try {await directory.sync();}finally{await directory.close();}current();}
   const result=await existing();if(!result)fail();return {...result,idempotent:false};
  }catch{return fail();}finally{
   accepting=false;controller.abort();
   if(timer)clearTimeout(timer);external.removeEventListener("abort",cancel);await handle?.close().catch(()=>undefined);
   await removeOwned(temporary,tempInfo);if(!published)await removeOwned(final,finalInfo);
  }
 }};
}
