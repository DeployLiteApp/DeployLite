import { describe, expect, it, vi } from "vitest";
import { createEnvSecretCipher } from "@deploylite/config";
import type { EnvSecretValueInput, EncryptedEnvSecretValueRecord } from "./index.js";
import { ensureManagedDatabaseCredentials } from "./managed-database-credentials.js";
const request = {schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine: "postgres"};
const profile = {schemaVersion: 1, profileId: "approved-1", engine: "postgres", image: `registry.example.com/db@sha256:${"a".repeat(64)}`,
  dataPath: "/database/data", containerPort: 5432, credentialKeys: ["DATABASE_PASSWORD", "DATABASE_ROOT_PASSWORD"], backupStrategy: "engine-native"};
function fixture() {
  const cipher = createEnvSecretCipher(Buffer.alloc(32,7)); let stored: EncryptedEnvSecretValueRecord | undefined;
  const find = vi.fn(async () => stored);
  const createIfAbsent = vi.fn(async (record: EnvSecretValueInput) => { stored ??= {id: "secret-a", ...record, valuePresent: true, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()}; return stored; });
  const ports = {cipher, imagePolicy: {policyVersion: "images-1",trustedHosts: ["registry.example.com"],allowTags: false,allowDigests: true},
    authorize: vi.fn(async () => true), entropy: vi.fn(() => Buffer.alloc(32,9)), secrets: {find,createIfAbsent}};
  return {ports, getStored: () => stored};
}
describe("managed database credential creation", () => {
  it("writes all generated credentials in one encrypted existing-secret record", async () => {
    const {ports,getStored} = fixture(); const result = await ensureManagedDatabaseCredentials(request,profile,ports);
    expect(result).toMatchObject({projectId: request.projectId,databaseId: request.databaseId,engine: request.engine,credentialsConfigured:true,redacted:true});
    expect(ports.secrets.createIfAbsent).toHaveBeenCalledTimes(1);
    const row = getStored()!; expect(row.encryptedValue).toBeInstanceOf(Buffer); expect(row.key).toMatch(/^DEPLOYLITE_DATABASE_[A-F0-9]{64}$/);
    const body = JSON.parse(ports.cipher.decrypt(row.encryptedValue.toString("base64")));
    expect(Object.keys(body.credentials).sort()).toEqual(profile.credentialKeys.sort());
    for (const value of Object.values(body.credentials)) expect(value).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("09".repeat(32));
  });
  it("replays without generating, encrypting or overwriting a saved value", async () => {
    const {ports} = fixture(); const first = await ensureManagedDatabaseCredentials(request,profile,ports);
    ports.entropy.mockClear();ports.secrets.createIfAbsent.mockClear();
    expect(await ensureManagedDatabaseCredentials(request,profile,ports)).toEqual(first);
    expect(ports.entropy).not.toHaveBeenCalled();expect(ports.secrets.createIfAbsent).not.toHaveBeenCalled();
  });
  it("converges concurrent writers without replacing the winning encrypted bundle", async () => {
    const {ports} = fixture(); const results = await Promise.all(Array.from({length:3},()=>ensureManagedDatabaseCredentials(request,profile,ports)));
    expect(results[1]).toEqual(results[0]);expect(results[2]).toEqual(results[0]);
  });
  it("checks authority before reading or generating credentials", async () => {
    const {ports} = fixture();ports.authorize.mockResolvedValue(false);
    await expect(ensureManagedDatabaseCredentials(request,profile,ports)).rejects.toThrow("credentials are unavailable");
    expect(ports.secrets.find).not.toHaveBeenCalled();expect(ports.entropy).not.toHaveBeenCalled();
  });
  it("fails on stale profile without overwriting the original", async () => {
    const {ports} = fixture();await ensureManagedDatabaseCredentials(request,profile,ports);ports.secrets.createIfAbsent.mockClear();
    await expect(ensureManagedDatabaseCredentials(request,{...profile,profileId:"approved-2"},ports)).rejects.toThrow("credentials are unavailable");
    expect(ports.secrets.createIfAbsent).not.toHaveBeenCalled();
  });
  it("does not persist if encryption or entropy fails", async () => {
    const {ports} = fixture();ports.cipher.encrypt=()=>{throw new Error("private-fixture")};
    await expect(ensureManagedDatabaseCredentials(request,profile,ports)).rejects.toThrow("credentials are unavailable");
    expect(ports.secrets.createIfAbsent).not.toHaveBeenCalled();
  });
  it("withholds creation when authority changes after preparation", async () => {
    const {ports}=fixture();ports.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
    await expect(ensureManagedDatabaseCredentials(request,profile,ports)).rejects.toThrow("credentials are unavailable");
    expect(ports.secrets.createIfAbsent).not.toHaveBeenCalled();
  });

});
