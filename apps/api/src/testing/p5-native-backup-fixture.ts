/** Hosted-only proof; private archive bytes never enter public evidence. */
import {createHash} from "node:crypto";
import {mkdir,lstat,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {gunzipSync} from "node:zlib";
import {expect} from "vitest";
import {managedDatabaseBackupReceiptSchema} from "@deploylite/contracts";
import type {DbBackupInventoryStore} from "@deploylite/db";
import type {DockerCliRunner} from "../../../agent/src/infrastructure/docker/docker-cli-image-transport.js";

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
      runner:DockerCliRunner;
      signal:AbortSignal;
      captures():number;
      maxBytes:number;
      originalContainerId:string;
    }>) {
      const first=await input.call();expect(first.statusCode).toBe(200);
      const data=first.json().data,receipt=managedDatabaseBackupReceiptSchema.parse(data.receipt);
      expect(data).toMatchObject({backupCreated:true,idempotent:false});
      expect(receipt).toMatchObject({format:"postgres-custom-gzip",consistency:"native-snapshot",status:"created",containerId:input.originalContainerId});
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
      expect(gunzipSync(bytes,{maxOutputLength:input.maxBytes}).subarray(0,5).toString()).toBe("PGDMP");
      // Only the selected owned daemon receives this disposable fixture copy.
      const copied="/tmp/dl-native-backup-"+receipt.commandId+".gz";let copyIssued=false;
      try {
        await input.verify();copyIssued=true;
        await input.runner.run(["docker","cp",archive,input.originalContainerId+":"+copied],input.signal);
        await input.verify();
        const output=await input.runner.run(["docker","exec",input.originalContainerId,"bash","-o","pipefail","-c",
          `gzip -cd '${copied}' | pg_restore --file=- | grep -F -x 'p5-persistent-value'`],input.signal);
        expect(output.stdout.trim()).toBe("p5-persistent-value");
      } finally {
        if(copyIssued){await input.verify();await input.runner.run(["docker","exec",input.originalContainerId,"rm","--",copied],input.signal);}
      }
      const before=await input.inventory().list(receipt.projectId,receipt.volumeKey,receipt.destinationId);expect(before).toHaveLength(1);expect(before[0]!.receipt).toEqual(receipt);
      await input.reopen();
      expect(await input.inventory().list(receipt.projectId,receipt.volumeKey,receipt.destinationId)).toEqual(before);
      const replay=await input.call();expect(replay.statusCode).toBe(200);expect(replay.json().data).toMatchObject({backupCreated:true,idempotent:true});
      expect(replay.json().data.receipt).toEqual(receipt);expect(input.captures()).toBe(1);
      expect(await input.inventory().list(receipt.projectId,receipt.volumeKey,receipt.destinationId)).toEqual(before);
      expect(await readFile(archive)).toEqual(bytes);expect(await readFile(manifest)).toEqual(manifestBytes);
      proof={receipt,maxBytes:input.maxBytes,captures:input.captures(),signedHttp:"passed",formatValidated:"passed",seededRow:"passed",inventoryReopen:"passed",replay:"passed",privateFiles:"passed",cleanup:"pending"};
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
