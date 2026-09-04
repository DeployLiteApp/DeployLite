import { describe, expect, it } from "vitest";
import { buildDockerInspectArgv, buildDockerRemoveArgv, buildDockerRenameArgv, buildDockerRunArgv } from "./docker-cli-argv.js";

const digest = `sha256:${"a".repeat(64)}`;
const candidate = { candidateId: "dep-1:candidate:cmd-1", deploymentId: "dep-1", effectiveImage: `registry.example.com/team/app@${digest}`, runtimePort: 3000 } as const;
const input = { candidate, containerName: "deploylite-candidate-cmd-1", hostPort: 43000, containerPort: 3000, owner: "agent-1", allowedNetworks: ["deploylite"] as const, networkName: "deploylite" };

describe("Docker CLI argv builders", () => {
  it("renders deterministic hardened argv without shell syntax or secrets", () => {
    const argv = buildDockerRunArgv(input);
    expect(argv).toEqual(["docker", "run", "--detach", "--name", "deploylite-candidate-cmd-1", "--label", "com.deploylite.owner=agent-1", "--label", "com.deploylite.deployment=dep-1", "--label", "com.deploylite.candidate=dep-1:candidate:cmd-1", "--label", `com.deploylite.image=registry.example.com/team/app@${digest}`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--restart=no", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev", "--tmpfs", "/var/cache/nginx:rw,noexec,nosuid,nodev", "--tmpfs", "/var/run:rw,noexec,nosuid,nodev", "--network", "deploylite", "--publish", "127.0.0.1:43000:3000", `registry.example.com/team/app@${digest}`]);
    expect(argv.join(" ")).not.toMatch(/[;&|`$()]|password|token|secret/i);
  });
  it.each([[{ ...input, owner: "bad owner" }], [{ ...input, hostPort: 80 }], [{ ...input, networkName: "outside" }], [{ ...input, candidate: { ...candidate, effectiveImage: "registry.example.com/team/app:latest" } }]])("rejects hostile input", (value) => expect(() => buildDockerRunArgv(value)).toThrow());
  it("builds only scoped lifecycle commands", () => { expect(buildDockerInspectArgv("deploylite-candidate-cmd-1")[0]).toBe("docker"); expect(buildDockerRenameArgv("deploylite-candidate-cmd-1", "deploylite-active-dep-1")).toEqual(["docker", "rename", "deploylite-candidate-cmd-1", "deploylite-active-dep-1"]); expect(buildDockerRemoveArgv("deploylite-candidate-cmd-1")).toEqual(["docker", "rm", "--force", "deploylite-candidate-cmd-1"]); });
  it("accepts production deployment identities while keeping argv tokens constrained", () => { const productionCandidate = { ...candidate, deploymentId: "dep_0123456789abcdef", candidateId: "dep_0123456789abcdef:candidate:command_1" }; const argv = buildDockerRunArgv({ ...input, candidate: productionCandidate, containerName: "deploylite-candidate-dep_0123456789abcdef-command_1" }); expect(argv.some((token) => token.includes("dep_0123456789abcdef"))).toBe(true); expect(argv.every((token) => !/[;&|`$()]/.test(token))).toBe(true); });
});
