import { expect, it, vi } from "vitest";
import { parseDeployLiteEnv } from "@deploylite/config";
import { DbBackupInventoryStore, type DeployLiteDb } from "@deploylite/db";
import { createRuntimeRepositories, type BuildApiAppOptions } from "./app.js";

it("constructs agent-bound durable inventory from the existing configured database", async () => {
  const query = vi.fn(() => { throw new Error("No runtime database operation is authorized by wiring"); });
  const env = parseDeployLiteEnv({NODE_ENV: "test", DATABASE_URL: "postgres://fixture.invalid/unreachable", DEPLOYLITE_SECRET_KEY: "inventory_fixture_key_1234567890"});
  const repositories = await createRuntimeRepositories(env, {db: {pool: {query} as unknown as NonNullable<NonNullable<BuildApiAppOptions["db"]>["pool"]>, client: {} as DeployLiteDb}});
  const factory = (repositories as unknown as {backupInventoryForAgent?: (agentId: string) => unknown}).backupInventoryForAgent;
  expect(factory?.("agent-1")).toBeInstanceOf(DbBackupInventoryStore);
  expect(query).not.toHaveBeenCalled();
});
