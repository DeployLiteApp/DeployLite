import { expect, it, vi } from "vitest";
import { sealAgentSecretEnvelope } from "@deploylite/config";
import { InMemoryCapabilityRegistry, managedDatabaseRuntimeReceiptSchema } from "@deploylite/contracts";
import { digestControlInput, managedDatabaseRuntimeExecutionDigest, planManagedDatabaseProfile } from "@deploylite/domain";
import { createManagedDatabaseStartupPreparation } from "./docker-managed-database-startup-preparation.js";
import { createManagedDatabaseRuntimeExecutor } from "./docker-managed-database-runtime-executor.js";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
const password = "b".repeat(64), imageId = "sha256:" + "c".repeat(64), containerId = "d".repeat(64), trustKey = "test-agent-key-" + "x".repeat(64);
function fixture(engine: "postgres" | "mysql" | "mariadb" | "mongodb" | "redis" = "postgres") {
    const imagePolicy = {policyVersion: "images-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true};
    const request = {schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine};
    const profile = {schemaVersion: 1, profileId: "profile-" + engine, engine, image: `registry.example.com/${engine}@sha256:${"a".repeat(64)}`,
        dataPath: {postgres:"/var/lib/postgresql/data",mysql:"/var/lib/mysql",mariadb:"/var/lib/mysql",mongodb:"/data/db",redis:"/data"}[engine],
        containerPort: {postgres:5432,mysql:3306,mariadb:3306,mongodb:27017,redis:6379}[engine], credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" : "engine-native"};
    const plan = planManagedDatabaseProfile(request, profile, imagePolicy), preparationInput = {...request, profileId: profile.profileId, planDigest: plan.planDigest, environmentFingerprint: "e".repeat(32)};
    const inputDigest = managedDatabaseRuntimeExecutionDigest(preparationInput), lease = {projectId: request.projectId, leaseId: "lease-a", fence: 1, expiresAt: 10000};
    const user = "dl_" + digestControlInput({projectId: request.projectId, databaseId: request.databaseId}).slice(0,12);
    const environment: Record<string,string> = engine === "postgres" ? {POSTGRES_DB:"orders",POSTGRES_USER:user,POSTGRES_PASSWORD:password}
        : engine === "mongodb" ? {MONGO_INITDB_ROOT_USERNAME:user,MONGO_INITDB_ROOT_PASSWORD:password,MONGO_INITDB_DATABASE:"orders"}
        : engine === "redis" ? {REDIS_PASSWORD:password}
        : engine === "mysql" ? {MYSQL_DATABASE:"orders",MYSQL_ROOT_PASSWORD:password} : {MARIADB_DATABASE:"orders",MARIADB_ROOT_PASSWORD:password};
    const command = {...preparationInput, action:"database.runtime", operation:"database.runtime.apply", agentId:"agent-a",commandId:"command-a",idempotencyKey:"key-a",inputDigest,
        requiredCapabilities:["database.runtime.v1"],authority:{schemaVersion:1,projectId:request.projectId,commandId:"command-a",action:"project.update",inputDigest,projectLease:lease},lease,
        context:{requestId:"request-a",correlationId:"correlation-a"},timeoutMs:5000,cancellationRequested:false,
        sealedEnvironment:sealAgentSecretEnvelope(environment,trustKey,{agentId:"agent-a",commandId:"command-a",inputDigest,projectId:request.projectId})};
    const events: string[] = [], clock = {now: () => 1000}, capabilities = new InMemoryCapabilityRegistry(["database.runtime.v1"]);
    const authority = {assertValid: vi.fn(async () => {})};
    const original = {projectId:request.projectId,databaseId:request.databaseId,commandId:command.commandId,planDigest:plan.planDigest,volume:{name:plan.volume.runtimeName,createdAt:"2026-10-10T00:00:00Z"},network:{name:plan.network.runtimeName,id:"f".repeat(64)}};
    const resources = {prepareFresh:vi.fn(async () => {events.push("resources");return structuredClone(original);}),verifyFresh:vi.fn(async () => structuredClone(original))};
    const storage = {initializeFresh:vi.fn(async () => {events.push("storage");return structuredClone(original);})};
    const starter = {start:vi.fn(async () => {events.push("start");return Object.freeze({containerId,uid:999 as number});})};
    const runner = {run:vi.fn<DockerCliRunner["run"]>(async argv => {events.push(argv[1]!);return {exitCode:0,signal:null,stdout:argv[1] === "create" ? containerId + "\n" : "",stderr:""};})};
    const preparation = createManagedDatabaseStartupPreparation({agentId:"agent-a",owner:"deploylite",trustKey,imagePolicy,profiles:{[engine]:profile},capabilities,clock,
        imageInspector:{inspectImage:async () => ({imageId,declaredVolumes:[profile.dataPath]})},limits:{deadlineMs:5000,cpus:1,memoryBytes:536870912,pidsLimit:256}});
    const options = {agentId:"agent-a",profiles:{[engine]:profile},imagePolicy,capabilities,clock,runner,preparation,resources,storage,starter,limits:{deadlineMs:5000,maxOutputBytes:4096}};
    return {request,profile,command,environment,original,events,authority,runner,resources,storage,starter,options,executor:createManagedDatabaseRuntimeExecutor(options)};
}
for (const engine of ["postgres","mysql","mariadb","mongodb","redis"] as const) {
    it(`composes scoped fresh ${engine} resources, stopped create and verified start`, async () => {
        const f = fixture(engine), receipt = await f.executor.apply(f.command,f.authority,new AbortController().signal);
        expect(managedDatabaseRuntimeReceiptSchema.parse(receipt)).toMatchObject({engine,status:"ready",health:"passed",storage:"verified",containerId,imageId,correlationId:"correlation-a",idempotent:false,redacted:true});
        expect(f.events).toEqual(["container","resources","storage","container","create","start"]);
        const create = f.runner.run.mock.calls.find(([argv]) => argv[1] === "create")!;
        expect(create[0].slice(0,3)).toEqual(["docker","create","--pull=never"]);
        expect(create[0]).not.toContain("--detach");
        expect(create[0].join(" ")).not.toContain(password);
        expect(create[2]).toEqual(f.environment);
        expect(JSON.stringify(receipt)).not.toContain(password);
        expect(Object.isFrozen(receipt)).toBe(true);
    });
}
it("refuses an existing daemon before allocating or adopting storage",async () => {
    const f = fixture();
    f.runner.run.mockResolvedValue({exitCode:0,signal:null,stdout:containerId + "\n",stderr:""});
    await expect(f.executor.apply(f.command,f.authority,new AbortController().signal)).rejects.toThrow();
    expect(f.resources.prepareFresh).not.toHaveBeenCalled();
});
it("rechecks daemon absence after storage preparation before create",async () => {
    const f = fixture();
    f.runner.run.mockResolvedValueOnce({exitCode:0,signal:null,stdout:"",stderr:""}).mockResolvedValueOnce({exitCode:0,signal:null,stdout:containerId,stderr:""});
    await expect(f.executor.apply(f.command,f.authority,new AbortController().signal)).rejects.toThrow();
    expect(f.storage.initializeFresh).toHaveBeenCalledOnce();
    expect(f.runner.run.mock.calls.map(([argv]) => argv[1])).toEqual(["container","container"]);
});
it("preserves original resources and rejects changed initialization or fresh proof",async () => {
    for (const stage of ["storage","verify"] as const) {
        const f = fixture(), changed = {...f.original,network:{...f.original.network,id:"a".repeat(64)}};
        if(stage === "storage") f.storage.initializeFresh.mockResolvedValue(changed); else f.resources.verifyFresh.mockResolvedValue(changed);
        await expect(f.executor.apply(f.command,f.authority,new AbortController().signal)).rejects.toThrow();
        expect(f.starter.start).not.toHaveBeenCalled();
        expect(f.runner.run.mock.calls.every(([argv]) => argv[1] === "container")).toBe(true);
    }
});
it("refuses expired authority, foreign binding and unavailable capability before effects",async () => {
    const f = fixture();
    f.authority.assertValid.mockRejectedValue(new Error(password));
    await expect(f.executor.apply(f.command,f.authority,new AbortController().signal)).rejects.toThrow(/^Database runtime execution is unavailable\.$/);
    expect(f.runner.run).not.toHaveBeenCalled();
    const noCapability = fixture();
    await expect(createManagedDatabaseRuntimeExecutor({...noCapability.options,capabilities:new InMemoryCapabilityRegistry([])}).apply(noCapability.command,noCapability.authority,new AbortController().signal)).rejects.toThrow();
    expect(noCapability.runner.run).not.toHaveBeenCalled();
    const foreign = fixture();
    await expect(foreign.executor.apply({...foreign.command,agentId:"foreign"},foreign.authority,new AbortController().signal)).rejects.toThrow();
    expect(foreign.runner.run).not.toHaveBeenCalled();
});
it("withholds readiness and never removes persistent resources after ambiguous create/start",async () => {
    for (const stage of ["create","start"] as const) {
        const f = fixture();
        if(stage === "create") f.runner.run.mockImplementation(async argv => ({exitCode:0,signal:null,stdout:argv[1] === "create" ? "invalid" : "",stderr:""}));
        else f.starter.start.mockRejectedValue(new Error(password));
        await expect(f.executor.apply(f.command,f.authority,new AbortController().signal)).rejects.toThrow(/^Database runtime execution is unavailable\.$/);
        expect(f.runner.run.mock.calls.map(([argv]) => argv[1])).toEqual(["container","container","create"]);
    }
});
it("bounds a stalled storage port under the whole executor deadline",async () => {
    const f = fixture();
    f.storage.initializeFresh.mockImplementation(() => new Promise<never>(() => {}));
    await expect(createManagedDatabaseRuntimeExecutor({...f.options,limits:{...f.options.limits,deadlineMs:30}}).apply(f.command,f.authority,new AbortController().signal)).rejects.toThrow();
    expect(f.starter.start).not.toHaveBeenCalled();
    expect(f.runner.run.mock.calls.map(([argv]) => argv[1])).toEqual(["container"]);
});
it("fences capability revocation or lease/deadline expiry between storage and daemon creation",async () => {
    for (const boundary of ["capability","deadline","authority"] as const) {
        const f = fixture(); let enabled = true, now = 1000;
        const executor = createManagedDatabaseRuntimeExecutor({...f.options,capabilities:{has: () => enabled},clock:{now: () => now}});
        f.storage.initializeFresh.mockImplementation(async () => {
            if (boundary === "capability") enabled = false;
            else if (boundary === "deadline") now = 6000;
            else f.authority.assertValid.mockRejectedValue(new Error("revoked"));
            return structuredClone(f.original);
        });
        await expect(executor.apply(f.command,f.authority,new AbortController().signal)).rejects.toThrow();
        expect(f.runner.run.mock.calls.every(([argv]) => argv[1] === "container")).toBe(true);
        expect(f.starter.start).not.toHaveBeenCalled();
    }
});
it("withholds terminal readiness for a changed daemon identity or final revoked authority",async () => {
    const f = fixture();
    f.starter.start.mockResolvedValue({containerId:"a".repeat(64),uid:999});
    await expect(f.executor.apply(f.command,f.authority,new AbortController().signal)).rejects.toThrow();
    const revoked = fixture();
    revoked.starter.start.mockImplementation(async () => {revoked.authority.assertValid.mockRejectedValue(new Error("revoked"));return {containerId,uid:999};});
    await expect(revoked.executor.apply(revoked.command,revoked.authority,new AbortController().signal)).rejects.toThrow();
});
