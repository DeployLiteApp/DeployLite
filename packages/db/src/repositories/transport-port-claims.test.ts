import { describe, expect, it, vi } from "vitest";
import { DbTransportPortClaimReader, TransportPortClaimStoreError } from "./transport-port-claims.js";

function fakeDatabase(rows: unknown[]) {
  const orderBy = vi.fn(async () => rows);
  const leftJoin = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ leftJoin }));
  const select = vi.fn(() => ({ from }));
  return { db: { select }, select, from, leftJoin, orderBy };
}

describe("database transport-port claim reader", () => {
  it("reads globally scoped TCP and UDP claims, including unattached claims", async () => {
    const fixture = fakeDatabase([
      { protocol: "tcp", publishedPort: 30_000, projectId: "project-1", deploymentId: null, deploymentProjectId: null, targetPort: 25565 },
      { protocol: "udp", publishedPort: 30_000, projectId: "project-2", deploymentId: "deployment-2", deploymentProjectId: "project-2", targetPort: 19132 }
    ]);
    await expect(new DbTransportPortClaimReader(fixture.db as never).listClaims()).resolves.toEqual([
      { schemaVersion: 1, protocol: "tcp", publishedPort: 30_000, projectId: "project-1", deploymentId: null, targetPort: 25565 },
      { schemaVersion: 1, protocol: "udp", publishedPort: 30_000, projectId: "project-2", deploymentId: "deployment-2", targetPort: 19132 }
    ]);
    expect(fixture.select).toHaveBeenCalledOnce();
    expect(fixture.from).toHaveBeenCalledOnce();
    expect(fixture.leftJoin).toHaveBeenCalledOnce();
    expect(fixture.orderBy).toHaveBeenCalledOnce();
  });

  it("fails closed when the deployment belongs to another project", async () => {
    const fixture = fakeDatabase([
      { protocol: "tcp", publishedPort: 30_000, projectId: "project-1", deploymentId: "deployment-2", deploymentProjectId: "project-2", targetPort: 25565 }
    ]);
    await expect(new DbTransportPortClaimReader(fixture.db as never).listClaims()).rejects.toMatchObject({
      name: "TransportPortClaimStoreError", code: "stored-binding-invalid"
    });
  });

  it("fails closed on invalid stored protocol or port instead of hiding the claim", async () => {
    const fixture = fakeDatabase([
      { protocol: "sctp", publishedPort: 65_536, projectId: "project-1", deploymentId: null, deploymentProjectId: null, targetPort: 25565 }
    ]);
    await expect(new DbTransportPortClaimReader(fixture.db as never).listClaims()).rejects.toBeInstanceOf(TransportPortClaimStoreError);
  });
});
