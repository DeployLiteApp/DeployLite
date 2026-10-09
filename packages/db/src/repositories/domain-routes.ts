import { asc, eq } from "drizzle-orm";
import { domainRouteClaimSchema, type DomainRouteClaimV1 } from "@deploylite/contracts";
import type { DomainRouteClaimReader } from "@deploylite/domain";
import type { DeployLiteDb } from "../client.js";
import { deployments, domains } from "../schema.js";

type DomainRouteReadRow = Readonly<{
  projectId: string;
  hostname: string;
  deploymentId: string | null;
  deploymentProjectId: string | null;
}>;

export type DomainRouteStoreErrorCode = "stored-claim-invalid" | "stored-binding-invalid";

export class DomainRouteStoreError extends Error {
  constructor(readonly code: DomainRouteStoreErrorCode) {
    super("Stored domain route state cannot be read safely.");
    this.name = "DomainRouteStoreError";
  }
}

export class DbDomainRouteClaimReader implements DomainRouteClaimReader {
  constructor(private readonly db: DeployLiteDb) {}
  available(): boolean { return true; }

  async listClaims(): Promise<DomainRouteClaimV1[]> {
    const rows: DomainRouteReadRow[] = await this.db.select({
      projectId: domains.projectId,
      hostname: domains.hostname,
      deploymentId: domains.deploymentId,
      deploymentProjectId: deployments.projectId
    }).from(domains).leftJoin(deployments, eq(domains.deploymentId, deployments.id)).orderBy(asc(domains.hostname));

    return rows.map(row => {
      if (row.deploymentId !== null && row.deploymentProjectId !== row.projectId) {
        throw new DomainRouteStoreError("stored-binding-invalid");
      }
      const claim = domainRouteClaimSchema.safeParse({
        schemaVersion: 1,
        projectId: row.projectId,
        deploymentId: row.deploymentId,
        domain: row.hostname
      });
      if (!claim.success) throw new DomainRouteStoreError("stored-claim-invalid");
      return claim.data;
    });
  }
}
