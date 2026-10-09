import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createComposePreview } from "@deploylite/domain";
import { COMPOSE_REPLACEMENT_CANDIDATE_INSPECT_FORMAT, COMPOSE_REPLACEMENT_HEALTHCHECK_FORMAT, COMPOSE_REPLACEMENT_HEALTH_FORMAT } from "./docker-compose-resource-argv.js";
import { createDockerComposeVolumeReplacementDriver } from "./docker-compose-volume-replacement-driver.js";
import type { DockerCliRunner } from "./docker-cli-image-transport.js";
import type { ComposeVolumeAttachmentAgentCommandV1 } from "@deploylite/contracts";

const image = `registry.example.com/app@sha256:${"a".repeat(64)}`;
const preview = createComposePreview(JSON.stringify({ services: { api: { image, networks: ["backend"], volumes: [{ type: "volume", source: "data", target: "/data" }], environment: { TOKEN: "${APP_TOKEN}" } } }, networks: { backend: {} }, volumes: { data: {} } }), "project-1",
  { policyVersion: "compose-driver-test-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true });
const command = { commandId: "command-1", projectId: "project-1", service: "api", revisionId: "revision-new", configDigest: preview.configDigest,
  secretDigest: "b".repeat(64) } as ComposeVolumeAttachmentAgentCommandV1;
const secret = "transported-only-in-process-environment";
const containerId = "2".repeat(64);
const name = `dl-${createHash("sha256").update("command-1").digest("hex").slice(0, 32)}-vol-candidate`;
function fixture() {
  const calls: Array<{ argv: readonly string[]; environment?: Readonly<Record<string, string>> }> = [];
  const runner: DockerCliRunner = { run: vi.fn(async (argv, _signal, environment) => {
    calls.push({ argv: [...argv], ...(environment ? { environment } : {}) });
    const format = argv[argv.indexOf("--format") + 1];
    if (argv[1] === "run") return { exitCode: 0, signal: null, stdout: `${containerId}\n`, stderr: "" };
    if (format === COMPOSE_REPLACEMENT_CANDIDATE_INSPECT_FORMAT) return { exitCode: 0, signal: null, stdout: JSON.stringify({ id: containerId, name: `/${name}`, owner: "deploylite", projectId: "project-1", service: "api",
      commandId: "command-1", revisionId: "revision-new", configDigest: preview.configDigest, environmentDigest: command.secretDigest, image,
      running: true, networks: [preview.networks.find(value => value.key === "backend")!.runtimeName], mounts: [{ source: preview.volumes.find(value => value.key === "data")!.runtimeName, target: "/data", readOnly: false }] }), stderr: "" };
    if (format === COMPOSE_REPLACEMENT_HEALTHCHECK_FORMAT) return { exitCode: 0, signal: null, stdout: "yes|healthy", stderr: "" };
    if (format === COMPOSE_REPLACEMENT_HEALTH_FORMAT) return { exitCode: 0, signal: null, stdout: "healthy", stderr: "" };
    return { exitCode: 0, signal: null, stdout: "", stderr: "" };
  }) };
  return { calls, runner, driver: createDockerComposeVolumeReplacementDriver({ runner, owner: "deploylite", now: () => 1_000, sleep: async () => undefined }) };
}

describe("simulated Docker Compose volume replacement driver", () => {
  it("passes secret values only through the child environment and pins candidate labels and mounts", async () => {
    const f = fixture();
    const id = await f.driver.createCandidate({ name, command, preview, environment: { TOKEN: secret } }, new AbortController().signal);
    expect(id).toBe(containerId);
    const call = f.calls[0]!;
    expect(call.argv).toContain("--env"); expect(call.argv).toContain("TOKEN");
    expect(call.argv.join(" ")).not.toContain(secret);
    expect(call.environment).toEqual({ TOKEN: secret });
    expect(call.argv).toContain(`com.deploylite.compose.revision=revision-new`);
    expect(call.argv.join(" ")).toContain("type=volume,source=dl-");
    expect(call.argv).toEqual(expect.arrayContaining(["--cpus=0.5", "--memory=67108864", "--pids-limit=64", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges"]));
  });

  it("accepts only a declared image health check and an empty writable layer before replacement", async () => {
    const f = fixture();
    await expect(f.driver.inspectContainer("1".repeat(64), new AbortController().signal)).resolves.toEqual({ healthcheck: true, health: "healthy", writableLayerClean: true });
    expect(f.calls.map(value => value.argv.slice(0, 3))).toEqual([["docker", "container", "inspect"], ["docker", "container", "diff"]]);
  });

  it("never removes the named volume while removing its exact command-owned candidate", async () => {
    const f = fixture();
    await f.driver.removeCandidate(containerId, "command-1", new AbortController().signal);
    expect(f.calls.some(value => value.argv.includes("volume"))).toBe(false);
    expect(f.calls.at(-1)?.argv).toEqual(["docker", "container", "rm", "--force", containerId]);
  });
});
