import { asc, eq } from "drizzle-orm";
import { transportPortClaimSchema, type TransportPortClaimV1 } from "@deploylite/contracts";
import type { TransportPortClaimReader } from "@deploylite/domain";
import type { DeployLiteDb } from "../client.js";
import { deployments, transportPortClaims } from "../schema.js";

type TransportPortClaimReadRow = Readonly<{
  protocol: string;
  publishedPort: number;
  projectId: string;
  deploymentId: string | null;
  deploymentProjectId: string | null;
  targetPort: number;
}>;

export class TransportPortClaimStoreError extends Error {
  constructor(readonly code: "stored-claim-invalid" | "stored-binding-invalid") {
    super("Stored transport port state cannot be read safely.");
    this.name = "TransportPortClaimStoreError";
  }
}

/** Reads the complete global claim set so protocol/port conflicts cannot be hidden by project filtering. */
export class DbTransportPortClaimReader implements TransportPortClaimReader {
  constructor(private readonly db: DeployLiteDb) {}

  available(): boolean { return true; }

  async listClaims(): Promise<TransportPortClaimV1[]> {
    const rows: TransportPortClaimReadRow[] = await this.db.select({
      protocol: transportPortClaims.protocol,
      publishedPort: transportPortClaims.publishedPort,
      projectId: transportPortClaims.projectId,
      deploymentId: transportPortClaims.deploymentId,
      deploymentProjectId: deployments.projectId,
      targetPort: transportPortClaims.targetPort
    }).from(transportPortClaims).leftJoin(deployments, eq(transportPortClaims.deploymentId, deployments.id))
      .orderBy(asc(transportPortClaims.protocol), asc(transportPortClaims.publishedPort));

    return rows.map((row) => {
      if (row.deploymentId !== null && row.deploymentProjectId !== row.projectId) {
        throw new TransportPortClaimStoreError("stored-binding-invalid");
      }
      const claim = transportPortClaimSchema.safeParse({
        schemaVersion: 1,
        protocol: row.protocol,
        publishedPort: row.publishedPort,
        projectId: row.projectId,
        deploymentId: row.deploymentId,
        targetPort: row.targetPort
      });
      if (!claim.success) throw new TransportPortClaimStoreError("stored-claim-invalid");
      return claim.data;
    });
  }
}
