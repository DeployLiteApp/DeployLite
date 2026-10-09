import { transportPortClaimSchema, transportPortIntentSchema, type TransportPortClaimV1, type TransportPortIntentV1 } from "@deploylite/contracts";

export type TransportPortPlanInput = Readonly<{
  desired: unknown;
  /** Complete cross-project claim set; filtering by project would hide an occupied listener. */
  currentClaims: readonly unknown[];
}>;

export type TransportPortClaimReader = Readonly<{
  available(): boolean;
  listClaims(): Promise<readonly TransportPortClaimV1[]>;
}>;

export type TransportPortPlanV1 = Readonly<{
  action: "create" | "attach" | "no-op" | "retarget";
  route: TransportPortIntentV1;
  previous: Readonly<{ deploymentId: string; targetPort: number }> | null;
}>;

export type TransportPortPlanErrorCode = "desired-invalid" | "stored-claim-invalid" | "port-conflict" | "ambiguous-claims";

export class TransportPortPlanError extends Error {
  constructor(readonly code: TransportPortPlanErrorCode) {
    super("The transport port cannot be planned safely.");
    this.name = "TransportPortPlanError";
  }
}

function parseDesired(raw: unknown): TransportPortIntentV1 {
  const parsed = transportPortIntentSchema.safeParse(raw);
  if (!parsed.success) throw new TransportPortPlanError("desired-invalid");
  return parsed.data;
}

function parseStoredClaim(raw: unknown): TransportPortClaimV1 {
  const parsed = transportPortClaimSchema.safeParse(raw);
  if (!parsed.success) throw new TransportPortPlanError("stored-claim-invalid");
  return parsed.data;
}

/** Plans a direct TCP/UDP port publication without touching storage or runtime state. */
export function createTransportPortPlan(input: TransportPortPlanInput): TransportPortPlanV1 {
  const desired = parseDesired(input.desired);
  const currentClaims = input.currentClaims.map(parseStoredClaim);
  const matchingClaims = currentClaims.filter(claim => claim.protocol === desired.protocol && claim.publishedPort === desired.publishedPort);
  if (matchingClaims.length > 1) throw new TransportPortPlanError("ambiguous-claims");

  const existing = matchingClaims[0];
  if (!existing) return { action: "create", route: desired, previous: null };
  if (existing.projectId !== desired.projectId) throw new TransportPortPlanError("port-conflict");
  if (existing.deploymentId === null) return { action: "attach", route: desired, previous: null };
  const previous = { deploymentId: existing.deploymentId, targetPort: existing.targetPort };
  if (existing.deploymentId === desired.deploymentId && existing.targetPort === desired.targetPort) {
    return { action: "no-op", route: desired, previous };
  }
  return { action: "retarget", route: desired, previous };
}
