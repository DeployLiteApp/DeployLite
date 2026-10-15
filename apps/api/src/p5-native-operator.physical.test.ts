import {prepareManagedDatabaseRestore,type ManagedDatabaseRestorePreparationAccess} from "./managed-database-restore-prepare.js";
import {createPrivateNativeRestoreArchive} from "../../agent/src/infrastructure/docker/docker-managed-database-restore-archive.js";
import {spawn} from "node:child_process";
import {restoreNativeMongoFixture} from "./testing/p5-native-mongo-decoder.js";
import {restoreNativeRedisFixture} from "./testing/p5-native-redis-decoder.js";
import {createLocalDirectoryComposeVolumeBackupSource} from "../../agent/src/infrastructure/docker/docker-compose-volume-backup.js";
import {mkdir,lstat,rm} from "node:fs/promises";
import {restoreNativeSqlFixture} from "./testing/p5-native-sql-decoder.js";
import {decodeNativePostgresFixture} from "./testing/p5-native-postgres-decoder.js";
import {nativeCaptureErrorKind,nativeDumpFixture} from "./testing/p5-native-backup-fixture.js";
import {applyManagedDatabaseDelete,type ManagedDatabaseDeleteApplyAccess} from "./managed-database-delete-apply.js";
import {AuthenticatedManagedDatabaseDeleteTransport} from "./managed-database-delete-transport.js";
import {AuthenticatedManagedDatabaseRuntimeTransport} from "./managed-database-runtime-transport.js";
import {signAgentTransport, createEnvSecretCipher, loadEnvSecretKey, redactLogMessage} from "@deploylite/config";
import {afterAll, beforeAll, expect, it, vi} from "vitest";
import {createHash, randomBytes, randomUUID} from "node:crypto";
import {lstatSync, readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import type {FastifyInstance} from "fastify";
import {AuthenticatedAgentCommandReceiver, startAgentServer} from "@deploylite/agent";
import {managedDatabaseBackupReceiptSchema, managedDatabaseDeleteReceiptQuerySchema, managedDatabaseDeleteReceiptSchema, MANAGED_DATABASE_DELETE_PATH, MANAGED_DATABASE_DELETE_RECEIPT_PATH, approvedManagedDatabaseProfileSchema, InMemoryCapabilityRegistry, managedDatabaseRuntimeReceiptSchema, managedDatabaseStopReceiptSchema, managedDatabaseStartReceiptSchema,
  MANAGED_DATABASE_STOP_PATH, MANAGED_DATABASE_START_PATH, MANAGED_DATABASE_HEALTH_PATH, managedDatabaseHealthObservationSchema, MANAGED_DATABASE_METRICS_PATH, managedDatabaseMetricsObservationSchema, MANAGED_DATABASE_LOGS_PATH, managedDatabaseLogsObservationSchema, type ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {DbAgentReplayStore, DbBackupInventoryStore, DbControlCommandRepository, DbProjectRepository} from "@deploylite/db";
import {prepareVerifiedManagedDatabaseRestoreConfirmation, managedDatabaseRestoreExecutionDigest, evaluateConfirmation, planManagedDatabaseProfile,type ControlCommand,managedDatabaseDeleteExecutionDigest,managedDatabaseDeleteReceiptMatches,createControlCommand, managedDatabaseNativeImagePolicy} from "@deploylite/domain";
import {buildApiApp} from "./app.js";
import {openDatabaseBrowser} from "./testing/p5-browser-fixture.js";
import {openOperatorSession} from "./testing/p5-operator-session.js";
import {DockerProcessRunner, DockerProcessError} from "../../agent/src/infrastructure/docker/docker-process-runner.js";
import type {DockerCliRunner} from "../../agent/src/infrastructure/docker/docker-cli-image-transport.js";
import {createConfiguredManagedDatabaseRuntime} from "../../agent/src/infrastructure/docker/managed-database-runtime-config.js";
import {createManagedDatabaseDockerInspector} from "../../agent/src/infrastructure/docker/docker-managed-database-inspection.js";
import {createManagedDatabaseResourceMaterializer, type ManagedDatabaseFreshResources} from "../../agent/src/infrastructure/docker/docker-managed-database-resources.js";
import {createManagedDatabaseReadinessVerifier} from "../../agent/src/infrastructure/docker/docker-managed-database-readiness.js";
import {createManagedDatabaseProcessIdentityReader} from "../../agent/src/infrastructure/docker/docker-managed-database-process-identity.js";
import {createDockerComposeResourceInspector} from "../../agent/src/infrastructure/docker/docker-compose-resource-inspector.js";
import {MANAGED_DATABASE_VOLUME_INSPECT_FORMAT, MANAGED_DATABASE_NETWORK_INSPECT_FORMAT} from "../../agent/src/infrastructure/docker/docker-managed-database-resource-argv.js";
const engines = ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const;
// Unsupported collection fails; no skipped test registrations or local runtime fallback.
if (process.platform !== "linux" || process.env.DEPLOYLITE_P5_OPERATOR_PHYSICAL !== "1"
  || process.env.DEPLOYLITE_P5_OPERATOR_RUNTIME_GRANT !== "P5_OPERATOR_CI_APPROVED") throw new Error("Explicit hosted operator fixture required.");
const directory = resolve(process.env.RUNNER_TEMP ?? "/unavailable", "deploylite-p5-operator-evidence");
const bindingPath = resolve(directory, "binding.json"), metadata = lstatSync(bindingPath);
if (metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) throw new Error("Private operator binding required.");
const scope = JSON.parse(readFileSync(bindingPath, "utf8")) as {commit:string; runId:string; runAttempt:string; nonce:string; postgresPort:number; profiles:Record<ManagedDatabaseEngineV1,unknown>};
for (const [key, value] of [["GITHUB_REPOSITORY", "DeployLiteApp/DeployLite"], ["GITHUB_JOB", "p5-native-operator-acceptance"],
  ["GITHUB_RUN_ID", scope.runId], ["GITHUB_RUN_ATTEMPT", scope.runAttempt], ["DEPLOYLITE_P5_EXPECTED_SHA", scope.commit]] as const)
  if (process.env[key] !== value) throw new Error("Changed operator fixture scope.");
const profiles = Object.fromEntries(engines.map(engine => [engine, approvedManagedDatabaseProfileSchema.parse(scope.profiles[engine])]));
let session: Awaited<ReturnType<typeof openOperatorSession>> | undefined;
const evidence: Record<string, unknown> = {}, actualFetch = globalThis.fetch;
beforeAll(async () => { session = await openOperatorSession(); }, 70000);
function requiredSession() { if (!session) throw new Error("Owned operator session unavailable."); return session; }
const marker = "p5-persistent-value";
function probe(engine:ManagedDatabaseEngineV1, write:boolean, hostname = "127.0.0.1",statement?:string) {
  if (!/^(127\.0\.0\.1|db-[a-z][a-z0-9_-]{0,59})$/.test(hostname)) throw new Error("Scoped fixture hostname required.");
  const sql = statement ?? (write ? "CREATE TABLE IF NOT EXISTS p5_probe (value varchar(64)); DELETE FROM p5_probe; INSERT INTO p5_probe VALUES ('p5-persistent-value');" : "SELECT value FROM p5_probe;");
  if (engine === "postgres") return `PGPASSWORD="$POSTGRES_PASSWORD" psql --host ${hostname} --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-password --tuples-only --no-align --command "${sql}"`;
  if (engine === "mysql" || engine === "mariadb") {
    const prefix = engine === "mysql" ? "MYSQL" : "MARIADB", binary = engine === "mysql" ? "mysql" : "mariadb";
    return `MYSQL_PWD="$${prefix}_PASSWORD" ${binary} --host ${hostname} --user "$${prefix}_USER" --database "$${prefix}_DATABASE" --batch --skip-column-names --execute "${sql}"`;
  }
  if (engine === "mongodb") return `mongosh --quiet --host ${hostname} --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval '${write ? 'db.getSiblingDB(process.env.MONGO_INITDB_DATABASE).p5_probe.updateOne({_id:"probe"},{$set:{value:"p5-persistent-value"}},{upsert:true})' : 'print(db.getSiblingDB(process.env.MONGO_INITDB_DATABASE).p5_probe.findOne({_id:"probe"}).value)'}'`;
  return `REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning -h ${hostname} ${write ? "SET p5_probe p5-persistent-value" : "GET p5_probe"}`;
}
for (const engine of engines) it(`native operator physical ${engine} startup stop and persistence`, async () => {
  const db = requiredSession(), projectId = randomUUID(), agentId = randomUUID(), databaseId = "orders";
  const signal = AbortSignal.timeout(200000), created = new Set<string>(), profile = profiles[engine]!;
  let pinned: ManagedDatabaseFreshResources | undefined, volume: ManagedDatabaseFreshResources["volume"] | undefined;
  let network: ManagedDatabaseFreshResources["network"] | undefined, originalCommandId: string | undefined, originalPlanDigest: string | undefined;
  let statsDispatches=0, logReads=0, legacyPhase=true, backupCaptures=0;
  const backupMaxBytes=2097152, backupRoot=resolve(process.env.RUNNER_TEMP!,"deploylite-p5-native-private-"+projectId);
  const dump=["postgres","mysql","mariadb","mongodb","redis"].includes(engine)?nativeDumpFixture(backupRoot):undefined;
  let nativeBackup:Record<string,unknown>|undefined;
  let captureError:ReturnType<typeof nativeCaptureErrorKind>="unknown";
  let captureExit:Readonly<{code:number|null;signal:string|null}>|undefined;
  let captureFailure:"before-capture"|"connection"|"identity"|"preexisting-lock"|"acquisition"|"acknowledgement"|"dump"|"cleanup"|"token"|"clock"|"shell"|"unknown"="before-capture";
  const redisSourceRoot=resolve(process.env.RUNNER_TEMP!,"deploylite-p5-redis-source-"+projectId),redisRoots=new Map<string,string>();
  let redisSourceInfo:Awaited<ReturnType<typeof lstat>>|undefined;
  let redisBackupResponse:Awaited<ReturnType<FastifyInstance["inject"]>>|undefined;
  const redisSource=createLocalDirectoryComposeVolumeBackupSource(redisRoots);
  let browserFixture: Awaited<ReturnType<typeof openDatabaseBrowser>> | undefined;
  const logRequests: string[][] = [];
  const processRunner = new DockerProcessRunner({timeoutMs:60000,maxOutputBytes:131072});
  const runner: DockerCliRunner = {run: async (argv, abort, environment) => {
    const reply = await processRunner.run(argv, abort, environment);
    if(argv[1]==="stats")statsDispatches++;
    if (argv[1] === "logs" && argv.includes("--timestamps")) {logReads++; logRequests.push([...argv]);}
    if (argv[1] === "create" && /^[a-f0-9]{64}$/.test(reply.stdout.trim())) created.add(reply.stdout.trim());
    if (argv.includes(MANAGED_DATABASE_VOLUME_INSPECT_FORMAT) || argv.includes(MANAGED_DATABASE_NETWORK_INSPECT_FORMAT)) {
      const row = JSON.parse(reply.stdout);
      if (row.owner === projectId && row.projectId === projectId && row.databaseId === databaseId) {
        originalCommandId ??= row.commandId; originalPlanDigest ??= row.planDigest;
        if (argv.includes(MANAGED_DATABASE_VOLUME_INSPECT_FORMAT)) volume ??= {name:row.name,createdAt:row.createdAt};
        else network ??= {name:row.name,id:row.id};
      }
    }
    return reply;
  }};
  const original = (): ManagedDatabaseFreshResources => {
    if (!volume || !network || !originalCommandId || !originalPlanDigest) throw new Error("Original operator storage unavailable.");
    return {projectId,databaseId,commandId:originalCommandId,planDigest:originalPlanDigest,volume,network};
  };
  const trustKey = "ci-operator-" + randomBytes(32).toString("hex"), imagePolicy = managedDatabaseNativeImagePolicy();
  const limits = {deadlineMs:60000,maxOutputBytes:131072,maxContainers:64,pollIntervalMs:100,cpus:1,memoryBytes:536870912,pidsLimit:256,stopGraceSeconds:10,...(dump?{backupMaxBytes}:{})};
  const raw = JSON.stringify({profiles,limits}), clock = {now:Date.now};
  const capabilities = new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1","database.runtime.stop.v1","database.runtime.start.v1","database.runtime.health.v1","database.runtime.metrics.v1","database.runtime.logs.v1","database.runtime.delete.v1",...(dump?["database.runtime.backup.v1" as const]:[])]);
  const shared = {runner,imagePolicy,clock,limits,owner:projectId,agentId,trustKey,capabilities};
  const inspector = createManagedDatabaseDockerInspector(shared), resources = createManagedDatabaseResourceMaterializer(shared);
  const native = createConfiguredManagedDatabaseRuntime(raw, {...shared,...(dump?{backup:{...(engine==="redis"?{volumeSource:{resolveVolume:async(name:string,abort:AbortSignal)=>{const source=await redisSource.resolveVolume(name,abort);return {...source,entries:()=>{backupCaptures++;return source.entries();}};}}}:{}),destinations:new Map([["private-native",backupRoot]]),replayStore:new DbAgentReplayStore(db.db,"operator-"+projectId),maxBytes:backupMaxBytes,runner:{runBinaryToSink:async(...args:Parameters<DockerProcessRunner["runBinaryToSink"]>)=>{backupCaptures++;captureFailure="unknown";captureExit=undefined;captureError="unknown";let prefix=Buffer.alloc(0);return new DockerProcessRunner({timeoutMs:60000,maxOutputBytes:131072,maxBinaryBytes:backupMaxBytes,spawn:(file,args,options)=>{const child=spawn(file,args,options);child.stderr?.on("data",chunk=>{
            if(engine!=="mongodb"||captureError!=="unknown"||!Buffer.isBuffer(chunk))return;
            prefix=Buffer.concat([prefix,chunk.subarray(0,4096-prefix.length)]);
            captureError=nativeCaptureErrorKind(prefix);
            if(captureError!=="unknown")prefix=Buffer.alloc(0);
          });child.once("close",(code,signal)=>{captureExit={code,signal};if(code!==0)captureFailure=code===21?"connection":(code===22||(code!==null&&code>=32&&code<=36))?"identity":code===23?"preexisting-lock":code===24?"acquisition":code===25?"acknowledgement":code===26?"dump":code===27?"cleanup":code===28?"token":code===29?"clock":code===31?"shell":"unknown";});return child;}}).runBinaryToSink(...args);}}}}:{})})!;
  const stopExecutor = native.stop ? {stop:native.stop} : undefined;
  const startExecutor = native.start ? {start:native.start} : undefined;
  if (!startExecutor) throw new Error("Explicit native start required.");
  if (!stopExecutor) throw new Error("Explicit native stop required.");
  const healthReader=native.health?{observe:native.health}:undefined;
  if(!healthReader)throw new Error("Explicit native health required.");
  const metricsReader=native.metrics?{observe:native.metrics}:undefined;
  if(!metricsReader)throw new Error("Explicit native metrics required.");
  const logsReader = native.logs ? {observe: native.logs} : undefined;
  if (!logsReader) throw new Error("Explicit native logs required.");
  let peer: Awaited<ReturnType<typeof startAgentServer>> | undefined, app: FastifyInstance | undefined;
  let deleteEffects=0;
  let stopDispatches = 0, startDispatches = 0, healthDispatches = 0, metricsDispatches = 0, logsDispatches = 0, lostStop = false, lostStart = false, result: Record<string,unknown> | undefined;
  async function startPeer(enabled:boolean) {
    const replayStore = new DbAgentReplayStore(db.db, "operator-" + projectId);
    const receiver = new AuthenticatedAgentCommandReceiver({agentId,trustKey,replayStore,capabilities:enabled ? capabilities.list() : [],
      managedDatabaseBackup:enabled&&native.backup?{execute:native.backup}:undefined,
      managedDatabaseDelete:enabled&&native.delete?{delete:async(...args)=>{deleteEffects++;return native.delete!(...args);}}:undefined,managedDatabaseRuntime:enabled ? native : undefined, managedDatabaseStop:enabled ? stopExecutor : undefined, managedDatabaseStart:enabled ? startExecutor : undefined, managedDatabaseHealth:enabled?healthReader:undefined, managedDatabaseMetrics:enabled?metricsReader:undefined, managedDatabaseLogs:enabled?logsReader:undefined,
      dispatcher:{dispatch:async () => {throw new Error("Unexpected deployment.");}},authorityValidator:new DbControlCommandRepository(db.db)});
    peer = await startAgentServer({host:"127.0.0.1",port:0,production:false,receiver,replayStore});
    const address = peer.server.address(); if (!address || typeof address === "string") throw new Error("Owned peer address required.");
    return "http://127.0.0.1:" + address.port;
  }
  const build = (endpoint:string, key?:string,deleteOverride?:ReadonlyMap<string,ManagedDatabaseDeleteApplyAccess>,restoreOverride?:ReadonlyMap<string,ManagedDatabaseRestorePreparationAccess>) => buildApiApp({
    ...(dump?{composeVolumeBackupPlans:new Map([[projectId,{profiles:new Map([["private-native",{owner:"deploylite" as const,projectId,agentId,profileId:"private-native",destinationId:"private-native",maxBytes:backupMaxBytes,maxEntries:100,maxDurationMs:60000,planTtlMs:60000}]]),store:{available:()=>true,save:async()=>{throw new Error("Compose planning is outside this fixture.");}}}]])}:{}),
    ...((deleteOverride||restoreOverride)?{managedDatabaseRestorePreparations:restoreOverride,managedDatabaseDeleteExecutions:deleteOverride,managedDatabaseCredentials:{profiles:new Map(engines.map(engine=>[engine,profiles[engine]!])),projectIds:new Set([projectId]),deadlineMs:60000},imagePolicy}:{}),db:{pool:db.pool,client:db.db},authConfig:{cookieName:"dl_operator_session",cookieSecure:false,sessionTtlSeconds:3600},
    env:{...process.env,NODE_ENV:"test",DATABASE_URL:"postgres://deploylite:deploylite-ci-only@127.0.0.1:" + scope.postgresPort + "/" + db.databaseName,DEPLOYLITE_BCRYPT_COST:"10",DEPLOYLITE_SECRET_KEY:key,DEPLOYLITE_AGENT_URL:endpoint,
      DEPLOYLITE_AGENT_ID:agentId,DEPLOYLITE_AGENT_TRUST_KEY:trustKey,DEPLOYLITE_MANAGED_DATABASE_RUNTIME:(deleteOverride||restoreOverride)?undefined:raw,
      DEPLOYLITE_MANAGED_DATABASE_PROJECT_AGENTS_JSON:(deleteOverride||restoreOverride)?undefined:JSON.stringify([{projectId,agentId}])}});
  try {
    await dump?.open();
    await runner.run(["docker","pull",profile.image],signal);
    await new DbProjectRepository(db.db).save({id:projectId,name:"Operator fixture",repoUrl:"https://example.test/repo",defaultBranch:"main",buildCommand:null,runCommand:null,port:null,description:null,imageTag:null});
    let endpoint = await startPeer(true);
    vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?:RequestInit) => {
      if (!String(url).startsWith(endpoint + "/")) throw new Error("Unscoped fixture HTTP request.");
      if(legacyPhase&&String(url)===endpoint+MANAGED_DATABASE_HEALTH_PATH)healthDispatches++;
      if(String(url)===endpoint+MANAGED_DATABASE_METRICS_PATH)metricsDispatches++;
      if (String(url) === endpoint + MANAGED_DATABASE_LOGS_PATH) logsDispatches++;
      const stop = String(url) === endpoint + MANAGED_DATABASE_STOP_PATH;
      if (stop) stopDispatches++;
      const start = String(url) === endpoint + MANAGED_DATABASE_START_PATH; if (start) startDispatches++;
      const response = await actualFetch(url, init);
      if (stop && engine === "redis" && !lostStop && response.ok) {
        await response.arrayBuffer(); lostStop = true; throw new Error("Lost fixture reply after real durable stop.");
      }
      if (start && engine === "mongodb" && !lostStart && response.ok) {
        await response.arrayBuffer(); lostStart = true; throw new Error("Lost fixture reply after real durable start.");
      }
      return response;
    });
    app = await build(endpoint,"managed_database_fixture_key_1234567890");
    const adminPassword = "test_fixture_admin_password";
    if ((await app.inject({method:"GET",url:"/api/v1/bootstrap/status"})).json().data.setupRequired)
      expect((await app.inject({method:"POST",url:"/api/v1/bootstrap/initial-admin",payload:{email:"admin@example.test",password:adminPassword}})).statusCode).toBe(200);
    const login = await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{email:"admin@example.test",password:adminPassword}});
    expect(login.statusCode).toBe(200); const cookie = login.headers["set-cookie"] as string, actorId = login.json().data.user.id;
    const call = (operation:string,payload:unknown) => app!.inject({method:"POST",url:`/api/v1/projects/${projectId}/databases/${databaseId}/${operation}`,
      headers:{cookie,"idempotency-key":operation === "runtime/stop" ? "native-stop-" + engine : operation === "runtime/start" ? "native-start-" + engine : operation === "runtime/backup" ? "native-backup-"+engine : "native-" + engine},payload:payload as Record<string,unknown>});
    expect((await call("credentials",{schemaVersion:1,engine})).statusCode).toBe(403);
    await db.pool.query("INSERT INTO control_grants(actor_user_id,action,scope_kind,scope_key) VALUES($1,'project.update','project',$2)",[actorId,projectId]);
    expect((await call("credentials",{schemaVersion:1,engine})).statusCode).toBe(200);
    const preview = await call("runtime/preview",{schemaVersion:1,engine}); expect(preview.statusCode).toBe(200);
    const {projectId:_project,databaseId:_database,...preparation} = preview.json().data.preparation;
    const connection = preview.json().data.connection;
    legacyPhase=false;
    browserFixture=await openDatabaseBrowser({sourceCommit:scope.commit,projectId,databaseId,engine,cookie,app:()=>app!});
    const apply=await browserFixture.create(); legacyPhase=true; expect(apply.statusCode).toBe(200);
    expect(apply.json().data.command.status).toBe("completed");
    const receipt = managedDatabaseRuntimeReceiptSchema.parse(apply.json().data.receipt);
    expect(receipt.status).toBe("ready"); if (!receipt.containerId || !receipt.imageId) throw new Error("Original daemon identity required.");
    const originalContainerId=receipt.containerId;
    pinned = original(); expect(receipt).toMatchObject({commandId:pinned.commandId,planDigest:pinned.planDigest,networkId:pinned.network.id,volumeCreatedAt:pinned.volume.createdAt});
    const input = {request:{schemaVersion:1,projectId,databaseId,engine},profile,commandId:receipt.commandId,imageId:receipt.imageId,containerId:receipt.containerId,environmentFingerprint:receipt.environmentFingerprint};
    const verifier = createManagedDatabaseReadinessVerifier({...shared,nativeInspector:inspector,resourceVerifier:resources,
      composeInspector:createDockerComposeResourceInspector(shared),processIdentityReader:createManagedDatabaseProcessIdentityReader(shared)});
    const authority = {assertValid:async () => {if (signal.aborted) throw new Error("Fixture deadline expired.");}};
    const ready = await verifier.verify(input,pinned,authority,signal); expect(ready.uid).toBeGreaterThan(0);
    await runner.run(["docker","exec",receipt.containerId,"sh","-ec",probe(engine,true)],signal);
    for (const hostname of ["127.0.0.1",connection.hostname]) expect((await runner.run(["docker","exec",receipt.containerId,"sh","-ec",probe(engine,false,hostname)],signal)).stdout.trim()).toBe(marker);
    const archiveVerifier=createPrivateNativeRestoreArchive({destinations:new Map([["private-native",backupRoot]]),expectedAgentId:agentId,clock:{now:Date.now},maxBytes:backupMaxBytes,maxDurationMs:5000});
    const verifyArchive=(backupReceipt:unknown)=>archiveVerifier.verify({schemaVersion:1,projectId,databaseId,...preparation,originalReceipt:receipt,originalReplayFingerprint:apply.json().data.originalReplayFingerprint,backupReceipt,maxBytes:backupMaxBytes},signal);
    const sqlDump=engine==="mysql"||engine==="mariadb";
    if(sqlDump)await runner.run(["docker","exec",receipt.containerId,"sh","-ec",probe(engine,true,"127.0.0.1","CREATE TABLE p5_nontransactional(value varchar(64)) ENGINE=MyISAM; INSERT INTO p5_nontransactional VALUES ('p5-nontransactional-value');")],signal);
    if(dump&&engine!=="redis")nativeBackup=await dump.prove({captureFailure:()=>captureFailure,captureExit:()=>captureExit??{code:null,signal:null},captureError:()=>captureError,
      call:()=>call("runtime/backup",{...preparation,originalReceipt:receipt,originalReplayFingerprint:apply.json().data.originalReplayFingerprint,destinationId:"private-native",maxBytes:backupMaxBytes}),
      reopen:async()=>{await app!.close();app=undefined;await peer!.close();peer=undefined;await db.reopen();endpoint=await startPeer(true);app=await build(endpoint,"managed_database_fixture_key_1234567890");},
      verifyArchive,inventory:()=>new DbBackupInventoryStore(db.db,agentId),verify:()=>verifier.verify(input,pinned!,authority,signal),decode:bytes=>engine==="mongodb"?restoreNativeMongoFixture({bytes,containerId:originalContainerId,uid:ready.uid,signal}):(engine==="mysql"||engine==="mariadb")?restoreNativeSqlFixture({engine,bytes,containerId:originalContainerId,uid:ready.uid,signal}):decodeNativePostgresFixture({bytes,containerId:originalContainerId,uid:ready.uid,signal}),signal,captures:()=>backupCaptures,maxBytes:backupMaxBytes,originalContainerId:receipt.containerId,uid:ready.uid,
      ...((sqlDump||engine==="mongodb")?{writerProbe:async()=>{const resumed=AbortSignal.timeout(5000);await runner.run(["docker","exec",originalContainerId,"sh","-ec",probe(engine,true)],resumed);expect((await runner.run(["docker","exec",originalContainerId,"sh","-ec",probe(engine,false)],resumed)).stdout.trim()).toBe(marker);}}:{})
    });
    const originals = async () => ({commands:(await db.pool.query("SELECT * FROM control_commands WHERE id=$1",[receipt.commandId])).rows,
      cache:(await db.pool.query("SELECT * FROM agent_replay WHERE command_id=$1",[receipt.commandId])).rows});
    const encrypted = async () => (await db.pool.query("SELECT id,encrypted_value,value_fingerprint FROM env_secret_values WHERE project_id=$1 ORDER BY id",[projectId])).rows;
    const originalRows = await originals(), cipherRows = await encrypted(); expect(cipherRows).toHaveLength(1);
    const fixtureCipher = createEnvSecretCipher(loadEnvSecretKey("managed_database_fixture_key_1234567890"));
    const privateBundle = JSON.parse(fixtureCipher.decrypt(Buffer.from(cipherRows[0].encrypted_value).toString("base64"))) as {credentials: Record<string, string>};
    const originalReplayFingerprint: string = apply.json().data.originalReplayFingerprint;
    expect(originalReplayFingerprint).toBe(createHash("sha256").update(originalRows.cache[0].fingerprint).digest("hex"));
    expect(apply.json().data.command).not.toHaveProperty("projectExecutionAuthority");
    let stopInput = {...preparation,originalReceipt:receipt,originalReplayFingerprint};
    const ledgerSnapshot=async()=>({commands:(await db.pool.query("SELECT * FROM control_commands WHERE scope_kind='project' AND scope_key=$1 ORDER BY id",[projectId])).rows,
      cache:(await db.pool.query("SELECT replay.* FROM agent_replay replay JOIN control_commands command ON command.id::text=replay.command_id WHERE command.scope_kind='project' AND command.scope_key=$1 ORDER BY replay.command_id",[projectId])).rows,
      audit:(await db.pool.query("SELECT * FROM audit_events WHERE target_id=$1 ORDER BY id",[projectId])).rows,cipher:await encrypted()});
    async function currentHealth(state:"running"|"stopped"){
      const beforeRows=await ledgerSnapshot(),before=Date.now(),response=await call("runtime/health",stopInput),after=Date.now();expect(response.statusCode).toBe(200);
      const observation=managedDatabaseHealthObservationSchema.parse(response.json().data.observation);
      expect(observation).toMatchObject({originalCommandId:receipt.commandId,projectId,databaseId,engine,profileId:profile.profileId,containerId:receipt.containerId,imageId:receipt.imageId,networkId:receipt.networkId,volumeCreatedAt:receipt.volumeCreatedAt,state,health:state==="running"?"healthy":"not-running",uid:state==="running"?ready.uid:null});
      expect(observation.observedAt).toBeGreaterThanOrEqual(before);expect(observation.observedAt).toBeLessThanOrEqual(after);
      expect(await ledgerSnapshot()).toEqual(beforeRows);return {observation,before,after};
    }
    async function currentMetrics(state:"running"|"stopped"){
      const beforeRows=await ledgerSnapshot(),statsBefore=statsDispatches,before=Date.now(),response=await call("runtime/metrics",stopInput),after=Date.now();expect(response.statusCode).toBe(200);
      const observation=managedDatabaseMetricsObservationSchema.parse(response.json().data.observation);
      expect(observation).toMatchObject({originalCommandId:receipt.commandId,projectId,databaseId,engine,profileId:profile.profileId,containerId:receipt.containerId,imageId:receipt.imageId,networkId:receipt.networkId,volumeCreatedAt:receipt.volumeCreatedAt,state,health:state==="running"?"healthy":"not-running",uid:state==="running"?ready.uid:null});
      expect(observation.observedAt).toBeGreaterThanOrEqual(before);expect(observation.observedAt).toBeLessThanOrEqual(after);
      if(state==="running"){
        expect(observation.metricsObservedAt).toBeGreaterThanOrEqual(before);expect(observation.metricsObservedAt).toBeLessThanOrEqual(observation.observedAt);
        expect(observation.metrics!.pids).toBeGreaterThan(0);expect(statsDispatches-statsBefore).toBe(1);
      }else{expect(observation.metrics).toBeNull();expect(observation.metricsObservedAt).toBeNull();expect(statsDispatches).toBe(statsBefore);}
      expect(await ledgerSnapshot()).toEqual(beforeRows);return {observation,before,after};
    }
    async function currentLogs(state: "running" | "stopped", since?: string) {
      const selection = {tail: 100, ...(since === undefined ? {} : {since})};
      const beforeRows = await ledgerSnapshot(), readsBefore = logReads, before = Date.now();
      const response = await app!.inject({method: "POST", url: `/api/v1/projects/${projectId}/databases/${databaseId}/runtime/logs`, headers: {cookie}, payload: {...stopInput, selection}});
      const after = Date.now(); expect(response.statusCode).toBe(200);
      const observation = managedDatabaseLogsObservationSchema.parse(response.json().data.observation);
      expect(observation).toMatchObject({originalCommandId: receipt.commandId, projectId, databaseId, engine, profileId: profile.profileId, containerId: receipt.containerId,
        imageId: receipt.imageId, networkId: receipt.networkId, volumeCreatedAt: receipt.volumeCreatedAt, state, health: state === "running" ? "healthy" : "not-running", uid: state === "running" ? ready.uid : null});
      expect(observation.observedAt).toBeGreaterThanOrEqual(before); expect(observation.observedAt).toBeLessThanOrEqual(after);
      expect(observation.logsObservedAt).toBeGreaterThanOrEqual(before); expect(observation.logsObservedAt).toBeLessThanOrEqual(observation.observedAt);
      expect(logReads - readsBefore).toBe(1);
      expect(logRequests.at(-1)).toEqual(["docker", "logs", "--timestamps", "--tail", "100", ...(since === undefined ? [] : ["--since", since]), receipt.containerId]);
      const text = observation.logs.stdout + observation.logs.stderr; expect(text.length).toBeGreaterThan(0);
      expect(redactLogMessage(observation.logs.stdout)).toBe(observation.logs.stdout); expect(redactLogMessage(observation.logs.stderr)).toBe(observation.logs.stderr);
      expect(Object.values(privateBundle.credentials).every(secret => !text.includes(secret))).toBe(true);
      expect(await ledgerSnapshot()).toEqual(beforeRows); return {observation, before, after, selection};
    }
    async function recoveredInventory(stopReceipt: ReturnType<typeof managedDatabaseStopReceiptSchema.parse> | null, stopFingerprint?: string) {
      const beforeRows = await ledgerSnapshot(), before = Date.now();
      const response = await app!.inject({method:"GET",url:`/api/v1/projects/${projectId}/databases`,headers:{cookie}});
      const after = Date.now(); expect(response.statusCode).toBe(200);
      const body = response.json(); expect(body.data.databases).toHaveLength(1);
      const entry = body.data.databases[0];
      const fullBase = {...preparation,projectId,databaseId};
      const expectedSource = {...fullBase,originalReceipt:receipt,originalReplayFingerprint};
      expect(entry).toEqual({preparation:fullBase,connection,source:expectedSource,
        startPreparation:stopReceipt ? {...expectedSource,originalStopReceipt:stopReceipt,originalStopReplayFingerprint:stopFingerprint} : null});
      const afterRows = await ledgerSnapshot();
      expect(afterRows.commands).toEqual(beforeRows.commands); expect(afterRows.cache).toEqual(beforeRows.cache); expect(afterRows.cipher).toEqual(beforeRows.cipher);
      const previousIds = new Set(beforeRows.audit.map(row => row.id));
      const added = afterRows.audit.filter(row => !previousIds.has(row.id)); expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({actor_user_id:actorId,action:"database.inventory.read",target_id:projectId,
        request_id:body.requestId,metadata:{databaseCount:1,redacted:true}});
      expect(Object.entries(privateBundle.credentials).filter(([key]) => key.includes("PASSWORD")).every(([,secret]) => !JSON.stringify(body).includes(secret))).toBe(true);
      return {entry,before,after,requestId:body.requestId,correlationId:added[0].correlation_id};
    }
    const inventoryBeforeStop = await recoveredInventory(null);
    const {projectId:_recoveredProject,databaseId:_recoveredDatabase,...recoveredStop} = inventoryBeforeStop.entry.source;
    stopInput = recoveredStop;
    const runningBeforeStop=await currentHealth("running");
    const runningMetricsBeforeStop=await currentMetrics("running");
    const runningLogsBeforeStop = await currentLogs("running");
    const stop = await call("runtime/stop",stopInput); expect(stop.statusCode).toBe(200);
    expect(stop.json().data.command.status).toBe("completed");
    const stopped = managedDatabaseStopReceiptSchema.parse(stop.json().data.receipt);
    expect(stopped).toMatchObject({status:"stopped",originalCommandId:receipt.commandId,containerId:receipt.containerId});
    expect((await inspector.inspectContainer(receipt.containerId,signal)).running).toBe(false);
    if(engine==="redis"){
      await verifier.verifyStopped(input,pinned,authority,signal);await mkdir(redisSourceRoot,{mode:0o700});redisSourceInfo=await lstat(redisSourceRoot);
      await runner.run(["docker","container","cp",receipt.containerId+":/data/.",redisSourceRoot],signal);await verifier.verifyStopped(input,pinned,authority,signal);redisRoots.set(receipt.volumeName,redisSourceRoot);
      redisBackupResponse=await call("runtime/backup",{...preparation,originalReceipt:receipt,originalReplayFingerprint,destinationId:"private-native",maxBytes:backupMaxBytes});expect(redisBackupResponse.statusCode).toBe(200);
      await verifier.verifyStopped(input,pinned,authority,signal);
    }
    const stoppedHealth=await currentHealth("stopped");
    const stoppedMetrics=await currentMetrics("stopped");
    const stoppedLogs = await currentLogs("stopped", new Date(Math.max(0, receipt.observedAt - 60000)).toISOString());
    await resources.verifyFresh({request:input.request,profile,commandId:receipt.commandId},pinned,authority,signal);
    expect(await originals()).toEqual(originalRows); expect(await encrypted()).toEqual(cipherRows);
    const audits = (await db.pool.query("SELECT metadata,correlation_id FROM audit_events WHERE target_id=$1 AND action='database.runtime.stopped'",[projectId])).rows;
    expect(audits).toHaveLength(1); expect(audits[0].metadata.receipt).toEqual({...stopped,containerId:"[REDACTED]",imageId:"sha256:[REDACTED]",
      networkId:"[REDACTED]",networkName:"dl-[REDACTED]-net-db-orders",volumeName:"dl-[REDACTED]-vol-db-orders"}); expect(audits[0].correlation_id).toBe(stopped.correlationId);
    const stopReplayRows = (await db.pool.query("SELECT * FROM agent_replay WHERE command_id=$1",[stopped.commandId])).rows;
    expect(stopReplayRows).toHaveLength(1);
    const originalStopReplayFingerprint: string = stop.json().data.originalStopReplayFingerprint;
    expect(originalStopReplayFingerprint).toBe(createHash("sha256").update(stopReplayRows[0].fingerprint).digest("hex"));
    expect(stop.json().data.command).not.toHaveProperty("projectExecutionAuthority");
    await app.close(); app = undefined; await peer!.close(); peer = undefined;
    await db.reopen(); endpoint = await startPeer(true); app = await build(endpoint,"managed_database_fixture_key_1234567890");
    const inventoryStopped = await recoveredInventory(stopped,originalStopReplayFingerprint);
    const {projectId:_startProject,databaseId:_startDatabase,...startInput} = inventoryStopped.entry.startPreparation;

    const start = await call("runtime/start",startInput); expect(start.statusCode).toBe(200);
    expect(start.json().data.command.status).toBe("completed");
    const started = managedDatabaseStartReceiptSchema.parse(start.json().data.receipt);
    expect(started).toMatchObject({status:"ready",health:"passed",originalCommandId:receipt.commandId,originalStopCommandId:stopped.commandId,containerId:receipt.containerId});
    expect((await inspector.inspectContainer(receipt.containerId,signal)).running).toBe(true);
    const startAudits = (await db.pool.query("SELECT metadata,correlation_id FROM audit_events WHERE target_id=$1 AND action='database.runtime.started'",[projectId])).rows;
    expect(startAudits).toHaveLength(1); expect(startAudits[0].correlation_id).toBe(started.correlationId);
    expect(startAudits[0].metadata.receipt).toEqual({...started,containerId:"[REDACTED]",imageId:"sha256:[REDACTED]",
      networkId:"[REDACTED]",networkName:"dl-[REDACTED]-net-db-orders",volumeName:"dl-[REDACTED]-vol-db-orders"});
    expect((await db.pool.query("SELECT * FROM agent_replay WHERE command_id=$1",[stopped.commandId])).rows).toEqual(stopReplayRows);
    expect(await verifier.verify(input,pinned,authority,signal)).toEqual(ready);
    for (const hostname of ["127.0.0.1",connection.hostname]) expect((await runner.run(["docker","exec",receipt.containerId,"sh","-ec",probe(engine,false,hostname)],signal)).stdout.trim()).toBe(marker);
    if(engine==="redis"&&dump){
      let first=true;const backupInput={...preparation,originalReceipt:receipt,originalReplayFingerprint,destinationId:"private-native",maxBytes:backupMaxBytes};
      nativeBackup=await dump.prove({call:async()=>{if(first){first=false;return redisBackupResponse!;}return call("runtime/backup",backupInput);},
        reopen:async()=>{await app!.close();app=undefined;await peer!.close();peer=undefined;await db.reopen();endpoint=await startPeer(true);app=await build(endpoint,"managed_database_fixture_key_1234567890");},
        verifyArchive,inventory:()=>new DbBackupInventoryStore(db.db,agentId),verify:()=>verifier.verify(input,pinned!,authority,signal),decode:bytes=>restoreNativeRedisFixture({bytes,containerId:originalContainerId,uid:ready.uid,signal}),
        signal,captures:()=>backupCaptures,maxBytes:backupMaxBytes,originalContainerId,uid:ready.uid,stoppedSource:true});
    }
    if (!nativeBackup) throw new Error("Original native backup proof required.");
    const restoreBackup=managedDatabaseBackupReceiptSchema.parse(nativeBackup.receipt);
    const restoreSelection={...preparation,projectId,databaseId,originalReceipt:receipt,originalReplayFingerprint,
      archiveId:restoreBackup.archiveId,destinationId:restoreBackup.destinationId,expectedArchiveSha256:restoreBackup.archiveSha256,
      expectedManifestSha256:restoreBackup.manifestSha256,maxBytes:backupMaxBytes};
    const commandsBeforeRestoreIntent=(await db.pool.query("SELECT id,status,input_digest FROM control_commands ORDER BY id")).rows;
    const restoreIntent=await prepareVerifiedManagedDatabaseRestoreConfirmation({selection:restoreSelection,actorId,
      idempotencyKey:"fixture_restore_intent_"+engine,correlationId:"fixture-restore-intent-"+engine,commandTtlMs:10000},
      {expectedAgentId:agentId,inventory:new DbBackupInventoryStore(db.db,agentId),archive:archiveVerifier,clock:{now:Date.now},maxDurationMs:5000},signal);
    expect(restoreIntent.command).toMatchObject({actorId,status:"pending_confirmation",action:"project.update",scope:{kind:"project",projectId},inputDigest:managedDatabaseRestoreExecutionDigest(restoreIntent.preparation)});
    expect(restoreIntent.preparation.backupReceipt).toEqual(restoreBackup);
    expect(evaluateConfirmation(restoreIntent.command,restoreIntent.confirmation)).toEqual({eligible:true});
    expect(restoreIntent.confirmation.consumedAt).toBeNull();expect(restoreIntent.command).not.toHaveProperty("projectExecutionAuthority");
    expect((await db.pool.query("SELECT id,status,input_digest FROM control_commands ORDER BY id")).rows).toEqual(commandsBeforeRestoreIntent);
    nativeBackup.restorePreparation="passed";
    const pendingRestoreInput={selection:restoreSelection,actorId,idempotencyKey:"fixture_restore_pending_"+engine,
      context:{requestId:randomUUID(),correlationId:"fixture-restore-pending-"+engine},signal,current:()=>!signal.aborted,
      authorize:async()=>(await db.pool.query("SELECT id FROM control_grants WHERE actor_user_id=$1 AND action='project.update' AND scope_kind='project' AND scope_key=$2",[actorId,projectId])).rows.length===1,
      admit:async()=>{const plan=planManagedDatabaseProfile({schemaVersion:1,projectId,databaseId,engine},profile,imagePolicy);expect(plan.planDigest).toBe(receipt.planDigest);}};
    const restoreAccess=()=>({controls:new DbControlCommandRepository(db.db),inventory:new DbBackupInventoryStore(db.db,agentId),archive:archiveVerifier,
      originalTransport:new AuthenticatedManagedDatabaseRuntimeTransport({endpoint,agentId,trustKey,timeoutMs:5000,allowInsecureInternal:true}),agentId,deadlineMs:5000,now:Date.now,commandTtlMs:10000});
    const pendingRestore=await prepareManagedDatabaseRestore(restoreAccess(),pendingRestoreInput);
    expect(pendingRestore.idempotent).toBe(false);expect(pendingRestore.confirmation.consumedAt).toBeNull();expect(pendingRestore.command).not.toHaveProperty("projectExecutionAuthority");
    const restorePrepareCall=()=>app!.inject({method:"POST",url:`/api/v1/projects/${projectId}/databases/${databaseId}/runtime/restore/prepare`,headers:{cookie,"idempotency-key":pendingRestoreInput.idempotencyKey},
      payload:(({projectId:_project,databaseId:_database,...body})=>body)(restoreSelection)});
    await app!.close();app=undefined;app=await build(endpoint,"managed_database_fixture_key_1234567890",undefined,new Map([[projectId,restoreAccess()]]));
    const originalApiPending=await restorePrepareCall();expect(originalApiPending.statusCode).toBe(200);const pendingApi=originalApiPending.json().data;
    expect(pendingApi).toMatchObject({idempotent:true,command:{id:pendingRestore.command.id,status:"pending_confirmation"},confirmation:{id:pendingRestore.confirmation.id,classification:"destructive",consumedAt:null}});
    expect(Object.keys(pendingApi).sort()).toEqual(["command","confirmation","idempotent"]);expect(pendingApi.command).not.toHaveProperty("projectExecutionAuthority");
    await app!.close();app=undefined;await peer!.close();peer=undefined;await db.reopen();endpoint=await startPeer(true);app=await build(endpoint,"managed_database_fixture_key_1234567890",undefined,new Map([[projectId,restoreAccess()]]));
    const reopenedApiPending=await restorePrepareCall();expect(reopenedApiPending.statusCode).toBe(200);expect(reopenedApiPending.json().data).toEqual(pendingApi);
    const samePendingRestore=await prepareManagedDatabaseRestore(restoreAccess(),{...pendingRestoreInput,context:{requestId:randomUUID(),correlationId:randomUUID()}});
    expect(samePendingRestore.command).toEqual(pendingRestore.command);expect(samePendingRestore.confirmation).toEqual(pendingRestore.confirmation);expect(samePendingRestore.preparation).toEqual(pendingRestore.preparation);expect(samePendingRestore.idempotent).toBe(true);
    expect((await db.pool.query("SELECT consumed_at FROM control_command_confirmations WHERE command_id=$1",[pendingRestore.command.id])).rows).toEqual([{consumed_at:null}]);
    expect(await verifier.verify(input,pinned,authority,signal)).toEqual(ready);
    const pendingCommand=pendingRestore.command;
    nativeBackup.pendingRestore={commandId:pendingCommand.id,confirmationId:pendingRestore.confirmation.id,actorId,projectId,databaseId,engine,
      inputDigest:pendingCommand.inputDigest,idempotencyKey:pendingCommand.idempotencyKey,correlationId:pendingCommand.correlationId,expiresAt:pendingCommand.expiresAt.getTime(),
      status:"pending_confirmation",classification:"destructive",consumedAt:null,reopen:"passed",sameOriginalKey:"passed",sameOriginalNonce:"passed",dispatches:0,authenticatedApi:"passed"};
    await app!.close();app=undefined;app=await build(endpoint,"managed_database_fixture_key_1234567890");

    const inventoryAfterStart = await recoveredInventory(stopped,originalStopReplayFingerprint);
    const runningAfterStart=await currentHealth("running");expect(healthDispatches).toBe(3);
    const runningMetricsAfterStart=await currentMetrics("running");expect(metricsDispatches).toBe(3);expect(statsDispatches).toBe(2);
    const runningLogsAfterStart = await currentLogs("running", new Date(Math.max(0, receipt.observedAt - 60000)).toISOString());
    expect(logsDispatches).toBe(3); expect(logReads).toBe(3);
    await app.close(); app = undefined; await peer!.close(); peer = undefined;
    await db.reopen(); endpoint = await startPeer(false); app = await build(endpoint);
    const removedHealth=await call("runtime/health",stopInput);expect(removedHealth.statusCode).toBe(503);expect(healthDispatches).toBe(3);
    const removedMetrics=await call("runtime/metrics",stopInput);expect(removedMetrics.statusCode).toBe(503);expect(metricsDispatches).toBe(3);expect(statsDispatches).toBe(2);
    const removedLogs = await call("runtime/logs", {...stopInput, selection: {tail: 100}}); expect(removedLogs.statusCode).toBe(503); expect(logsDispatches).toBe(3); expect(logReads).toBe(3);
    const replay = await call("runtime/stop",stopInput); expect(replay.statusCode).toBe(200);
    expect(replay.json().data.idempotent).toBe(true); expect(replay.json().data.receipt).toEqual(stopped);
    expect((await inspector.inspectContainer(receipt.containerId,signal)).running).toBe(true); expect(stopDispatches).toBe(1);
    const startReplay = await call("runtime/start",startInput); expect(startReplay.statusCode).toBe(200);
    expect(startReplay.json().data.idempotent).toBe(true); expect(startReplay.json().data.receipt).toEqual(started); expect(startDispatches).toBe(1);
    if (engine === "redis") expect(lostStop).toBe(true); if (engine === "mongodb") expect(lostStart).toBe(true);
    await runner.run(["docker","stop","--timeout","10",receipt.containerId],signal);
    expect((await inspector.inspectContainer(receipt.containerId,signal)).running).toBe(false);
    const stoppedStartReplay = await call("runtime/start",startInput); expect(stoppedStartReplay.statusCode).toBe(200);
    expect(stoppedStartReplay.json().data.receipt).toEqual(started); expect(startDispatches).toBe(1);
    expect((await inspector.inspectContainer(receipt.containerId,signal)).running).toBe(false);
    expect((await db.pool.query("SELECT * FROM agent_replay WHERE command_id=$1",[stopped.commandId])).rows).toEqual(stopReplayRows);
    expect(await originals()).toEqual(originalRows); expect(await encrypted()).toEqual(cipherRows);
    const command = (value:typeof apply) => ({id:value.json().data.command.id,correlationId:value.json().data.command.correlationId,status:value.json().data.command.status});
    result = {...(nativeBackup?{nativeBackup}:{}),inventoryRecovery:{views:{runningBeforeStop:inventoryBeforeStop,stopped:inventoryStopped,runningAfterStart:inventoryAfterStart},restart:"passed",sourcesUsed:"passed",commands:"unchanged",cache:"unchanged",cipher:"unchanged",audit:"passed"},currentLogs: {runningBeforeStop: runningLogsBeforeStop, stopped: stoppedLogs, runningAfterStart: runningLogsAfterStart}, currentMetrics:{runningBeforeStop:runningMetricsBeforeStop,stopped:stoppedMetrics,runningAfterStart:runningMetricsAfterStart},currentHealth:{runningBeforeStop,stopped:stoppedHealth,runningAfterStart},receipt,uid:ready.uid,original:pinned,nativeStop:{receipt:stopped,originalReplayFingerprint},nativeStart:{receipt:started,originalStopReplayFingerprint},internalConnection:{details:connection,authenticatedRead:"passed",afterRestart:"passed"},
      authenticatedProbe:"passed",restart:"passed",persistence:"passed",operator:{publicOriginalSelectors:"passed",logsDispatches,logReads,logsSignedHttp:"passed",logsNoLedgerWrites:"passed",logsExecutorRemoved:"passed",metricsDispatches,statsDispatches,metricsSignedHttp:"passed",metricsNoLedgerWrites:"passed",metricsExecutorRemoved:"passed",healthDispatches,healthSignedHttp:"passed",healthNoLedgerWrites:"passed",healthExecutorRemoved:"passed",applyCommand:command(apply),stopCommand:command(stop),startCommand:command(start),startDispatches,startAtomicAudit:"passed",startCacheOnlyReplay:"passed",startExecutorRemoved:"passed",stoppedCacheNoRestart:"passed",signedHttp:"passed",postgresReplay:"passed",
        originalRows:"unchanged",cipherRows:"unchanged",atomicAudit:"passed",stopDispatches,cacheOnlyReplay:"passed",executorRemoved:"passed"}};
    legacyPhase=false;
    await app.close(); app=undefined; await peer!.close();peer=undefined;
    endpoint=await startPeer(true);app=await build(endpoint,"managed_database_fixture_key_1234567890");
    const browserAcceptance=await browserFixture.cycle(async()=>{
      expect((await runner.run(["docker","exec",receipt.containerId!,"sh","-ec",probe(engine,false)],signal)).stdout).toContain("p5-persistent-value");
      await resources.verifyFresh({request:input.request,profile,commandId:receipt.commandId},pinned!,authority,signal);
      expect(await encrypted()).toEqual(cipherRows);
    });
    result!.browserAcceptance=browserAcceptance;
    // Same owned PostgreSQL session; no deletion, confirmation consumption or lease effect.
    const confirmations=new DbControlCommandRepository(db.db),now=new Date();
    const candidate=createControlCommand({actorId,action:"project.update",scope:{kind:"project",projectId},
      input:{operation:"ci.project-update-confirmation",engine},idempotencyKey:randomUUID(),correlationId:randomUUID(),expiresAt:new Date(now.getTime()+60000)});
    const pending=(await confirmations.resolve(candidate)).command;
    const [first,parallel]=await Promise.all([confirmations.resolveProjectUpdateConfirmation(pending,now),confirmations.resolveProjectUpdateConfirmation(pending,now)]);
    expect(first).not.toBeNull();expect(parallel).toEqual(first);
    expect(first).toMatchObject({commandId:pending.id,actorId,scope:pending.scope,inputDigest:pending.inputDigest,classification:"destructive",expiresAt:pending.expiresAt,consumedAt:null});
    for(const patch of [{actorId:randomUUID()},{inputDigest:"0".repeat(64)},{scope:{kind:"project" as const,projectId:randomUUID()}},{status:"eligible" as const}])
      expect(await confirmations.resolveProjectUpdateConfirmation({...pending,...patch},now)).toBeNull();
    const storedNonce=async()=>(await db.pool.query("SELECT * FROM control_command_confirmations WHERE command_id=$1",[pending.id])).rows;
    const nonceRows=await storedNonce();expect(nonceRows).toHaveLength(1);expect(nonceRows[0].consumed_at).toBeNull();
    const pendingRows=(await db.pool.query("SELECT * FROM control_commands WHERE id=$1",[pending.id])).rows;
    expect(pendingRows).toHaveLength(1);expect(pendingRows[0]).toMatchObject({status:"pending_confirmation",execution_authority:null});
    expect((await db.pool.query("SELECT * FROM control_command_audits WHERE command_id=$1",[pending.id])).rows).toHaveLength(0);
    await app.close();app=undefined;await peer!.close();peer=undefined;await db.reopen();
    expect(await new DbControlCommandRepository(db.db).resolveProjectUpdateConfirmation(pending,new Date())).toEqual(first);
    expect(await storedNonce()).toEqual(nonceRows);
    expect((await db.pool.query("SELECT * FROM control_commands WHERE id=$1",[pending.id])).rows).toEqual(pendingRows);
    expect(await originals()).toEqual(originalRows);expect(await encrypted()).toEqual(cipherRows);
    result!.confirmationRecovery={projectId,pending:"passed",unique:"passed",reopen:"passed",unconsumed:"passed",noAuthority:"passed",detachedRejected:"passed",originalRows:"unchanged",cipher:"unchanged"};
    const currentControls=new DbControlCommandRepository(db.db);
    const blocker=(await currentControls.resolve({...createControlCommand({actorId,action:"project.update",scope:{kind:"project",projectId},
      input:{operation:"ci.confirmation-blocker"},idempotencyKey:randomUUID(),correlationId:randomUUID(),expiresAt:pending.expiresAt}),status:"eligible"})).command;
    const occupied=await currentControls.claimProjectUpdate(blocker);expect(occupied.claimed).toBe(true);expect(occupied.authority).toBeDefined();
    expect(await currentControls.claimConfirmedProjectUpdate(pending,first!)).toMatchObject({accepted:false,claimed:false,reason:"project_busy"});
    expect(await storedNonce()).toEqual(nonceRows);
    await currentControls.completeProjectUpdate(occupied.command,occupied.authority!,{actorUserId:actorId,action:"ci.confirmation-blocker-completed",targetType:"project",targetId:projectId,requestId:randomUUID(),correlationId:occupied.command.correlationId});
    const acceptedAudits=async()=>(await db.pool.query("SELECT * FROM control_command_audits WHERE command_id=$1",[pending.id])).rows;
    await expect(new DbControlCommandRepository(db.db,()=>{throw new Error("injected confirmed claim rollback");}).claimConfirmedProjectUpdate(pending,first!)).rejects.toThrow("injected confirmed claim rollback");
    expect(await storedNonce()).toEqual(nonceRows);expect(await acceptedAudits()).toHaveLength(0);
    expect((await db.pool.query("SELECT * FROM control_commands WHERE id=$1",[pending.id])).rows).toEqual(pendingRows);
    const concurrent=await Promise.all([currentControls.claimConfirmedProjectUpdate(pending,first!),currentControls.claimConfirmedProjectUpdate(pending,first!)]);
    const winner=concurrent.filter(value=>value.claimed);expect(winner).toHaveLength(1);expect(concurrent.filter(value=>value.accepted)).toHaveLength(1);
    const acceptedRows=await acceptedAudits(),consumedRows=await storedNonce();expect(acceptedRows).toHaveLength(1);
    expect(acceptedRows[0]).toMatchObject({command_id:pending.id,confirmation_id:first!.id,correlation_id:pending.correlationId,outcome:"accepted"});
    expect(consumedRows[0].id).toBe(first!.id);expect(consumedRows[0].consumed_at).toBeInstanceOf(Date);
    expect(consumedRows[0].consumed_at.getTime()).toBeLessThan(first!.expiresAt.getTime());
    const claimedRows=(await db.pool.query("SELECT * FROM control_commands WHERE id=$1",[pending.id])).rows;
    expect(claimedRows[0]).toMatchObject({status:"dispatching",execution_authority:winner[0]!.authority});
    await db.reopen();const recoveredControls=new DbControlCommandRepository(db.db);
    expect(await recoveredControls.resolveProjectUpdateConfirmation(pending)).toBeNull();
    expect(await recoveredControls.claimConfirmedProjectUpdate(pending,first!)).toMatchObject({accepted:false,claimed:false});
    expect(await storedNonce()).toEqual(consumedRows);expect(await acceptedAudits()).toEqual(acceptedRows);
    expect((await db.pool.query("SELECT * FROM control_commands WHERE id=$1",[pending.id])).rows).toEqual(claimedRows);
    expect(await originals()).toEqual(originalRows);expect(await encrypted()).toEqual(cipherRows);
    result!.confirmedClaim={projectId,originalNonce:"passed",uniqueAuthority:"passed",projectBusy:"passed",rollback:"passed",reopen:"passed",noRenewal:"passed",audit:"passed",originalRows:"unchanged",cipher:"unchanged"};
    const confirmedAuthority=winner[0]!.authority!;
    await expect(recoveredControls.validateConfirmedProjectUpdateAuthority(confirmedAuthority,first!.id)).resolves.toBeUndefined();
    await expect(recoveredControls.validateConfirmedProjectUpdateAuthority(confirmedAuthority,randomUUID())).rejects.toThrow();
    await expect(recoveredControls.validateConfirmedProjectUpdateAuthority({...confirmedAuthority,inputDigest:"0".repeat(64)},first!.id)).rejects.toThrow();
    await expect(recoveredControls.validateConfirmedProjectUpdateAuthority(confirmedAuthority,first!.id,pending.expiresAt.getTime())).rejects.toThrow();
    expect(await storedNonce()).toEqual(consumedRows);expect(await acceptedAudits()).toEqual(acceptedRows);
    expect((await db.pool.query("SELECT * FROM control_commands WHERE id=$1",[pending.id])).rows).toEqual(claimedRows);
    expect(await originals()).toEqual(originalRows);expect(await encrypted()).toEqual(cipherRows);
    result!.confirmedAuthority={projectId,readOnly:"passed",originalNonce:"passed",acceptedAudit:"passed",detachedRejected:"passed",expiryRejected:"passed",reopen:"passed",originalRows:"unchanged",cipher:"unchanged"};
    await recoveredControls.completeProjectUpdate(winner[0]!.command,confirmedAuthority,{actorUserId:actorId,action:"ci.confirmation-proof-completed",targetType:"project",targetId:projectId,requestId:randomUUID(),correlationId:pending.correlationId});
    const removalSource={...preparation,projectId,databaseId,originalReceipt:receipt,originalReplayFingerprint},deleteDigest=managedDatabaseDeleteExecutionDigest(removalSource);
    endpoint=await startPeer(true);
    const transportOptions={endpoint,agentId,trustKey,timeoutMs:60000,allowInsecureInternal:true};
    app=await build(endpoint,"managed_database_fixture_key_1234567890");
    const browserPrepared=await browserFixture.prepareRemoval();
    const {projectId:_deleteProject,databaseId:_deleteDatabase,...deleteBody}=removalSource,deleteKey=browserPrepared.key;
    expect(browserPrepared.response!.json().data).toMatchObject({storagePolicy:"retain-original",command:{status:"pending_confirmation"},confirmation:{classification:"destructive",consumedAt:null}});
    const prepareDelete=(correlation:string)=>app!.inject({method:"POST",url:`/api/v1/projects/${projectId}/databases/${databaseId}/runtime/delete/prepare`,headers:{cookie,"idempotency-key":deleteKey,"x-correlation-id":correlation},payload:deleteBody});
    const preparedDelete=await prepareDelete(randomUUID());expect(preparedDelete.statusCode).toBe(200);const deletePublic=preparedDelete.json().data;
    expect(deletePublic).toMatchObject({storagePolicy:"retain-original",command:{status:"pending_confirmation"},confirmation:{classification:"destructive",consumedAt:null}});expect(deletePublic.command).not.toHaveProperty("projectExecutionAuthority");
    const recoveredDelete=await prepareDelete(randomUUID());expect(recoveredDelete.statusCode).toBe(200);expect(recoveredDelete.json().data.command).toEqual(deletePublic.command);expect(recoveredDelete.json().data.confirmation).toEqual(deletePublic.confirmation);
    const deletePending=(await recoveredControls.findProjectUpdateByIdempotency(actorId,projectId,deleteKey))!;expect(deletePending).not.toBeNull();
    const approval=(await recoveredControls.resolveProjectUpdateConfirmation(deletePending))!;expect(approval.id).toBe(deletePublic.confirmation.id);expect(approval.consumedAt).toBeNull();expect(deleteEffects).toBe(0);
    const deleteTransport=new AuthenticatedManagedDatabaseDeleteTransport(transportOptions),issued:{query?:ReturnType<typeof managedDatabaseDeleteReceiptQuerySchema.parse>;command?:ControlCommand}={};
    const sendDelete=(body:unknown,signature=signAgentTransport(JSON.stringify(body),trustKey))=>fetch(endpoint+MANAGED_DATABASE_DELETE_PATH,{method:"POST",headers:{"content-type":"application/json","x-deploylite-signature":signature},body:JSON.stringify(body)});
    const fencedDeleteTransport={available:()=>deleteTransport.available(),readReceipt:deleteTransport.readReceipt.bind(deleteTransport),dispatch:async(...args:Parameters<typeof deleteTransport.dispatch>)=>{
      const [prepared,authority,context]=args;issued.command=prepared.command;
      issued.query=managedDatabaseDeleteReceiptQuerySchema.parse({...prepared.input,action:"database.runtime.delete",operation:"database.runtime.delete",storagePolicy:"retain-original",stopPolicy:"if-running",confirmationId:prepared.confirmationId,agentId,commandId:prepared.command.id,inputDigest:deleteDigest,idempotencyKey:prepared.command.idempotencyKey,requiredCapabilities:["database.runtime.delete.v1"],authority,lease:authority.projectLease,context:{requestId:context.requestId,correlationId:context.correlationId},timeoutMs:60000});
      const command={...issued.query,cancellationRequested:false};expect((await sendDelete(command,"invalid")).status).toBe(401);
      const rejected=await sendDelete({...command,confirmationId:randomUUID()});expect(rejected.status).toBe(400);expect(await rejected.json()).toEqual({error:"Confirmed project authority is unavailable"});expect(deleteEffects).toBe(0);
      return deleteTransport.dispatch(...args);
    }};
    const applyInput={preparation:removalSource,actorId,idempotencyKey:deleteKey,confirmationId:approval.id,context:{requestId:randomUUID(),correlationId:randomUUID()},signal,
      authorize:async()=>(await db.pool.query("SELECT id FROM control_grants WHERE actor_user_id=$1 AND action='project.update' AND scope_kind='project' AND scope_key=$2",[actorId,projectId])).rows.length===1,current:()=>!signal.aborted,
      admit:async()=>{const plan=planManagedDatabaseProfile({schemaVersion:1,projectId,databaseId,engine},profile,imagePolicy);expect(plan.planDigest).toBe(removalSource.planDigest);expect(plan.profileId).toBe(removalSource.profileId);}};
    let completionFaults=0;const originalTransport=new AuthenticatedManagedDatabaseRuntimeTransport(transportOptions),faultControls=new DbControlCommandRepository(db.db,stage=>{if(stage==="command-completed"){completionFaults++;throw new Error("injected removal completion rollback");}});
    await app.close();app=await build(endpoint,"managed_database_fixture_key_1234567890",new Map([[projectId,{controls:faultControls,transport:fencedDeleteTransport,originalTransport,agentId,deadlineMs:60000,now:Date.now}]]));
    const applyDelete=()=>app!.inject({method:"POST",url:`/api/v1/projects/${projectId}/databases/${databaseId}/runtime/delete/apply`,headers:{cookie,"idempotency-key":deleteKey,"x-correlation-id":randomUUID()},payload:{...deleteBody,confirmationId:approval.id}});
    await browserFixture.applyRemovalExpectUnknown();
    expect(completionFaults).toBe(1);if(!issued.query||!issued.command)throw new Error("One issued deletion required.");const deleteQuery=issued.query,deleteCommand={...deleteQuery,cancellationRequested:false};
    const deleted=managedDatabaseDeleteReceiptSchema.parse((await deleteTransport.readReceipt({command:issued.command,input:removalSource,agentId,confirmationId:approval.id},deleteQuery.authority,{...deleteQuery.context,signal}))!);expect(managedDatabaseDeleteReceiptMatches(deleteQuery,deleted)).toBe(true);expect(deleteEffects).toBe(1);
    expect((await runner.run(["docker","container","ls","--all","--no-trunc","--filter",`id=${receipt.containerId}`,"--format","{{.ID}}"],signal)).stdout).toBe("");
    expect(await resources.verifyFresh({request:input.request,profile,commandId:receipt.commandId},pinned,authority,signal)).toEqual(pinned);
    const completionAudits=async()=>(await db.pool.query("SELECT * FROM audit_events WHERE action='database.runtime.removed' AND correlation_id=$1",[deletePending.correlationId])).rows;
    const deleteNonce=async()=>(await db.pool.query("SELECT * FROM control_command_confirmations WHERE command_id=$1",[deletePending.id])).rows,originalConsumed=await deleteNonce();expect(originalConsumed).toHaveLength(1);expect(originalConsumed[0].consumed_at).not.toBeNull();
    expect(await completionAudits()).toHaveLength(0);expect((await db.pool.query("SELECT status,result FROM control_commands WHERE id=$1",[deletePending.id])).rows).toEqual([{status:"dispatching",result:null}]);
    await app.close();app=undefined;await peer!.close();peer=undefined;await db.reopen();endpoint=await startPeer(false);
    const recoveredDeleteTransport=new AuthenticatedManagedDatabaseDeleteTransport({...transportOptions,endpoint}),cachedDelete=await recoveredDeleteTransport.readReceipt({command:issued.command,input:removalSource,agentId,confirmationId:approval.id},deleteQuery.authority,{...deleteQuery.context,signal});
    expect(cachedDelete).toEqual(deleted);expect((await sendDelete(deleteCommand)).status).toBe(403);expect(deleteEffects).toBe(1);
    const finalControls=new DbControlCommandRepository(db.db),recoveryAccess={controls:finalControls,transport:recoveredDeleteTransport,originalTransport:new AuthenticatedManagedDatabaseRuntimeTransport({...transportOptions,endpoint}),agentId,deadlineMs:60000,now:Date.now};
    app=await build(endpoint,"managed_database_fixture_key_1234567890");
    const retained=pinned;if(!retained)throw new Error("Original retained storage required.");
    const browserDeletion=await browserFixture.recoverRemoval(async()=>{expect(await resources.verifyFresh({request:input.request,profile,commandId:receipt.commandId},retained,authority,signal)).toEqual(retained);expect(await encrypted()).toEqual(cipherRows);expect(deleteEffects).toBe(1);});
    const recoveredApply=await applyDelete();expect(recoveredApply.statusCode).toBe(200);expect(recoveredApply.json().data).toMatchObject({removed:true,idempotent:true,receipt:deleted});
    const completed=(await finalControls.findProjectUpdateByIdempotency(actorId,projectId,deleteKey))!;expect(completed).toMatchObject({status:"completed",result:deleted});const repeatedApply=await applyDelete();expect(repeatedApply.statusCode).toBe(200);expect(repeatedApply.json().data.receipt).toEqual(deleted);expect(deleteEffects).toBe(1);
    expect((await applyManagedDatabaseDelete({...recoveryAccess,now:()=>deletePending.expiresAt.getTime()+1},applyInput)).command).toEqual(completed);
    expect(await finalControls.findManagedDatabaseRemovals(projectId)).toEqual([completed]);const completedAudits=await completionAudits();expect(completedAudits).toHaveLength(1);expect(completedAudits[0].metadata.receipt.containerId).toBe("[REDACTED]");expect(await deleteNonce()).toEqual(originalConsumed);
    expect(await originals()).toEqual(originalRows);expect(await encrypted()).toEqual(cipherRows);
    const retiredInventory = async () => {
      const response = await app!.inject({method:"GET",url:`/api/v1/projects/${projectId}/databases`,headers:{cookie,"x-correlation-id":randomUUID()}});
      expect(response.statusCode).toBe(200);expect(response.json().data.databases).toEqual([]);
      expect(response.body).not.toMatch(/encryptedValue|sealedEnvironment|DATABASE_PASSWORD/);
      expect(await finalControls.findManagedDatabaseRemovals(projectId)).toEqual([completed]);
      expect(await originals()).toEqual(originalRows);expect(await encrypted()).toEqual(cipherRows);expect(deleteEffects).toBe(1);
    };
    await retiredInventory();await app.close();app=await build(endpoint,"managed_database_fixture_key_1234567890");await retiredInventory();
    result!.confirmedDeletion={projectId,receipt:deleted,originalSources:"passed",apiTransport:"passed",prepareControl:"passed",prepareRoute:"passed",applyControl:"passed",applyRoute:"passed",inventoryRetirement:"passed",browserDeletion,signatureRejected:"passed",confirmationRejected:"passed",originalNonce:"passed",signedHttp:"passed",effects:deleteEffects,rollback:"passed",cacheOnlyReopen:"passed",executorRemoved:"passed",retirement:"passed",retainedStorage:"passed",audit:"passed",originalRows:"unchanged",cipher:"unchanged"};
  } finally {
    await browserFixture?.close();
    if (app) await app.close(); if (peer) await peer.close(); vi.unstubAllGlobals();
    await dump?.close();
    if(redisSourceInfo){const current=await lstat(redisSourceRoot);expect([current.dev,current.ino,current.uid]).toEqual([redisSourceInfo.dev,redisSourceInfo.ino,redisSourceInfo.uid]);expect(current.isDirectory()&&!current.isSymbolicLink()).toBe(true);await rm(redisSourceRoot,{recursive:true});await expect(lstat(redisSourceRoot)).rejects.toMatchObject({code:"ENOENT"});if(nativeBackup)nativeBackup.sourceCleanup="passed";}
    const cleanup = AbortSignal.timeout(60000);
    for (const id of created) {
      let observation;
      try {observation = await inspector.inspectContainer(id,cleanup);} catch {
        expect((await runner.run(["docker","container","ls","--all","--no-trunc","--filter",`id=${id}`,"--format","{{.ID}}"],cleanup)).stdout.trim()).toBe(""); continue;
      }
      expect(observation).toMatchObject({owner:projectId,projectId,databaseId,commandId:originalCommandId,planDigest:originalPlanDigest});
      expect(observation.name).toMatch(/^\/dl-[a-f0-9]{32}-database(?:-init)?$/);
      if (observation.running) await runner.run(["docker","stop","--timeout","10",id],cleanup);
      expect((await inspector.inspectContainer(id,cleanup)).running).toBe(false); await runner.run(["docker","rm",id],cleanup);
    }
    if (volume || network) {
      pinned ??= original();
      await resources.verifyFresh({request:{schemaVersion:1,projectId,databaseId,engine},profile,commandId:pinned.commandId},pinned,{assertValid:async () => {if (cleanup.aborted) throw new Error("Cleanup deadline expired.");}},cleanup);
      await runner.run(["docker","network","rm",pinned.network.name],cleanup); await runner.run(["docker","volume","rm",pinned.volume.name],cleanup);
      for (const [kind,name] of [["network",pinned.network.name],["volume",pinned.volume.name]] as const) {
        try {await runner.run(["docker",kind,"inspect",name],cleanup); throw new Error("Fixture remains.");}
        catch (error) {expect(error).toBeInstanceOf(DockerProcessError); expect((error as DockerProcessError).result?.stderr).toMatch(new RegExp(`no such ${kind}|${kind} .*not found`,"i"));}
      }
    }
  }
  evidence[engine] = {...result,cleanup:"verified"};
}, 270000);
afterAll(async () => {
  const databaseName = session?.databaseName;
  if (session) await session.close();
  writeFileSync(resolve(directory,"acceptance.json"),JSON.stringify({schemaVersion:1,commit:scope.commit,runId:scope.runId,runAttempt:scope.runAttempt,nonce:scope.nonce,
    engines:evidence,database:{name:databaseName,cleanup:"verified"}},null,2)+"\n",{mode:0o600});
},70000);
