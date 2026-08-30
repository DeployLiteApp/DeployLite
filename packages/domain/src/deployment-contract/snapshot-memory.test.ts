import { describe, expect, it } from "vitest";
import { InMemorySnapshotStore } from "./snapshot-memory.js";
import { createDeploymentSnapshot } from "@deploylite/contracts";
import { createSourceIntent } from "@deploylite/contracts";
const source = createSourceIntent({ sourceMode: "build", sourceRevision: "r", buildProfileId: "b" });
const snapshot = createDeploymentSnapshot({ deploymentId: "d", projectId: "p", source, configRevision: "c", runtimeRevision: "r", runtimePort: null, secretRefs: [], policyVersion: "p", schemaVersion: 1 }, { sha256: () => "a".repeat(64) });
describe("snapshot store", () => it("is immutable and hash keyed", () => { const store = new InMemorySnapshotStore(); const saved = store.save(snapshot); expect(store.get(snapshot.hash)).toEqual(saved); expect(() => store.save(snapshot)).toThrow("already exists"); (saved as { deploymentId: string }).deploymentId = "changed"; expect(store.get(snapshot.hash)?.deploymentId).toBe("d"); }));
