import { describe, expect, it, vi } from "vitest";
import { DockerProcessError, DockerProcessRunner, type SpawnedProcess } from "./docker-process-runner.js";

function fakeProcess() { const events = new Map<string, (...args: any[]) => void>(); const stdout = { on: vi.fn() }; const stderr = { on: vi.fn() }; const child = { stdout, stderr, pid: 42, once: vi.fn((event: string, callback: (...args: any[]) => void) => { events.set(event, callback); return child; }), kill: vi.fn() } as unknown as SpawnedProcess; return { child, events, stdout, stderr }; }
describe("DockerProcessRunner", () => {
  it("injects spawn with shell disabled and resolves bounded output", async () => { const fake = fakeProcess(); const spawn = vi.fn(() => fake.child); const runner = new DockerProcessRunner({ spawn }); const promise = runner.run(["docker", "version"], new AbortController().signal); expect(spawn).toHaveBeenCalledWith("docker", ["version"], { shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] }); fake.events.get("close")!(0, null); await expect(promise).resolves.toMatchObject({ exitCode: 0 }); });
  it("kills on caller cancellation and never invokes Docker", async () => { const fake = fakeProcess(); const controller = new AbortController(); const promise = new DockerProcessRunner({ spawn: () => fake.child }).run(["docker", "ps"], controller.signal); controller.abort(); await expect(promise).rejects.toMatchObject({ kind: "canceled" } satisfies Partial<DockerProcessError>); expect(fake.child.kill).toHaveBeenCalled(); });
  it("rejects empty argv before spawning", async () => { const spawn = vi.fn(); await expect(new DockerProcessRunner({ spawn }).run([], new AbortController().signal)).rejects.toBeInstanceOf(DockerProcessError); expect(spawn).not.toHaveBeenCalled(); });
});
