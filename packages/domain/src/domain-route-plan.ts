import { domainRouteClaimSchema, domainRouteIntentSchema, type DomainRouteClaimV1, type DomainRouteIntentV1 } from "@deploylite/contracts";

export type DomainRouteClaimReader = Readonly<{
  available(): boolean;
  listClaims(): Promise<readonly DomainRouteClaimV1[]>;
}>;

export type DomainRoutePlanInput = Readonly<{
  desired: unknown;
  /** Complete cross-project claim set; project-filtering could hide an ownership conflict. */
  currentClaims: readonly unknown[];
}>;

export type DomainRoutePlanV1 = Readonly<{
  action: "create" | "attach" | "no-op" | "retarget";
  route: DomainRouteIntentV1;
  previousDeploymentId: string | null;
}>;

export type DomainRoutePlanErrorCode = "desired-invalid" | "stored-claim-invalid" | "domain-conflict" | "ambiguous-claims";

export class DomainRoutePlanError extends Error {
  constructor(readonly code: DomainRoutePlanErrorCode) {
    super("The domain route cannot be planned safely.");
    this.name = "DomainRoutePlanError";
  }
}

function parseDesired(raw: unknown): DomainRouteIntentV1 {
  const parsed = domainRouteIntentSchema.safeParse(raw);
  if (!parsed.success) throw new DomainRoutePlanError("desired-invalid");
  return parsed.data;
}

function parseStoredClaim(raw: unknown): DomainRouteClaimV1 {
  const parsed = domainRouteClaimSchema.safeParse(raw);
  if (!parsed.success) throw new DomainRoutePlanError("stored-claim-invalid");
  return parsed.data;
}

/**
 * Builds a preview from versioned route claims without mutating storage, DNS,
 * proxy configuration, or runtime state. Every stored claim is validated before
 * ownership is considered so malformed state cannot be silently bypassed.
 */
export function createDomainRoutePlan(input: DomainRoutePlanInput): DomainRoutePlanV1 {
  const desired = parseDesired(input.desired);
  const currentClaims = input.currentClaims.map(parseStoredClaim);
  const matchingClaims = currentClaims.filter(claim => claim.domain === desired.domain);
  if (matchingClaims.length > 1) throw new DomainRoutePlanError("ambiguous-claims");

  const existing = matchingClaims[0];
  if (!existing) {
    return { action: "create", route: desired, previousDeploymentId: null };
  }
  if (existing.projectId !== desired.projectId) {
    throw new DomainRoutePlanError("domain-conflict");
  }
  if (existing.deploymentId === null) {
    return { action: "attach", route: desired, previousDeploymentId: null };
  }
  if (existing.deploymentId === desired.deploymentId) {
    return { action: "no-op", route: desired, previousDeploymentId: existing.deploymentId };
  }
  return { action: "retarget", route: desired, previousDeploymentId: existing.deploymentId };
}
