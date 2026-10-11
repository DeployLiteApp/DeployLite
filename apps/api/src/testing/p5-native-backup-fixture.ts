/** Hosted-only proof; private archive bytes never enter public evidence. */
import {createHash} from "node:crypto";
import {mkdir,lstat,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {gunzipSync} from "node:zlib";
import {expect} from "vitest";
import {managedDatabaseBackupReceiptSchema} from "@deploylite/contracts";
import type {DbBackupInventoryStore} from "@deploylite/db";

export function nativeDumpFixture(root:string) {
  let owned:Awaited<ReturnType<typeof lstat>>|undefined;
  let proof:Record<string,unknown>|undefined;
  return {
    async open() {await mkdir(root,{mode:0o700});owned=await lstat(root);},
    async prove(input:Readonly<{
      call():Promise<{statusCode:number;body:string;json():any}>;
      reopen():Promise<void>;
      inventory():DbBackupInventoryStore;
      verify():Promise<unknown>;
      decode(bytes:Buffer):Promise<void>;
      signal:AbortSignal;
      captures():number;
      maxBytes:number;
      originalContainerId:string;
      uid:number;
      writerProbe?():Promise<void>;
      stoppedSource?:boolean;
    }>) {
      if(!Number.isSafeInteger(input.uid)||input.uid<1||input.uid>4294967294)throw new Error("Corroborated non-root decoder required.");
      const first=await input.call();expect(first.statusCode).toBe(200);
      const data=first.json().data,receipt=managedDatabaseBackupReceiptSchema.parse(data.receipt);
      expect(data).toMatchObject({backupCreated:true,idempotent:false});
      const sql=receipt.engine==="mysql"||receipt.engine==="mariadb",redis=receipt.engine==="redis",mongo=receipt.engine==="mongodb";
      expect(receipt).toMatchObject({format:mongo?"mongodb-archive-gzip":redis?"volume-tar":sql?receipt.engine+"-sql-gzip":"postgres-custom-gzip",consistency:mongo?"quiesced-writes":redis?"all-consumers-stopped":sql?"global-read-lock":"native-snapshot",status:"created",containerId:input.originalContainerId});
      expect(data.command).not.toHaveProperty("projectExecutionAuthority");
      expect(first.body).not.toMatch(/encryptedValue|sealedEnvironment|DATABASE_PASSWORD|privatePath/);
      const directory=join(root,receipt.archiveId),archive=join(directory,"archive.bin"),manifest=join(directory,"manifest.json");
      for(const [path,mode] of [[root,0o700],[directory,0o700],[archive,0o600],[manifest,0o600]] as const){
        const value=await lstat(path);expect(value.isSymbolicLink()).toBe(false);expect(value.uid).toBe(process.getuid!());expect(value.mode&0o777).toBe(mode);
      }
      const bytes=await readFile(archive),manifestBytes=await readFile(manifest);
      expect(bytes.length).toBe(receipt.archiveBytes);expect(bytes.length).toBeLessThanOrEqual(input.maxBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.archiveSha256);
      expect(createHash("sha256").update(manifestBytes).digest("hex")).toBe(receipt.manifestSha256);
      const decoded=redis?bytes:gunzipSync(bytes,{maxOutputLength:input.maxBytes});
      if(redis){if(input.stoppedSource!==true)throw new Error("Stopped Redis source required.");expect(bytes.length%512===0&&bytes.subarray(257,262).toString()==="ustar").toBe(true);}
      else if(sql){
        const contents=decoded.toString("utf8");
        expect(contents.includes("p5-persistent-value")&&contents.includes("p5-nontransactional-value")&&contents.includes("MyISAM")&&contents.includes("CREATE TABLE")).toBe(true);
        if(!input.writerProbe)throw new Error("Native SQL writer probe required.");
        try {await input.writerProbe();}catch {throw new Error("Native SQL writers did not resume.");}
      }else if(mongo){
        expect(decoded.length>=4&&decoded.readUInt32LE(0)===0x8199e26d).toBe(true);
        if(!input.writerProbe)throw new Error("Native Mongo writer probe required.");
        try{await input.writerProbe();}catch{throw new Error("Native Mongo writers did not resume.");}
      }else{
        expect(decoded.subarray(0,5).toString()).toBe("PGDMP");
      }
      await input.verify();
      try {await input.decode(bytes);}catch {throw new Error("Private native dump fixture failed at restore.");}
      await input.verify();
      const before=await input.inventory().list(receipt.projectId,receipt.volumeKey,receipt.destinationId);expect(before).toHaveLength(1);expect(before[0]!.receipt).toEqual(receipt);
      await input.reopen();
      expect(await input.inventory().list(receipt.projectId,receipt.volumeKey,receipt.destinationId)).toEqual(before);
      const replay=await input.call();expect(replay.statusCode).toBe(200);expect(replay.json().data).toMatchObject({backupCreated:true,idempotent:true});
      expect(replay.json().data.receipt).toEqual(receipt);expect(input.captures()).toBe(1);
      expect(await input.inventory().list(receipt.projectId,receipt.volumeKey,receipt.destinationId)).toEqual(before);
      if(createHash("sha256").update(await readFile(archive)).digest("hex")!==receipt.archiveSha256)throw new Error("Private native archive changed.");
      if(createHash("sha256").update(await readFile(manifest)).digest("hex")!==receipt.manifestSha256)throw new Error("Private native manifest changed.");
      proof={...(redis?{stoppedSource:"passed",sourceCleanup:"pending"}:{}),...((sql||mongo)?{writersResumed:"passed"}:{}),restoredData:"passed",restoreCleanup:"passed",receipt,maxBytes:input.maxBytes,captures:input.captures(),signedHttp:"passed",formatValidated:"passed",seededRow:"passed",inventoryReopen:"passed",replay:"passed",privateFiles:"passed",cleanup:"pending"};
      return proof;
    },
    async close() {
      if(!owned)return;
      const current=await lstat(root);expect(current.isDirectory()&&!current.isSymbolicLink()).toBe(true);expect([current.dev,current.ino]).toEqual([owned.dev,owned.ino]);
      await rm(root,{recursive:true});await expect(lstat(root)).rejects.toMatchObject({code:"ENOENT"});
      if(proof)proof.cleanup="passed";
    }
  };
}
