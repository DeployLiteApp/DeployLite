import { describe, expect, it } from "vitest";
import { buildDockerActiveIdentityInspectArgv, buildDockerImageIdentityInspectArgv, buildDockerInspectArgv, buildDockerOwnedStopLookupArgv, buildDockerRemoveArgv, buildDockerRenameArgv, buildDockerRunArgv, buildDockerStopArgv } from "./docker-cli-argv.js";

const digest = `sha256:${"a".repeat(64)}`;
const candidate = { candidateId: "dep-1:candidate:cmd-1", projectId: "project-1", deploymentId: "dep-1", effectiveImage: `registry.example.com/team/app@${digest}`, runtimePort: 3000 } as const;
const input = { candidate, projectId: "project-1", containerName: "deploylite-candidate-cmd-1", hostPort: 43000, containerPort: 3000, owner: "agent-1", allowedNetworks: ["deploylite"] as const, networkName: "deploylite" };

describe("Docker CLI argv builders", () => {
  it("renders deterministic hardened argv without shell syntax or secrets", () => {
    const argv = buildDockerRunArgv(input);
    expect(argv).toEqual(["docker", "run", "--detach", "--name", "deploylite-candidate-cmd-1", "--label", "com.deploylite.owner=agent-1", "--label", "com.deploylite.project=project-1", "--label", "com.deploylite.deployment=dep-1", "--label", "com.deploylite.candidate=dep-1:candidate:cmd-1", "--label", `com.deploylite.image=registry.example.com/team/app@${digest}`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--restart=no", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev", "--tmpfs", "/var/cache/nginx:rw,noexec,nosuid,nodev", "--tmpfs", "/var/run:rw,noexec,nosuid,nodev", "--network", "deploylite", "--publish", "127.0.0.1:43000:3000", `registry.example.com/team/app@${digest}`]);
    expect(argv.join(" ")).not.toMatch(/[;&|`$()]|password|token|secret/i);
  });
  it.each([[{ ...input, owner: "bad owner" }], [{ ...input, hostPort: 80 }], [{ ...input, networkName: "outside" }], [{ ...input, candidate: { ...candidate, effectiveImage: "registry.example.com/team/app:latest" } }]])("rejects hostile input", (value) => expect(() => buildDockerRunArgv(value)).toThrow());
  it("builds only scoped lifecycle commands", () => { expect(buildDockerInspectArgv("deploylite-candidate-cmd-1")[0]).toBe("docker"); expect(buildDockerRenameArgv("deploylite-candidate-cmd-1", "deploylite-active-dep-1")).toEqual(["docker", "rename", "deploylite-candidate-cmd-1", "deploylite-active-dep-1"]); expect(buildDockerRemoveArgv("deploylite-candidate-cmd-1")).toEqual(["docker", "rm", "--force", "deploylite-candidate-cmd-1"]); });
  it("builds exact-label stop lookup and constrained stop argv", () => { const lookup = buildDockerOwnedStopLookupArgv({ owner: "agent-1", projectId: "project-1", deploymentId: "dep-1", candidateId: candidate.candidateId, effectiveImage: candidate.effectiveImage }); expect(lookup[0]).toBe("docker"); expect(lookup).toContain("label=com.deploylite.project=project-1"); expect(buildDockerStopArgv("0123456789ab")).toEqual(["docker", "stop", "--time", "10", "0123456789ab"]); expect(() => buildDockerStopArgv("deploylite-active-dep-1")).toThrow(); });
  it("accepts production deployment identities while keeping argv tokens constrained", () => { const productionCandidate = { ...candidate, deploymentId: "dep_0123456789abcdef", candidateId: "dep_0123456789abcdef:candidate:command_1" }; const argv = buildDockerRunArgv({ ...input, candidate: productionCandidate, containerName: "deploylite-candidate-dep_0123456789abcdef-command_1" }); expect(argv.some((token) => token.includes("dep_0123456789abcdef"))).toBe(true); expect(argv.every((token) => !/[;&|`$()]/.test(token))).toBe(true); });
});

describe("active identity inspection argv", () => {
  it("requests only selected container metadata and the digest image ID", () => {
    const argv = buildDockerActiveIdentityInspectArgv(input);
    expect(argv.slice(0, 4)).toEqual(["docker", "container", "inspect", "--format"]);
    expect(argv.at(-1)).toBe(input.containerName);
    for (const field of [".Id", ".Name", ".Image", ".State.Running", ".State.Health.Status", ".HostConfig.PortBindings", ".NetworkSettings.Ports", ".HostConfig.NetworkMode", ".NetworkSettings.Networks", "com.deploylite.owner", "com.deploylite.project", "com.deploylite.deployment", "com.deploylite.candidate", "com.deploylite.image"]) {
      expect(argv[4]).toContain(field);
    }
    expect(argv[4]).not.toMatch(/\.Config\.Env|json \.Config\.Labels|json \.(?:Config|NetworkSettings|State)\s*\}\}/u);
    expect(buildDockerImageIdentityInspectArgv(candidate.effectiveImage)).toEqual(["docker", "image", "inspect", "--format", "{{json .Id}}", candidate.effectiveImage]);
  });
  it.each([
    { ...input, containerName: "--help" }, { ...input, owner: "agent;run" },
    { ...input, projectId: undefined }, { ...input, projectId: "different" },
    { ...input, hostPort: 80 }, { ...input, networkName: "outside" },
    { ...input, candidate: { ...candidate, candidateId: "wrong:candidate:cmd-1" } }
  ])("rejects unsafe inspection identity before returning argv", (value) => {
    expect(() => buildDockerActiveIdentityInspectArgv(value)).toThrow();
  });
  it.each(["--help", "registry.example.com/team/app:latest", `${candidate.effectiveImage};docker run evil`])("rejects unsafe image selection %s", (image) => {
    expect(() => buildDockerImageIdentityInspectArgv(image)).toThrow();
  });
});

describe("INITIAL API container-name boundary", () => {
  it("accepts the actual generated candidate through run, health, ownership and rename", () => {
    const deploymentId = `dep_${"a".repeat(32)}`;
    const commandId = `deploy_${deploymentId}`;
    const candidateId = `${deploymentId}:candidate:${commandId}`;
    const name = `deploylite-candidate-${deploymentId}-${commandId}`;
    const active = `deploylite-active-${deploymentId}`;
    const value = { ...input, candidate: { ...candidate, deploymentId, candidateId }, containerName: name };
    let argv: readonly string[] | undefined; let failure: unknown;
    try { argv = buildDockerRunArgv(value); } catch (error) { failure = error; }
    expect(failure).toBeUndefined();
    expect(argv).toContain(name);
    expect(buildDockerInspectArgv(name).at(-1)).toBe(name);
    expect(buildDockerRenameArgv(name, active)).toEqual(["docker", "rename", name, active]);
    expect(buildDockerRemoveArgv(name).at(-1)).toBe(name);
  });

  it("accepts exactly 128 safe container characters", () => {
    let argv: readonly string[] | undefined; let failure: unknown;
    try { argv = buildDockerRunArgv({ ...input, containerName: "x".repeat(128) }); } catch (error) { failure = error; }
    expect(failure).toBeUndefined(); expect(argv).toContain("x".repeat(128));
  });

  it("keeps bounded container tokens and separate owner/project/network bounds", () => {
    for (const name of ["x".repeat(129), "--help", "bad name", "safe;exec"]) expect(() => buildDockerRunArgv({ ...input, containerName: name })).toThrow();
    expect(() => buildDockerRunArgv({ ...input, candidate: { ...candidate, deploymentId: "a".repeat(64), candidateId: `${"a".repeat(64)}:candidate:cmd` } })).toThrow();
    expect(() => buildDockerRunArgv({ ...input, owner: "a".repeat(64) })).toThrow();
    expect(() => buildDockerRunArgv({ ...input, projectId: "a".repeat(64) })).toThrow();
    expect(() => buildDockerRunArgv({ ...input, networkName: "a".repeat(64), allowedNetworks: ["a".repeat(64)] })).toThrow();
  });
});
