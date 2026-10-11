import {randomUUID} from "node:crypto";
import {expect,it} from "vitest";
import type pg from "pg";
import {createDbClient,createDbPool,closeDbPool} from "./client.js";
import {DbBackupInventoryStore} from "./repositories/backup-inventory.js";
import {DbControlCommandRepository} from "./repositories/control-plane.js";
/** Metadata persistence only. Shares the existing disposable P5 database and pool lifecycle. */
export function defineNativeBackupInventoryCases(getPool:()=>pg.Pool,getUrl:()=>string) {
  const store=(pool=getPool())=>new DbBackupInventoryStore(createDbClient(pool),"agent-1");
  async function seed() {
    const pool=getPool(),projectId=randomUUID(),actorId=randomUUID(),commandId=randomUUID(),correlationId=randomUUID();
    await pool.query("INSERT INTO users(id,email,email_normalized,password_hash,role_id) SELECT $1,$2,$2,'fixture',id FROM roles WHERE name='admin'",[actorId,`${actorId}@example.test`]);
    await pool.query("INSERT INTO projects(id,name,repo_url,default_branch) VALUES($1,'Native inventory fixture','https://example.test/repo','main')",[projectId]);
    const receipt={schemaVersion:1,projectId,databaseId:"orders",engine:"postgres",action:"database.runtime.backup",agentId:"agent-1",commandId,originalCommandId:randomUUID(),profileId:"fixture-postgres",inputDigest:"a".repeat(64),planDigest:"a".repeat(64),environmentFingerprint:"b".repeat(32),correlationId,containerId:"c".repeat(64),imageId:"sha256:"+"d".repeat(64),volumeName:"dl-"+"b".repeat(32)+"-vol-db-orders",networkName:"dl-"+"b".repeat(32)+"-net-db-orders",networkId:"e".repeat(64),volumeCreatedAt:"2026-10-10T00:00:00Z",observedAt:Date.now()-1000,volumeKey:"db-orders",destinationId:"fixture-native",sourceDigest:"f".repeat(64),archiveId:"backup_"+randomUUID().replaceAll("-",""),archiveBytes:4,archiveSha256:"a".repeat(64),manifestSha256:"b".repeat(64),format:"postgres-custom-gzip",consistency:"native-snapshot",status:"created",idempotent:false,storage:"verified",redacted:true};
    await pool.query("INSERT INTO control_commands(id,actor_user_id,action,scope_kind,scope_key,input_digest,idempotency_key,correlation_id,status,expires_at) VALUES($1,$2,'project.update','project',$3,$4,$6,$5,'eligible',now()+interval '1 hour')",[commandId,actorId,projectId,receipt.inputDigest,correlationId,commandId]);
    const controls=new DbControlCommandRepository(createDbClient(pool));
    const command=await controls.findProjectUpdateByIdempotency(actorId,projectId,commandId);
    const claimed=await controls.claimProjectUpdate(command!);
    await controls.completeProjectUpdate(claimed.command,claimed.authority!,{actorUserId:actorId,action:"database.runtime.backup.executed",targetType:"project",targetId:projectId,requestId:randomUUID(),correlationId,metadata:{...receipt}});
    return receipt;
  }
  it("persists native inventory from actual completion audit across a fresh pool",async()=>{
    const receipt=await seed(),record=await store().recordAuthenticatedReceipt(receipt);
    const fresh=createDbPool(getUrl(),{max:1});
    try {expect(await store(fresh).list(receipt.projectId,receipt.volumeKey,receipt.destinationId)).toEqual([record]);}
    finally {await closeDbPool(fresh);}
    expect(record.receipt.action).toBe("database.runtime.backup");
  });
  it("enforces native database keys and rejects missing or unknown receipt action in SQL",async()=>{
    const receipt=await seed();await store().recordAuthenticatedReceipt(receipt);
    await expect(getPool().query("UPDATE backup_inventory SET receipt=receipt - 'databaseId' WHERE command_id=$1",[receipt.commandId])).rejects.toMatchObject({code:"23514"});
    await expect(getPool().query("UPDATE backup_inventory SET receipt=jsonb_set(receipt,'{databaseId}','\"foreign\"'::jsonb) WHERE command_id=$1",[receipt.commandId])).rejects.toMatchObject({code:"23514"});
    await expect(getPool().query("UPDATE backup_inventory SET receipt=jsonb_set(receipt,'{action}','\"unknown\"'::jsonb) WHERE command_id=$1",[receipt.commandId])).rejects.toMatchObject({code:"23514"});
    expect(await store().list(receipt.projectId,receipt.volumeKey,receipt.destinationId)).toHaveLength(1);
  });
  it("converges native concurrent inventory and replay without overwriting original evidence",async()=>{
    const receipt=await seed(),records=await Promise.all([store().recordAuthenticatedReceipt(receipt),store().recordAuthenticatedReceipt(receipt)]);
    expect(records[0]).toEqual(records[1]);
    expect(await store().recordAuthenticatedReceipt({...receipt,status:"already-created",idempotent:true})).toEqual(records[0]);
    const count=await getPool().query("SELECT count(*)::int AS count FROM backup_inventory WHERE command_id=$1",[receipt.commandId]);
    expect(count.rows[0].count).toBe(1);
  });
}
