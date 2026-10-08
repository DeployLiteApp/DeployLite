import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { COMPOSE_NETWORK_INSPECT_FORMAT, COMPOSE_VOLUME_INSPECT_FORMAT, COMPOSE_CONTAINER_INSPECT_FORMAT } from "./docker-compose-resource-argv.js";
import { DockerProcessRunner, type SpawnProcess, type SpawnedProcess } from "./docker-process-runner.js";

const name = `dl-${"a".repeat(32)}-net-app`;
function run(words: string[], stdout: string) {
  const spawn: SpawnProcess = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    queueMicrotask(() => { child.stdout.write(stdout); child.emit("close", 0, null); }); return child as unknown as SpawnedProcess;
  };
  return new DockerProcessRunner({ spawn }).run(["docker", ...words], new AbortController().signal);
}
describe("closed Compose inspection process output", () => {
  it("preserves network physical ID and scoped generated name only under the exact format", async () => {
    const r = await run(["network", "inspect", "--format", COMPOSE_NETWORK_INSPECT_FORMAT, name], JSON.stringify({ id: "b".repeat(64), name, owner: "deploylite", password: "outside" }));
    expect(JSON.parse(r.stdout)).toMatchObject({ id: "b".repeat(64), name, password: "[REDACTED]" });
  });
  it("preserves volume name/creation identity while still redacting credential fields", async () => {
    const volume = name.replace("-net-", "-vol-");
    const r = await run(["volume", "inspect", "--format", COMPOSE_VOLUME_INSPECT_FORMAT, volume], JSON.stringify({ name: volume, createdAt: "2026-10-08T00:00:00Z", password: "outside" }));
    expect(JSON.parse(r.stdout)).toMatchObject({ name: volume, createdAt: "2026-10-08T00:00:00Z", password: "[REDACTED]" });
  });
  it("preserves nested observed network and named-volume identities without weakening generic redaction", async () => {
    const image = `registry.example.com/app@sha256:${"c".repeat(64)}`;
    const r = await run(["container", "inspect", "--format", COMPOSE_CONTAINER_INSPECT_FORMAT, "b".repeat(64)], JSON.stringify({ id: "b".repeat(64), effectiveImage: image, networks: [{ name, networkId: "d".repeat(64) }], mounts: [{ name: name.replace("-net-", "-vol-"), target: "/data" }], token: "outside" }));
    expect(JSON.parse(r.stdout)).toMatchObject({ id: "b".repeat(64), effectiveImage: image, networks: [{ name, networkId: "d".repeat(64) }], mounts: [{ name: name.replace("-net-", "-vol-"), target: "/data" }], token: "[REDACTED]" });
  });
  it("preserves full IDs for the explicit all-container ls alias", async () => {
    const r = await run(["container", "ls", "--all", "--no-trunc", "--format", "{{.ID}}"], "b".repeat(64) + "\n");
    expect(r.stdout).toBe("b".repeat(64) + "\n");
  });
  it("still redacts physical-looking values in arbitrary unrecognized templates", async () => {
    const r = await run(["volume", "inspect", "--format", "{{json .}}", "outside"], JSON.stringify({ name, id: "b".repeat(64), password: "secret=outside" }));
    expect(r.stdout).not.toContain("b".repeat(64)); expect(r.stdout).not.toContain("a".repeat(32)); expect(r.stdout).not.toContain("secret=outside");
  });
});
