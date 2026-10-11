import { expect, it, vi } from "vitest";
import { createEnvSecretCipher } from "@deploylite/config";
import type { ApprovedManagedDatabaseProfileV1, ManagedDatabaseEngineV1 } from "@deploylite/contracts";
import type { EncryptedEnvSecretValueRecord, EnvSecretValueInput } from "./index.js";
import { ensureManagedDatabaseCredentials } from "./managed-database-credentials.js";
import { materializeManagedDatabaseRuntime } from "./managed-database-runtime-spec.js";
import { prepareManagedDatabaseInventory } from "./managed-database-inventory.js";
const engines = ["postgres", "mysql", "mariadb", "mongodb", "redis"] as const;
async function fixture() {
  const cipher = createEnvSecretCipher(Buffer.alloc(32, 7));
  const imagePolicy = {policyVersion: "inventory-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true};
  const rows: EncryptedEnvSecretValueRecord[] = [];
  const profiles = new Map<ManagedDatabaseEngineV1, ApprovedManagedDatabaseProfileV1>();
  const ports = {cipher, imagePolicy, profiles};
  const store = {find: vi.fn(async () => undefined), createIfAbsent: vi.fn(async (record: EnvSecretValueInput) => {
    const row = {...record, id: `secret-${rows.length}`, valuePresent: true, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()}; rows.push(row); return row;
  })};
  for (const engine of engines) {
    const profile: ApprovedManagedDatabaseProfileV1 = {schemaVersion: 1, profileId: `approved-${engine}`, engine,
      image: `registry.example.com/${engine}@sha256:${"a".repeat(64)}`, dataPath: "/database/data",
      containerPort: engine === "postgres" ? 5432 : engine === "mongodb" ? 27017 : engine === "redis" ? 6379 : 3306,
      credentialKeys: ["DATABASE_PASSWORD"], backupStrategy: engine === "redis" ? "volume-quiesced" : "engine-native"};
    profiles.set(engine, profile);
    await ensureManagedDatabaseCredentials({schemaVersion: 1, projectId: "project-a", databaseId: `orders_${engine}`, engine}, profile,
      {...ports, secrets: store, authorize: async () => true, entropy: () => Buffer.alloc(32, 9)});
  }
  return {rows, ports, store};
}
it("recovers public preparations and internal connections for all five stored engines without writes or secrets", async () => {
  const f = await fixture(), before = structuredClone(f.rows); f.store.createIfAbsent.mockClear();
  const result = prepareManagedDatabaseInventory("project-a", [...f.rows].reverse(), f.ports);
  expect(result).toHaveLength(5);
  expect(result).toEqual(prepareManagedDatabaseInventory("project-a", f.rows, f.ports));
  for (const engine of engines) {
    const row = f.rows[engines.indexOf(engine)]!;
    const input = {schemaVersion: 1, projectId: "project-a", databaseId: `orders_${engine}`, engine};
    const runtime = materializeManagedDatabaseRuntime(input, f.ports.profiles.get(engine)!, {...f.ports, credentials: row});
    expect(result).toContainEqual(expect.objectContaining({preparation: {...input, profileId: `approved-${engine}`, planDigest: runtime.plan.planDigest, environmentFingerprint: runtime.environmentFingerprint}, connection: expect.objectContaining({projectId: "project-a", engine})}));
  }
  expect(JSON.stringify(result)).not.toMatch(/090909|encryptedValue|credentialsConfigured|originalReceipt|projectExecutionAuthority/);
  expect(f.rows).toEqual(before.map(row => ({...row, encryptedValue: Buffer.from(row.encryptedValue)})));
  expect(f.store.createIfAbsent).not.toHaveBeenCalled();
});
it("ignores unrelated secret slots without decrypting them", async () => {
  const f = await fixture(), unrelated = {...f.rows[0]!, key: "REGISTRY_CREDENTIALS", encryptedValue: Buffer.from("not an envelope")};
  const decrypt = vi.spyOn(f.ports.cipher, "decrypt");
  expect(prepareManagedDatabaseInventory("project-a", [unrelated], f.ports)).toEqual([]);
  expect(decrypt).not.toHaveBeenCalled();
  expect(prepareManagedDatabaseInventory("project-a", [], f.ports)).toEqual([]);
});
it("withholds the inventory on foreign scope, malformed canonical keys or corrupted values", async () => {
  const f = await fixture();
  for (const patch of [{projectId: "foreign"}, {scope: "service"}, {key: "DEPLOYLITE_DATABASE_BROKEN"}, {key: `DEPLOYLITE_DATABASE_${"A".repeat(64)}`}, {encryptedValue: Buffer.from("bad")}, {valueFingerprint: "0".repeat(32)}, {keyVersion: 999}]) {
    expect(() => prepareManagedDatabaseInventory("project-a", [{...f.rows[0]!, ...patch} as EncryptedEnvSecretValueRecord], f.ports)).toThrow("Database inventory is unavailable.");
  }
});
it("rejects stale or missing approved profiles instead of silently omitting stored databases", async () => {
  const f = await fixture();
  f.ports.profiles.delete("redis");
  expect(() => prepareManagedDatabaseInventory("project-a", f.rows, f.ports)).toThrow("Database inventory is unavailable.");
  f.ports.profiles.set("postgres", {...f.ports.profiles.get("postgres")!, profileId: "changed"});
  expect(() => prepareManagedDatabaseInventory("project-a", [f.rows[0]!], f.ports)).toThrow("Database inventory is unavailable.");
});
it("rejects duplicate stored database identity without adopting one arbitrary row", async () => {
  const f = await fixture();
  expect(() => prepareManagedDatabaseInventory("project-a", [f.rows[0]!, f.rows[0]!], f.ports)).toThrow("Database inventory is unavailable.");
});
