import { expect, it } from "vitest";
import { managedDatabaseRuntimeAgentCommandSchema, managedDatabaseRuntimeReceiptSchema, managedDatabaseRuntimeReceiptQuerySchema, managedDatabaseRuntimeCachedReceiptSchema } from "./managed-database-runtime.js";
const digest = "a".repeat(64);
const authority = { schemaVersion: 1, projectId: "project-a", commandId: "command-a", action: "project.update", inputDigest: digest,
    projectLease: { projectId: "project-a", leaseId: "lease-a", fence: 1, expiresAt: 50000 } };
const command = { schemaVersion: 1, action: "database.runtime", operation: "database.runtime.apply", agentId: "agent-a", commandId: "command-a",
    projectId: "project-a", databaseId: "orders", engine: "postgres", profileId: "profile-a", planDigest: digest, environmentFingerprint: "b".repeat(32),
    idempotencyKey: "database-once", inputDigest: digest, sealedEnvironment: "encrypted-envelope", authority, lease: authority.projectLease,
    context: { requestId: "request-a", correlationId: "correlation-a" }, requiredCapabilities: ["database.runtime.v1"], timeoutMs: 5000, cancellationRequested: false };
it("binds database preparation to existing project update authority and sealed transport", () => {
    expect(managedDatabaseRuntimeAgentCommandSchema.parse(command)).toEqual(command);
});
it.each(["project", "command", "digest", "lease"])("rejects foreign %s execution authority", field => {
    const value = structuredClone(command);
    if (field === "project")
        value.authority.projectId = "foreign";
    if (field === "command")
        value.authority.commandId = "foreign";
    if (field === "digest")
        value.authority.inputDigest = "c".repeat(64);
    if (field === "lease")
        value.lease = { ...value.lease, fence: 2 };
    expect(managedDatabaseRuntimeAgentCommandSchema.safeParse(value).success).toBe(false);
});
it("forbids plaintext, caller commands and unsealed fields in the wire grammar", () => {
    for (const patch of [{ environment: { PASSWORD: "plaintext" } }, { command: ["sh", "-c", "unsafe"] }, { publishedPort: 5432 }, { image: "image:latest" },
        { sealedEnvironment: "" }, { timeoutMs: 60001 }, { requiredCapabilities: [] }, { databaseId: "../orders" }, { engine: "unknown" }])
        expect(managedDatabaseRuntimeAgentCommandSchema.safeParse({ ...command, ...patch }).success).toBe(false);
});
it("preserves original execution binding in cache-only queries without a secret envelope", () => {
    const { sealedEnvironment: _, cancellationRequested: __, ...query } = command;
    expect(managedDatabaseRuntimeReceiptQuerySchema.parse(query)).toEqual(query);
    expect(managedDatabaseRuntimeReceiptQuerySchema.safeParse(command).success).toBe(false);
});
const receipt = { schemaVersion: 1, action: "database.runtime", agentId: "agent-a", commandId: "command-a", projectId: "project-a", databaseId: "orders", engine: "postgres",
    inputDigest: digest, planDigest: digest, environmentFingerprint: "b".repeat(32), correlationId: "correlation-a", containerId: digest,
    imageId: "sha256:" + digest, volumeName: "dl-" + "a".repeat(32) + "-vol-db-orders", networkName: "dl-" + "a".repeat(32) + "-net-db-orders",
    networkId: "f".repeat(64), volumeCreatedAt: "2026-10-10T00:00:00Z", observedAt: 1000, status: "ready", health: "passed", storage: "verified", idempotent: false, redacted: true };
it("accepts only physically corroborated readiness with secret-safe metadata", () => {
    expect(managedDatabaseRuntimeReceiptSchema.parse(receipt)).toEqual(receipt);
    for (const patch of [{ health: "failed" }, { storage: "unverified" }, { containerId: null }, { imageId: null }, { password: "plaintext" }, { localPath: "/private/data" }])
        expect(managedDatabaseRuntimeReceiptSchema.safeParse({ ...receipt, ...patch }).success).toBe(false);
});
it("allows truthful failed receipts without claiming a ready database", () => {
    expect(managedDatabaseRuntimeReceiptSchema.safeParse({ ...receipt, status: "failed", health: "not-run", storage: "unverified", containerId: null, imageId: null }).success).toBe(true);
});
it("rejects a cached wrapper for another agent, command or correlation", () => {
    const cached = { schemaVersion: 1, action: "database.runtime", agentId: receipt.agentId, commandId: receipt.commandId, correlationId: receipt.correlationId, receipt };
    expect(managedDatabaseRuntimeCachedReceiptSchema.parse(cached)).toEqual(cached);
    for (const patch of [{ agentId: "foreign" }, { commandId: "foreign" }, { correlationId: "foreign" }])
        expect(managedDatabaseRuntimeCachedReceiptSchema.safeParse({ ...cached, ...patch }).success).toBe(false);
});
it("represents a missing original cached database receipt without authorizing execution", () => {
    const cached = {schemaVersion: 1, action: "database.runtime", agentId: "agent-a", commandId: "command-a", correlationId: "correlation-a", receipt: null};
    expect(managedDatabaseRuntimeCachedReceiptSchema.parse(cached)).toEqual(cached);
    expect(managedDatabaseRuntimeCachedReceiptSchema.safeParse({...cached, execute: true}).success).toBe(false);
});

it("rejects ready receipts missing the original persistent resource identities", () => {
  const { networkId: _, volumeCreatedAt: __, ...legacy } = receipt as Record<string, unknown>;
  expect(managedDatabaseRuntimeReceiptSchema.safeParse(legacy).success).toBe(false);
});
it("accepts the original resource pair and rejects malformed or absent identities", () => {
  const original = { ...receipt, networkId: "f".repeat(64), volumeCreatedAt: "2026-10-10T00:00:00Z" };
  expect(managedDatabaseRuntimeReceiptSchema.safeParse(original).success).toBe(true);
  for (const patch of [{ networkId: null }, { volumeCreatedAt: null }, { networkId: "short" }, { volumeCreatedAt: "invalid" }]) {
    expect(managedDatabaseRuntimeReceiptSchema.safeParse({ ...original, ...patch }).success).toBe(false);
  }
});
