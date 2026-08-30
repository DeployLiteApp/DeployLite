import { describe, expect, it } from "vitest";
import { DockerOwnershipConflictError, DockerReconciliation } from "./docker-reconciliation.js";
describe("DockerReconciliation", () => {
  it("deterministically reuses ownership and scopes stale cleanup", () => { const r = new DockerReconciliation("agent-1"); const first = r.reconcile("dep-1", "cmd-1", []); expect(r.reconcile("dep-1", "cmd-1", [])).toEqual(first); expect(r.cleanupNames(r.reconcile("dep-1", "cmd-2", [{ name: "deploylite-candidate-dep-1-cmd-1", owner: "agent-1", deploymentId: "dep-1", hostPort: first.hostPort, running: false }, { name: "unrelated", owner: "agent-1", deploymentId: "other", hostPort: 1, running: false }]))).toEqual(["deploylite-candidate-dep-1-cmd-1"]); });
  it("rejects conflicting owners", () => { const r = new DockerReconciliation("agent-1"); expect(() => r.reconcile("dep-1", "cmd-1", [{ name: "deploylite-candidate-dep-1-cmd-1", owner: "other", deploymentId: "dep-1", hostPort: 43001, running: true }])).toThrow(DockerOwnershipConflictError); });
  it("rejects unsafe identifiers and never returns broad cleanup", () => { const r = new DockerReconciliation("agent-1"); expect(() => r.candidateName("dep/1", "cmd")).toThrow(); expect(r.cleanupNames({ candidateName: "x", hostPort: 43000, staleNames: ["all", "deploylite-candidate-dep-1-cmd"] })).toEqual(["deploylite-candidate-dep-1-cmd"]); });
});
