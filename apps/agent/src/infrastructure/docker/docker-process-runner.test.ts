import { describe, expect, it, vi } from "vitest";
import { DockerProcessError, DockerProcessRunner, type SpawnedProcess } from "./docker-process-runner.js";

function fakeProcess() { const events = new Map<string, (...args: any[]) => void>(); const stdout = { on: vi.fn() }; const stderr = { on: vi.fn() }; const child = { stdout, stderr,  once: vi.fn((event: string, callback: (...args: any[]) => void) => { events.set(event, callback); return child; }), kill: vi.fn() } as unknown as SpawnedProcess; return { child, events, stdout, stderr }; }
describe("DockerProcessRunner", () => {
  it("injects spawn with shell disabled and resolves bounded output", async () => { const fake = fakeProcess(); const spawn = vi.fn(() => fake.child); const runner = new DockerProcessRunner({ spawn }); const promise = runner.run(["docker", "version"], new AbortController().signal); expect(spawn).toHaveBeenCalledWith("docker", ["version"], { shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] }); fake.events.get("close")!(0, null); await expect(promise).resolves.toMatchObject({ exitCode: 0 }); });
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
