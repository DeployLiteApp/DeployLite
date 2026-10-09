import { describe, expect, it, vi } from "vitest";
import { DockerProcessError, DockerProcessRunner, type SpawnedProcess, type SpawnProcess } from "./docker-process-runner.js";
import { buildDockerTransportPortInspectArgv } from "./docker-cli-argv.js";

function fakeProcess() { const events = new Map<string, (...args: any[]) => void>(); const stdout = { on: vi.fn() }; const stderr = { on: vi.fn() }; const child = { stdout, stderr,  once: vi.fn((event: string, callback: (...args: any[]) => void) => { events.set(event, callback); return child; }), kill: vi.fn() } as unknown as SpawnedProcess; return { child, events, stdout, stderr }; }
describe("DockerProcessRunner", () => {
  it("injects spawn with shell disabled and resolves bounded output", async () => { const fake = fakeProcess(); const spawn = vi.fn(() => fake.child); const runner = new DockerProcessRunner({ spawn }); const promise = runner.run(["docker", "version"], new AbortController().signal); expect(spawn).toHaveBeenCalledWith("docker", ["version"], { shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] }); fake.events.get("close")!(0, null); await expect(promise).resolves.toMatchObject({ exitCode: 0 }); });
  it("passes a scoped environment to Docker without putting its values in argv or returned diagnostics", async () => {
    const fake = fakeProcess(), spawn = vi.fn<SpawnProcess>(() => fake.child), runner = new DockerProcessRunner({ spawn });
    const secret = "multiline-private-value\nsecond-line";
    const argv = ["docker", "container", "create", "--env", "API_KEY", "registry.example/app@sha256:" + "a".repeat(64)];
    const promise = runner.run(argv, new AbortController().signal, { API_KEY: secret });
    const spawned = spawn.mock.calls[0]!;
    expect(spawned[1]).toEqual(argv.slice(1)); expect(spawned[2].env?.API_KEY).toBe(secret); expect(JSON.stringify(spawned[1])).not.toContain(secret);
    fake.stdout.on.mock.calls[0]![1](`created ${secret}`); fake.stderr.on.mock.calls[0]![1](`failed ${secret}`); fake.events.get("close")!(0, null);
    const result = await promise; expect(result.stdout).not.toContain(secret); expect(result.stderr).not.toContain(secret);
  });
  it("rejects environment keys that could redirect Docker or its authenticated daemon before spawn", async () => {
    const spawn = vi.fn(); const runner = new DockerProcessRunner({ spawn });
    await expect(runner.run(["docker", "version"], new AbortController().signal, { DOCKER_HOST: "tcp://attacker.invalid" })).rejects.toMatchObject({ kind: "failed" });
    await expect(runner.run(["docker", "version"], new AbortController().signal, { PATH: "/tmp" })).rejects.toMatchObject({ kind: "failed" });
    expect(spawn).not.toHaveBeenCalled();
  });
  it("kills on caller cancellation and never invokes Docker", async () => { const fake = fakeProcess(); const controller = new AbortController(); const promise = new DockerProcessRunner({ spawn: () => fake.child }).run(["docker", "ps"], controller.signal); controller.abort(); await expect(promise).rejects.toMatchObject({ kind: "canceled" } satisfies Partial<DockerProcessError>); expect(fake.child.kill).toHaveBeenCalled(); });
  it("rejects empty argv before spawning", async () => { const spawn = vi.fn(); await expect(new DockerProcessRunner({ spawn }).run([], new AbortController().signal)).rejects.toBeInstanceOf(DockerProcessError); expect(spawn).not.toHaveBeenCalled(); });

  const digest = `sha256:${"a".repeat(64)}`, id = "b".repeat(64), image = `registry.example/p2@${digest}`;
  const imageFormat = '{"id":{{json .Id}},"os":{{json .Os}},"arch":{{json .Architecture}},"repoDigests":{{json .RepoDigests}},"healthType":{{if .Config.Healthcheck}}{{if .Config.Healthcheck.Test}}{{json (index .Config.Healthcheck.Test 0)}}{{else}}null{{end}}{{else}}null{{end}},"healthInterval":{{if .Config.Healthcheck}}{{json .Config.Healthcheck.Interval}}{{else}}0{{end}}}';
  it.each([
    { argv: ["docker", "image", "inspect", "--format", "{{json .Id}}", image], output: JSON.stringify(digest) },
    { argv: ["docker", "--config", "/owned/empty", "--host", "unix:///owned/docker.sock", "image", "inspect", "--format", imageFormat, image], output: JSON.stringify({ id: digest, os: "linux", arch: "amd64", repoDigests: [image], healthType: "CMD", healthInterval: 1_000_000_000 }) },
    { argv: ["docker", "run", "--detach", image], output: id },
    { argv: ["docker", "network", "create", "owned"], output: id },
    { argv: ["docker", "ps", "--format", "{{.ID}}|{{.Status}}"], output: `${id}|Up 2 seconds` },
    { argv: ["docker", "inspect", "--format", '{{index .Config.Labels "com.deploylite.owner"}}|{{index .Config.Labels "com.deploylite.deployment"}}|{{index .Config.Labels "com.deploylite.candidate"}}|{{index .Config.Labels "com.deploylite.image"}}', "owned"], output: `owner|dep|dep:candidate:cmd|${image}` }
  ])("retains validated Docker protocol identifiers for $argv", async ({ argv, output }) => {
    const fake = fakeProcess(), promise = new DockerProcessRunner({ spawn: () => fake.child }).run(argv, new AbortController().signal);
    fake.stdout.on.mock.calls[0]![1](output + "\n"); fake.stderr.on.mock.calls[0]![1]("token=private-token"); fake.events.get("close")!(0, null);
    await expect(promise).resolves.toEqual({ exitCode: 0, signal: null, stdout: output + "\n", stderr: "token=[REDACTED]" });
  });
  it("retains only the scoped transport container identity and bindings from Docker inspect", async () => {
    const value = { id, name: "/deploylite-active-dep-1", state: "running", running: true, health: "healthy", owner: "deploylite",
      projectId: "project-1", deploymentId: "dep-1", candidateId: "dep-1:candidate:cmd-1", effectiveImage: image,
      hostBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }] }, networkMode: "default" };
    const fake = fakeProcess(), argv = buildDockerTransportPortInspectArgv("deploylite-active-dep-1");
    const promise = new DockerProcessRunner({ spawn: () => fake.child }).run(argv, new AbortController().signal);
    fake.stdout.on.mock.calls[0]![1](JSON.stringify(value)); fake.events.get("close")!(0, null);
    await expect(promise).resolves.toMatchObject({ stdout: JSON.stringify(value), exitCode: 0 });
  });
  it("keeps unknown fields, secret nesting, unrecognized formats and failed process output redacted", async () => {
    const cases = [
      { argv: ["docker", "logs", "owned"], output: id, exit: 0 },
      { argv: ["docker", "image", "inspect", "--format", '{{json .Config.Env}}', image], output: JSON.stringify({ id: digest }), exit: 0 },
      { argv: ["docker", "image", "inspect", "--format", imageFormat, image], output: JSON.stringify({ id: digest, password: { id }, note: { id }, token: image }), exit: 0 },
      { argv: ["docker", "image", "inspect", "--format", "{{json .Id}}", image], output: JSON.stringify(digest), exit: 1 }
    ];
    for (const { argv, output, exit } of cases) {
      const fake = fakeProcess(), promise = new DockerProcessRunner({ spawn: () => fake.child }).run(argv, new AbortController().signal);
      fake.stdout.on.mock.calls[0]![1](output); fake.events.get("close")!(exit, null);
      const result = exit === 0 ? await promise : ((await promise.catch((error: DockerProcessError) => error)) as DockerProcessError).result!;
      expect(result.stdout).not.toContain(id); expect(result.stdout).not.toContain(`"token":"${image}"`);
      if (exit !== 0 || argv.includes("logs") || argv.includes('{{json .Config.Env}}')) expect(result.stdout).not.toContain(digest);
      else expect(JSON.parse(result.stdout)).toEqual({ id: digest, password: "[REDACTED]", note: { id: "[REDACTED]" }, token: "[REDACTED]" });
    }
  });
});
