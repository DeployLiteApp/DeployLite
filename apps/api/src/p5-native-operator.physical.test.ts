import {createEnvSecretCipher, loadEnvSecretKey, redactLogMessage} from "@deploylite/config";
import {afterAll, beforeAll, expect, it, vi} from "vitest";
import {createHash, randomBytes, randomUUID} from "node:crypto";
import {lstatSync, readFileSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import type {FastifyInstance} from "fastify";
import {AuthenticatedAgentCommandReceiver, startAgentServer} from "@deploylite/agent";
import {approvedManagedDatabaseProfileSchema, InMemoryCapabilityRegistry, managedDatabaseRuntimeReceiptSchema, managedDatabaseStopReceiptSchema, managedDatabaseStartReceiptSchema,
  MANAGED_DATABASE_STOP_PATH, MANAGED_DATABASE_START_PATH, MANAGED_DATABASE_HEALTH_PATH, managedDatabaseHealthObservationSchema, MANAGED_DATABASE_METRICS_PATH, managedDatabaseMetricsObservationSchema, MANAGED_DATABASE_LOGS_PATH, managedDatabaseLogsObservationSchema, type ManagedDatabaseEngineV1} from "@deploylite/contracts";
import {DbAgentReplayStore, DbControlCommandRepository, DbProjectRepository} from "@deploylite/db";
import {managedDatabaseNativeImagePolicy} from "@deploylite/domain";
import {buildApiApp} from "./app.js";
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
function probe(engine:ManagedDatabaseEngineV1, write:boolean, hostname = "127.0.0.1") {
  if (!/^(127\.0\.0\.1|db-[a-z][a-z0-9_-]{0,59})$/.test(hostname)) throw new Error("Scoped fixture hostname required.");
  const sql = write ? "CREATE TABLE IF NOT EXISTS p5_probe (value varchar(64)); DELETE FROM p5_probe; INSERT INTO p5_probe VALUES ('p5-persistent-value');" : "SELECT value FROM p5_probe;";
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
  let statsDispatches=0, logReads=0;
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
  const limits = {deadlineMs:60000,maxOutputBytes:131072,maxContainers:64,pollIntervalMs:100,cpus:1,memoryBytes:536870912,pidsLimit:256,stopGraceSeconds:10};
  const raw = JSON.stringify({profiles,limits}), clock = {now:Date.now};
  const capabilities = new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1","database.runtime.stop.v1","database.runtime.start.v1","database.runtime.health.v1","database.runtime.metrics.v1","database.runtime.logs.v1"]);
  const shared = {runner,imagePolicy,clock,limits,owner:projectId,agentId,trustKey,capabilities};
  const inspector = createManagedDatabaseDockerInspector(shared), resources = createManagedDatabaseResourceMaterializer(shared);
  const native = createConfiguredManagedDatabaseRuntime(raw, shared)!;
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
  let stopDispatches = 0, startDispatches = 0, healthDispatches = 0, metricsDispatches = 0, logsDispatches = 0, lostStop = false, lostStart = false, result: Record<string,unknown> | undefined;
  async function startPeer(enabled:boolean) {
    const replayStore = new DbAgentReplayStore(db.db, "operator-" + projectId);
    const receiver = new AuthenticatedAgentCommandReceiver({agentId,trustKey,replayStore,capabilities:enabled ? capabilities.list() : [],
      managedDatabaseRuntime:enabled ? native : undefined, managedDatabaseStop:enabled ? stopExecutor : undefined, managedDatabaseStart:enabled ? startExecutor : undefined, managedDatabaseHealth:enabled?healthReader:undefined, managedDatabaseMetrics:enabled?metricsReader:undefined, managedDatabaseLogs:enabled?logsReader:undefined,
      dispatcher:{dispatch:async () => {throw new Error("Unexpected deployment.");}},authorityValidator:new DbControlCommandRepository(db.db)});
    peer = await startAgentServer({host:"127.0.0.1",port:0,production:false,receiver,replayStore});
    const address = peer.server.address(); if (!address || typeof address === "string") throw new Error("Owned peer address required.");
    return "http://127.0.0.1:" + address.port;
  }
  const build = (endpoint:string, key?:string) => buildApiApp({db:{pool:db.pool,client:db.db},authConfig:{cookieName:"dl_operator_session",cookieSecure:false,sessionTtlSeconds:3600},
    env:{...process.env,NODE_ENV:"test",DATABASE_URL:"postgres://deploylite:deploylite-ci-only@127.0.0.1:" + scope.postgresPort + "/" + db.databaseName,DEPLOYLITE_BCRYPT_COST:"10",DEPLOYLITE_SECRET_KEY:key,DEPLOYLITE_AGENT_URL:endpoint,
      DEPLOYLITE_AGENT_ID:agentId,DEPLOYLITE_AGENT_TRUST_KEY:trustKey,DEPLOYLITE_MANAGED_DATABASE_RUNTIME:raw,
      DEPLOYLITE_MANAGED_DATABASE_PROJECT_AGENTS_JSON:JSON.stringify([{projectId,agentId}])}});
  try {
    await runner.run(["docker","pull",profile.image],signal);
    await new DbProjectRepository(db.db).save({id:projectId,name:"Operator fixture",repoUrl:"https://example.test/repo",defaultBranch:"main",buildCommand:null,runCommand:null,port:null,description:null,imageTag:null});
    let endpoint = await startPeer(true);
    vi.stubGlobal("fetch", async (url: Parameters<typeof fetch>[0], init?:RequestInit) => {
      if (!String(url).startsWith(endpoint + "/")) throw new Error("Unscoped fixture HTTP request.");
      if(String(url)===endpoint+MANAGED_DATABASE_HEALTH_PATH)healthDispatches++;
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
      headers:{cookie,"idempotency-key":operation === "runtime/stop" ? "native-stop-" + engine : operation === "runtime/start" ? "native-start-" + engine : "native-" + engine},payload:payload as Record<string,unknown>});
    expect((await call("credentials",{schemaVersion:1,engine})).statusCode).toBe(403);
    await db.pool.query("INSERT INTO control_grants(actor_user_id,action,scope_kind,scope_key) VALUES($1,'project.update','project',$2)",[actorId,projectId]);
    expect((await call("credentials",{schemaVersion:1,engine})).statusCode).toBe(200);
    const preview = await call("runtime/preview",{schemaVersion:1,engine}); expect(preview.statusCode).toBe(200);
    const {projectId:_project,databaseId:_database,...preparation} = preview.json().data.preparation;
    const connection = preview.json().data.connection;
    const apply = await call("runtime/apply",preparation); expect(apply.statusCode).toBe(200);
    expect(apply.json().data.command.status).toBe("completed");
    const receipt = managedDatabaseRuntimeReceiptSchema.parse(apply.json().data.receipt);
    expect(receipt.status).toBe("ready"); if (!receipt.containerId || !receipt.imageId) throw new Error("Original daemon identity required.");
    pinned = original(); expect(receipt).toMatchObject({commandId:pinned.commandId,planDigest:pinned.planDigest,networkId:pinned.network.id,volumeCreatedAt:pinned.volume.createdAt});
    const input = {request:{schemaVersion:1,projectId,databaseId,engine},profile,commandId:receipt.commandId,imageId:receipt.imageId,containerId:receipt.containerId,environmentFingerprint:receipt.environmentFingerprint};
    const verifier = createManagedDatabaseReadinessVerifier({...shared,nativeInspector:inspector,resourceVerifier:resources,
      composeInspector:createDockerComposeResourceInspector(shared),processIdentityReader:createManagedDatabaseProcessIdentityReader(shared)});
    const authority = {assertValid:async () => {if (signal.aborted) throw new Error("Fixture deadline expired.");}};
    const ready = await verifier.verify(input,pinned,authority,signal); expect(ready.uid).toBeGreaterThan(0);
    await runner.run(["docker","exec",receipt.containerId,"sh","-ec",probe(engine,true)],signal);
    for (const hostname of ["127.0.0.1",connection.hostname]) expect((await runner.run(["docker","exec",receipt.containerId,"sh","-ec",probe(engine,false,hostname)],signal)).stdout.trim()).toBe(marker);
    const originals = async () => ({commands:(await db.pool.query("SELECT * FROM control_commands WHERE id=$1",[receipt.commandId])).rows,
      cache:(await db.pool.query("SELECT * FROM agent_replay WHERE command_id=$1",[receipt.commandId])).rows});
    const encrypted = async () => (await db.pool.query("SELECT id,encrypted_value,value_fingerprint FROM env_secret_values WHERE project_id=$1 ORDER BY id",[projectId])).rows;
    const originalRows = await originals(), cipherRows = await encrypted(); expect(cipherRows).toHaveLength(1);
    const fixtureCipher = createEnvSecretCipher(loadEnvSecretKey("managed_database_fixture_key_1234567890"));
    const privateBundle = JSON.parse(fixtureCipher.decrypt(Buffer.from(cipherRows[0].encrypted_value).toString("base64"))) as {credentials: Record<string, string>};
    const originalReplayFingerprint: string = apply.json().data.originalReplayFingerprint;
    expect(originalReplayFingerprint).toBe(createHash("sha256").update(originalRows.cache[0].fingerprint).digest("hex"));
    expect(apply.json().data.command).not.toHaveProperty("projectExecutionAuthority");
    const stopInput = {...preparation,originalReceipt:receipt,originalReplayFingerprint};
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
    const runningBeforeStop=await currentHealth("running");
    const runningMetricsBeforeStop=await currentMetrics("running");
    const runningLogsBeforeStop = await currentLogs("running");
    const stop = await call("runtime/stop",stopInput); expect(stop.statusCode).toBe(200);
    expect(stop.json().data.command.status).toBe("completed");
    const stopped = managedDatabaseStopReceiptSchema.parse(stop.json().data.receipt);
    expect(stopped).toMatchObject({status:"stopped",originalCommandId:receipt.commandId,containerId:receipt.containerId});
    expect((await inspector.inspectContainer(receipt.containerId,signal)).running).toBe(false);
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
    const startInput = {...stopInput,originalStopReceipt:stopped,originalStopReplayFingerprint};
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
    result = {currentLogs: {runningBeforeStop: runningLogsBeforeStop, stopped: stoppedLogs, runningAfterStart: runningLogsAfterStart}, currentMetrics:{runningBeforeStop:runningMetricsBeforeStop,stopped:stoppedMetrics,runningAfterStart:runningMetricsAfterStart},currentHealth:{runningBeforeStop,stopped:stoppedHealth,runningAfterStart},receipt,uid:ready.uid,original:pinned,nativeStop:{receipt:stopped,originalReplayFingerprint},nativeStart:{receipt:started,originalStopReplayFingerprint},internalConnection:{details:connection,authenticatedRead:"passed",afterRestart:"passed"},
      authenticatedProbe:"passed",restart:"passed",persistence:"passed",operator:{publicOriginalSelectors:"passed",logsDispatches,logReads,logsSignedHttp:"passed",logsNoLedgerWrites:"passed",logsExecutorRemoved:"passed",metricsDispatches,statsDispatches,metricsSignedHttp:"passed",metricsNoLedgerWrites:"passed",metricsExecutorRemoved:"passed",healthDispatches,healthSignedHttp:"passed",healthNoLedgerWrites:"passed",healthExecutorRemoved:"passed",applyCommand:command(apply),stopCommand:command(stop),startCommand:command(start),startDispatches,startAtomicAudit:"passed",startCacheOnlyReplay:"passed",startExecutorRemoved:"passed",stoppedCacheNoRestart:"passed",signedHttp:"passed",postgresReplay:"passed",
        originalRows:"unchanged",cipherRows:"unchanged",atomicAudit:"passed",stopDispatches,cacheOnlyReplay:"passed",executorRemoved:"passed"}};
  } finally {
    if (app) await app.close(); if (peer) await peer.close(); vi.unstubAllGlobals();
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
