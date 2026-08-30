import { describe, expect, it } from "vitest";
import { runDockerContractDryRun } from "./local-dry-run.js";

describe("current contract Docker dry-run", () => {
  it("is deterministic, digest-pinned, port-aware, redacted, and effect-free", async () => {
    const first = await runDockerContractDryRun();
    const second = await runDockerContractDryRun();
    expect(first).toEqual(second);
    expect(first).toMatchObject({ ok: true, snapshot: { reference: "registry.example.com/team/app@sha256:<digest>", runtimePort: 43123 }, result: { terminalStatus: "succeeded" }, effects: { processSpawned: false, networkAccessed: false, secretSourceRead: false, infrastructureMutated: false } });
    expect(JSON.stringify(first)).not.toMatch(/super-secret|fixture-token|docker\.sock/i);
    const argv = first.dockerArgv as readonly string[];
    expect(argv).not.toContain("--privileged");
    expect(argv).not.toContain("--volume");
    expect(argv).toContain("127.0.0.1:47539:43123");
  });

  it.each([["failure"], ["canceled"]] as const)("reports %s without forbidden effects", async (scenario) => {
    const result = await runDockerContractDryRun(scenario);
    expect(result).toMatchObject({ ok: false, scenario, effects: { processSpawned: false, networkAccessed: false, secretSourceRead: false, infrastructureMutated: false } });
    expect(JSON.stringify(result)).not.toMatch(/super-secret|fixture-token/i);
  });

  it("fails closed for an unresolved image tag", async () => {
    await expect(runDockerContractDryRun("invalid")).resolves.toMatchObject({ ok: false, scenario: "invalid" });
  });
});
