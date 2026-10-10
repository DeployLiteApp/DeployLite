import { describe, expect, it, vi } from "vitest";
import { DbDomainRouteClaimReader, DomainRouteStoreError } from "./domain-routes.js";

function fakeDatabase(rows: unknown[]) {
  const orderBy = vi.fn(async () => rows);
  const leftJoin = vi.fn(() => ({ orderBy }));
  const from = vi.fn(() => ({ leftJoin }));
  const select = vi.fn(() => ({ from }));
  return { db: { select }, select, from, leftJoin, orderBy };
}

describe("database domain route claim reader", () => {
  it("reads canonical ownership claims, including existing P1 domains without an application target", async () => {
    const fixture = fakeDatabase([
      { projectId: "project-1", hostname: " App.Example.COM ", deploymentId: null, deploymentProjectId: null },
      { projectId: "project-2", hostname: "api.example.com", deploymentId: "deployment-2", deploymentProjectId: "project-2" }
    ]);
    const reader = new DbDomainRouteClaimReader(fixture.db as never);
    await expect(reader.listClaims()).resolves.toEqual([
      { schemaVersion: 1, projectId: "project-1", deploymentId: null, domain: "app.example.com" },
      { schemaVersion: 1, projectId: "project-2", deploymentId: "deployment-2", domain: "api.example.com" }
    ]);
    expect(fixture.select).toHaveBeenCalledOnce();
    expect(fixture.from).toHaveBeenCalledOnce();
    expect(fixture.leftJoin).toHaveBeenCalledOnce();
    expect(fixture.orderBy).toHaveBeenCalledOnce();
  });

  it("fails closed if an attached deployment belongs to another project", async () => {
    const fixture = fakeDatabase([
      { projectId: "project-1", hostname: "app.example.com", deploymentId: "deployment-2", deploymentProjectId: "project-2" }
    ]);
    await expect(new DbDomainRouteClaimReader(fixture.db as never).listClaims()).rejects.toMatchObject({
      name: "DomainRouteStoreError", code: "stored-binding-invalid"
    });
  });

  it("fails closed on malformed stored hostnames instead of skipping the global claim", async () => {
    const fixture = fakeDatabase([
      { projectId: "project-1", hostname: "bad..example.com", deploymentId: null, deploymentProjectId: null }
    ]);
    await expect(new DbDomainRouteClaimReader(fixture.db as never).listClaims()).rejects.toBeInstanceOf(DomainRouteStoreError);
  });
});
