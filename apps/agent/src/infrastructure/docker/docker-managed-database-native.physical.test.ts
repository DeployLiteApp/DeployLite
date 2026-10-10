import {afterAll, expect, it} from "vitest";
import {createHash, randomBytes} from "node:crypto";
import {readFileSync, lstatSync, writeFileSync} from "node:fs";
import {resolve} from "node:path";
import {z} from "zod";
import {createEnvSecretCipher, sealAgentSecretEnvelope} from "@deploylite/config";
import {approvedManagedDatabaseProfileSchema, InMemoryCapabilityRegistry} from "@deploylite/contracts";
import {ensureManagedDatabaseCredentials, materializeManagedDatabaseRuntime, managedDatabaseRuntimeExecutionDigest, type EncryptedEnvSecretValueRecord} from "@deploylite/domain";
import {DockerProcessRunner, DockerProcessError} from "./docker-process-runner.js";
import type {DockerCliRunner} from "./docker-cli-image-transport.js";
import {createManagedDatabaseRuntime} from "./docker-managed-database-runtime.js";
import {createManagedDatabaseDockerInspector} from "./docker-managed-database-inspection.js";
import {createManagedDatabaseResourceMaterializer, type ManagedDatabaseFreshResources} from "./docker-managed-database-resources.js";
import {createManagedDatabaseReadinessVerifier} from "./docker-managed-database-readiness.js";
import {createManagedDatabaseProcessIdentityReader} from "./docker-managed-database-process-identity.js";
import {createDockerComposeResourceInspector} from "./docker-compose-resource-inspector.js";
import {MANAGED_DATABASE_VOLUME_INSPECT_FORMAT, MANAGED_DATABASE_NETWORK_INSPECT_FORMAT} from "./docker-managed-database-resource-argv.js";
const engines = ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const;
const directory = resolve(process.env.RUNNER_TEMP ?? "/unavailable", "deploylite-p5-native-evidence");
const root = resolve(import.meta.dirname, "../../../../..");
const binding = z.object({schemaVersion:z.literal(1), repository:z.literal("DeployLiteApp/DeployLite"),job:z.literal("p5-native-database-acceptance"),
    runId:z.string().regex(/^[1-9][0-9]*$/),runAttempt:z.string().regex(/^[1-9][0-9]*$/),commit:z.string().regex(/^[a-f0-9]{40}$/),nonce:z.string().regex(/^[a-f0-9]{24}$/),
    owner:z.string().regex(/^ci-p5-[1-9][0-9]*-[1-9][0-9]*-[a-f0-9]{24}$/),engines:z.array(z.enum(engines)),sourceHashes:z.record(z.string().regex(/^[a-f0-9]{64}$/)),
    profiles:z.record(approvedManagedDatabaseProfileSchema),admission:z.literal("prepared")}).strict();
// Failure here fails collection; it never creates skipped physical cases.
if (process.platform !== "linux" || process.env.DEPLOYLITE_P5_NATIVE_PHYSICAL !== "1" || process.env.DEPLOYLITE_P5_NATIVE_RUNTIME_GRANT !== "P5_NATIVE_CI_APPROVED") throw new Error("Explicit hosted native fixture required.");
const bindingPath = resolve(directory, "binding.json"), metadata = lstatSync(bindingPath);
if (metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) throw new Error("Private owned binding required.");
const scope = binding.parse(JSON.parse(readFileSync(bindingPath,"utf8")));
for (const [key,value] of [["GITHUB_REPOSITORY",scope.repository],["GITHUB_JOB",scope.job],["GITHUB_RUN_ID",scope.runId],["GITHUB_RUN_ATTEMPT",scope.runAttempt],["DEPLOYLITE_P5_EXPECTED_SHA",scope.commit]] as const) {
    if (process.env[key] !== value) throw new Error("Changed hosted fixture scope.");
}
if (JSON.stringify(scope.engines) !== JSON.stringify(engines) || JSON.stringify(Object.keys(scope.profiles).sort()) !== JSON.stringify([...engines].sort())) throw new Error("All five engines required.");
for (const [name,hash] of Object.entries(scope.sourceHashes)) {
    const path = resolve(root,name);
    if (!path.startsWith(root+"/") || createHash("sha256").update(readFileSync(path)).digest("hex") !== hash) throw new Error("Changed fixture source.");
}
const evidence: Record<string,unknown> = {};
const marker = "p5-persistent-value";
function probe(engine:typeof engines[number], write:boolean) {
    const sql = write ? "CREATE TABLE IF NOT EXISTS p5_probe (value varchar(64)); DELETE FROM p5_probe; INSERT INTO p5_probe VALUES ('p5-persistent-value');" : "SELECT value FROM p5_probe;";
    if (engine === "postgres") return `PGPASSWORD="$POSTGRES_PASSWORD" psql --host 127.0.0.1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-password --tuples-only --no-align --command "${sql}"`;
    if (engine === "mysql" || engine === "mariadb") {
        const prefix = engine === "mysql" ? "MYSQL" : "MARIADB", binary = engine === "mysql" ? "mysql" : "mariadb";
        return `MYSQL_PWD="$${prefix}_PASSWORD" ${binary} --host 127.0.0.1 --user "$${prefix}_USER" --database "$${prefix}_DATABASE" --batch --skip-column-names --execute "${sql}"`;
    }
    if (engine === "mongodb") return `mongosh --quiet --host 127.0.0.1 --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin --eval '${write ? 'db.getSiblingDB(process.env.MONGO_INITDB_DATABASE).p5_probe.updateOne({_id:"probe"},{$set:{value:"p5-persistent-value"}},{upsert:true})' : 'print(db.getSiblingDB(process.env.MONGO_INITDB_DATABASE).p5_probe.findOne({_id:"probe"}).value)'}'`;
    return `REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning --host 127.0.0.1 ${write ? "SET p5_probe p5-persistent-value" : "GET p5_probe"}`;
}
for (const engine of engines) {
    it(`native five-engine physical ${engine} startup and persistence`, async () => {
        const processRunner = new DockerProcessRunner({timeoutMs:60000,maxOutputBytes:131072});
        const signal = AbortSignal.timeout(170000), created = new Set<string>();
        let volume: {name:string;createdAt:string}|undefined, network:{name:string;id:string}|undefined;
        const profile = scope.profiles[engine]!, request = {schemaVersion:1,projectId:scope.owner,databaseId:engine,engine};
        const commandId = `p5-${engine}-${scope.nonce}`, agentId = `p5-native-${scope.runId}`;
        const runner: DockerCliRunner = {run:async (argv,abort,environment) => {
            const result = await processRunner.run(argv,abort,environment);
            if (argv[1] === "create" && /^[a-f0-9]{64}$/.test(result.stdout.trim())) created.add(result.stdout.trim());
            if (argv.includes(MANAGED_DATABASE_VOLUME_INSPECT_FORMAT)) {
                const value = JSON.parse(result.stdout);
                if (!volume && value.owner === scope.owner && value.commandId === commandId) volume = {name:value.name,createdAt:value.createdAt};
            }
            if (argv.includes(MANAGED_DATABASE_NETWORK_INSPECT_FORMAT)) {
                const value = JSON.parse(result.stdout);
                if (!network && value.owner === scope.owner && value.commandId === commandId) network = {name:value.name,id:value.id};
            }
            return result;
        }};
        const imagePolicy = {policyVersion:"ci-native-1",trustedHosts:["docker.io"],allowTags:false,allowDigests:true};
        const clock = {now:Date.now}, limits = {deadlineMs:60000,maxOutputBytes:131072,maxContainers:64,pollIntervalMs:100,cpus:1,memoryBytes:536870912,pidsLimit:256};
        const shared = {runner,imagePolicy,clock,limits,owner:scope.owner,agentId,capabilities:new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1"])};
        const inspector = createManagedDatabaseDockerInspector(shared), resources = createManagedDatabaseResourceMaterializer(shared);
        const original = (): ManagedDatabaseFreshResources => {
            if (!volume || !network) throw new Error("Original fixture storage unavailable.");
            return {projectId:request.projectId,databaseId:engine,commandId,planDigest:runtime.plan.planDigest,volume,network};
        };
        const authority = {assertValid:async () => {if(signal.aborted) throw new Error("Fixture deadline expired.");}};
        let row:EncryptedEnvSecretValueRecord|undefined;
        const cipher = createEnvSecretCipher(randomBytes(32));
        await ensureManagedDatabaseCredentials(request,profile,{imagePolicy,cipher,authorize:async project => project === scope.owner,secrets:{
            find:async () => row,createIfAbsent:async input => (row ??= {...input,id:`secret-${engine}`,valuePresent:true,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()})}});
        const runtime = materializeManagedDatabaseRuntime(request,profile,{imagePolicy,cipher,credentials:row!});
        const preparation = {...request,profileId:profile.profileId,planDigest:runtime.plan.planDigest,environmentFingerprint:runtime.environmentFingerprint};
        const inputDigest = managedDatabaseRuntimeExecutionDigest(preparation), trustKey = "ci-native-"+randomBytes(32).toString("hex");
        let result:unknown;
        try {
            await runner.run(["docker","pull",profile.image],signal);
            const lease = {projectId:request.projectId,leaseId:`lease-${engine}`,fence:1,expiresAt:Date.now()+60000};
            const command = {...preparation,action:"database.runtime",operation:"database.runtime.apply",agentId,commandId,idempotencyKey:commandId,inputDigest,
                requiredCapabilities:["database.runtime.v1"],authority:{schemaVersion:1,projectId:request.projectId,commandId,action:"project.update",inputDigest,projectLease:lease},lease,
                context:{requestId:commandId,correlationId:commandId},timeoutMs:60000,cancellationRequested:false,
                sealedEnvironment:sealAgentSecretEnvelope(runtime.environment,trustKey,{agentId,commandId,inputDigest,projectId:request.projectId})};
            const executor = createManagedDatabaseRuntime({...shared,trustKey,profiles:scope.profiles,capabilities:new InMemoryCapabilityRegistry(["database.runtime.v1","compose.resource.inspect.v1"])});
            const receipt = await executor.apply(command,authority,signal);
            expect(receipt).toMatchObject({engine,status:"ready",health:"passed",storage:"verified",redacted:true});
            if (!receipt.imageId || !receipt.containerId) throw new Error("Ready original daemon identity required.");
            const pinned = original();
            const nativeInput = {request,profile,commandId,imageId:receipt.imageId,containerId:receipt.containerId,environmentFingerprint:runtime.environmentFingerprint};
            const verifier = createManagedDatabaseReadinessVerifier({...shared,nativeInspector:inspector,resourceVerifier:resources,
                composeInspector:createDockerComposeResourceInspector(shared),processIdentityReader:createManagedDatabaseProcessIdentityReader(shared)});
            const ready = await verifier.verify(nativeInput,pinned,authority,signal);
            expect(ready.uid).toBeGreaterThan(0);
            await runner.run(["docker","exec",receipt.containerId,"sh","-ec",probe(engine,true)],signal);
            expect((await runner.run(["docker","exec",receipt.containerId,"sh","-ec",probe(engine,false)],signal)).stdout.trim()).toBe(marker);
            await verifier.verify(nativeInput,pinned,authority,signal);
            await runner.run(["docker","stop","--time","10",receipt.containerId],signal);
            expect((await inspector.inspectContainer(receipt.containerId,signal)).running).toBe(false);
            await resources.verifyFresh({request,profile,commandId},pinned,authority,signal);
            await runner.run(["docker","start",receipt.containerId],signal);
            while ((await inspector.inspectContainer(receipt.containerId,signal)).health === "starting") await new Promise(resolve => setTimeout(resolve,100));
            const restarted = await verifier.verify(nativeInput,pinned,authority,signal);
            expect(restarted).toEqual(ready);
            expect((await runner.run(["docker","exec",receipt.containerId,"sh","-ec",probe(engine,false)],signal)).stdout.trim()).toBe(marker);
            result = {receipt,original:pinned,uid:ready.uid,authenticatedProbe:"passed",restart:"passed",persistence:"passed"};
        } finally {
            // Fixture-only cleanup: never force, adopt a replacement, or delete in-use/foreign resources.
            const cleanup = AbortSignal.timeout(30000);
            for (const id of created) {
                let observation;
                try {observation = await inspector.inspectContainer(id,cleanup);} catch {
                    const absent = await runner.run(["docker","container","ls","--all","--no-trunc","--filter",`id=${id}`,"--format","{{.ID}}"],cleanup);
                    expect(absent.stdout.trim()).toBe(""); continue;
                }
                expect(observation).toMatchObject({owner:scope.owner,projectId:scope.owner,databaseId:engine,commandId,planDigest:runtime.plan.planDigest});
                expect(observation.name).toMatch(/^\/dl-[a-f0-9]{32}-database(?:-init)?$/);
                if (observation.running) await runner.run(["docker","stop","--time","10",id],cleanup);
                expect((await inspector.inspectContainer(id,cleanup)).running).toBe(false);
                await runner.run(["docker","rm",id],cleanup);
            }
            if (volume || network) {
                const pinned = original();
                await resources.verifyFresh({request,profile,commandId},pinned,{assertValid:async () => {if(cleanup.aborted) throw new Error("Cleanup expired.");}},cleanup);
                await runner.run(["docker","network","rm",pinned.network.name],cleanup);
                await runner.run(["docker","volume","rm",pinned.volume.name],cleanup);
                for (const [kind,name] of [["network",pinned.network.name],["volume",pinned.volume.name]] as const) {
                    try {await runner.run(["docker",kind,"inspect",name],cleanup);throw new Error("Fixture remains.");}
                    catch (error) {expect(error).toBeInstanceOf(DockerProcessError);expect((error as DockerProcessError).result?.stderr).toMatch(new RegExp(`no such ${kind}|${kind} .*not found`,"i"));}
                }
            }
        }
        evidence[engine] = {result,cleanup:"verified"};
    },200000);
}
afterAll(() => {
    const status = Object.keys(evidence).length === 5 ? "passed" : "failed";
    writeFileSync(resolve(directory,"acceptance.json"),JSON.stringify({schemaVersion:1,commit:scope.commit,runId:scope.runId,runAttempt:scope.runAttempt,nonce:scope.nonce,status,engines:evidence},null,2)+"\n",{mode:0o600});
});
