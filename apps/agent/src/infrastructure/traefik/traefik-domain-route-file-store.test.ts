import { mkdtemp, readFile, readdir, rm, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustedPriorExecutionReceiptSchema, type DomainRouteIntentV1 } from "@deploylite/contracts";
import { domainRouteNetworkName } from "@deploylite/domain";
import { afterEach, describe, expect, it } from "vitest";
import { TraefikDomainRouteFileStore } from "./traefik-domain-route-file-store.js";

const route: DomainRouteIntentV1 = { schemaVersion: 1, projectId: "project-1", deploymentId: "dep_0123456789abcdef", domain: "app.example.test" };
const receipt = trustedPriorExecutionReceiptSchema.parse({
  schemaVersion: 1, candidateId: `${route.deploymentId}:candidate:deploy_0123456789abcdef`,
  deploymentId: route.deploymentId, projectId: route.projectId, snapshotOriginId: route.deploymentId,
  snapshotHash: "a".repeat(64), effectiveImageDigest: `sha256:${"b".repeat(64)}`, runtimeHost: "agent-1",
  container: `deploylite-active-${route.deploymentId}`, containerId: "c".repeat(64), hostPort: 43000,
  containerPort: 3000, network: domainRouteNetworkName(route.projectId)
});

const directories: string[] = [];
async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "deploylite-domain-routes-"));
  directories.push(value);
  return value;
}
afterEach(async () => { await Promise.all(directories.splice(0).map(value => rm(value, { recursive: true, force: true }))); });

describe("Traefik domain route file store", () => {
  it("atomically writes one generated config and treats an exact replay as a no-op", async () => {
    const root = await directory(), store = new TraefikDomainRouteFileStore(root);
    const input = { route, receipt, agentId: "agent-1" };
    const first = await store.apply(input);
    expect(first).toMatchObject({ state: "created", fileName: expect.stringMatching(/^domain-route-[a-f0-9]{24}\.yml$/) });
    const savedPath = join(root, first.fileName);
    const contents = await readFile(savedPath, "utf8");
    expect(contents).toContain("Host(`app.example.test`)");
    await expect(store.apply(input)).resolves.toMatchObject({ state: "unchanged", fileName: first.fileName, contentDigest: first.contentDigest });
    expect(await readFile(savedPath, "utf8")).toBe(contents);
    expect((await lstat(savedPath)).isSymbolicLink()).toBe(false);
  });

  it("replaces the same domain file atomically for a new receipt-bound deployment", async () => {
    const root = await directory(), store = new TraefikDomainRouteFileStore(root);
    await store.apply({ route, receipt, agentId: "agent-1" });
    const nextId = "dep_abcdef0123456789";
    const nextRoute = { ...route, deploymentId: nextId };
    const nextReceipt = { ...receipt, deploymentId: nextId, candidateId: `${nextId}:candidate:deploy_abcdef0123456789`, container: `deploylite-active-${nextId}` };
    const updated = await store.apply({ route: nextRoute, receipt: nextReceipt, agentId: "agent-1" });
    expect(updated.state).toBe("updated");
    expect(await readFile(join(root, updated.fileName), "utf8")).toContain(`http://${nextReceipt.container}:3000`);
  });

  it("restores an earlier receipt-bound target through the same atomic route file on rollback", async () => {
    const root = await directory(), store = new TraefikDomainRouteFileStore(root);
    const original = await store.apply({ route, receipt, agentId: "agent-1" });
    const nextId = "dep_abcdef0123456789";
    const nextRoute = { ...route, deploymentId: nextId };
    const nextReceipt = { ...receipt, deploymentId: nextId, candidateId: `${nextId}:candidate:deploy_abcdef0123456789`, container: `deploylite-active-${nextId}` };
    const newer = await store.apply({ route: nextRoute, receipt: nextReceipt, agentId: "agent-1" });
    expect(newer.state).toBe("updated");
    const rollback = await store.apply({ route, receipt, agentId: "agent-1" });
    expect(rollback).toMatchObject({ state: "updated", fileName: original.fileName, contentDigest: original.contentDigest });
    expect(await readFile(join(root, rollback.fileName), "utf8")).toContain(`http://${receipt.container}:3000`);
    expect(await readdir(root)).toEqual([original.fileName]);
  });

  it("fails closed when the configured provider directory is a symlink", async () => {
    const real = await directory(), parent = await directory(), alias = join(parent, "alias");
    await symlink(real, alias);
    await expect(new TraefikDomainRouteFileStore(alias).apply({ route, receipt, agentId: "agent-1" })).rejects.toThrow();
    expect(await lstat(real).then(value => value.isDirectory())).toBe(true);
    expect(await readdir(real)).toEqual([]);
  });
});
