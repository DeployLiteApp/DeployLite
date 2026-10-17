import {lstat} from "node:fs/promises";
import type {Stats} from "node:fs";
import {dirname,resolve,sep} from "node:path";
import {composeBackupFilesystem} from "./docker-compose-volume-backup.js";
export const PRIVATE_ARCHIVE_AGENT_UID=10001;
export const PRIVATE_ARCHIVE_ANCHOR="/var/lib/deploylite-agent/backups";
/** Packaged composition contract only; no provisioning, repair or host-exclusivity assertion. */
export async function validatePrivateArchiveRuntimeRoots(destinations:ReadonlyMap<string,string>):Promise<void>{
  const unavailable=()=>{throw new Error("Private archive root is unavailable.");};
  const current=()=>{if(process.geteuid?.()!==PRIVATE_ARCHIVE_AGENT_UID)unavailable();};
  const pinned=new Map<string,Stats>();current();
  for(const destination of destinations.values()){
    if(resolve(destination)!==destination || (destination!==PRIVATE_ARCHIVE_ANCHOR&&!destination.startsWith(PRIVATE_ARCHIVE_ANCHOR+sep)))unavailable();
    for(let path=destination;;path=dirname(path)){
      current();const info=await lstat(path);current();
      const privatePath=path===PRIVATE_ARCHIVE_ANCHOR||path.startsWith(PRIVATE_ARCHIVE_ANCHOR+sep);
      if(info.isSymbolicLink()||!info.isDirectory()||(privatePath?(info.uid!==PRIVATE_ARCHIVE_AGENT_UID||info.gid!==PRIVATE_ARCHIVE_AGENT_UID||(info.mode&0o7777)!==0o700):(info.uid!==0||(info.mode&0o022)!==0)))unavailable();
      if(privatePath){const safe=await composeBackupFilesystem.safeDirectory(path,true);current();if(safe.path!==path||!composeBackupFilesystem.sameDirectory(info,safe.info))unavailable();}
      const previous=pinned.get(path);if(previous&&!composeBackupFilesystem.sameDirectory(previous,info))unavailable();pinned.set(path,info);
      if(path==="/")break;
    }
  }
  for(const [path,info] of pinned){
    const after=await lstat(path);current();if(!composeBackupFilesystem.sameDirectory(info,after)||after.isSymbolicLink()||!after.isDirectory())unavailable();
    if(path===PRIVATE_ARCHIVE_ANCHOR||path.startsWith(PRIVATE_ARCHIVE_ANCHOR+sep)){
      const safe=await composeBackupFilesystem.safeDirectory(path,true);current();if(safe.path!==path||!composeBackupFilesystem.sameDirectory(info,safe.info))unavailable();
    }
  }
  current();
}
