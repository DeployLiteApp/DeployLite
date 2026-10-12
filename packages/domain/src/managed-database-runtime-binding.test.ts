import { expect, it } from "vitest";
import { managedDatabaseRuntimeExecutionBinding, managedDatabaseRuntimeExecutionDigest } from "./managed-database-runtime-binding.js";
const input = { schemaVersion: 1, projectId: "project-a", databaseId: "orders", engine: "postgres", profileId: "profile-a", planDigest: "a".repeat(64), environmentFingerprint: "b".repeat(32) };
it("prepares an existing project update operation without private values", () => {
    expect(managedDatabaseRuntimeExecutionBinding(input)).toEqual({ ...input, action: "project.update", scope: { kind: "project", projectId: "project-a" }, operation: "database.runtime.apply" });
});
it.each([
    { projectId: "project-b" }, { databaseId: "users" }, { engine: "redis" }, { profileId: "profile-b" }, { planDigest: "c".repeat(64) }, { environmentFingerprint: "d".repeat(32) }
])("binds every runtime preparation dimension to the execution digest", patch => {
    expect(managedDatabaseRuntimeExecutionDigest({ ...input, ...patch })).not.toBe(managedDatabaseRuntimeExecutionDigest(input));
});
it("ignores object insertion order while preserving immutable preparation bytes", () => {
    expect(managedDatabaseRuntimeExecutionDigest(Object.fromEntries(Object.entries(input).reverse()))).toBe(managedDatabaseRuntimeExecutionDigest(input));
    expect(input).toEqual({ ...input, planDigest: "a".repeat(64) });
});
it("rejects plaintext, arbitrary images, malformed preparation and unknown scope", () => {
    for (const patch of [{ password: "secret" }, { image: "image:latest" }, { planDigest: "short" }, { environmentFingerprint: "short" }, { projectId: "../foreign" }])
        expect(() => managedDatabaseRuntimeExecutionBinding({ ...input, ...patch })).toThrow("Database runtime preparation is unavailable");
});
