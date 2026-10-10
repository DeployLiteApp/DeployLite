import { expect, it, vi } from "vitest";
import { parseDeployLiteEnv } from "@deploylite/config";
import { DbManagedDatabaseCredentialCreationRepository, type DeployLiteDb } from "@deploylite/db";
import { createRuntimeRepositories, type BuildApiAppOptions } from "./app.js";
it("constructs create-once database credentials on the configured existing database without connecting",async()=>{
 const query=vi.fn(()=>{throw new Error("Fixture must not connect")});
 const env=parseDeployLiteEnv({NODE_ENV:"test",DATABASE_URL:"postgres://fixture.invalid/unreachable",DEPLOYLITE_SECRET_KEY:"managed_fixture_key_1234567890"});
 const repositories=await createRuntimeRepositories(env,{db:{pool:{query} as unknown as NonNullable<NonNullable<BuildApiAppOptions["db"]>["pool"]>,client:{} as DeployLiteDb}});
 expect((repositories as unknown as {databaseCredentialCreation?:unknown}).databaseCredentialCreation).toBeInstanceOf(DbManagedDatabaseCredentialCreationRepository);
 expect(query).not.toHaveBeenCalled();
});
