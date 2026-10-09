import { describe, expect, it } from "vitest";
import { createDomainRoutePlan, DomainRoutePlanError, type DomainRoutePlanInput } from "./domain-route-plan.js";

const route = (projectId = "project-1", deploymentId = "deployment-1", domain = "app.example.com") =>
  ({ schemaVersion: 1, projectId, deploymentId, domain });
function plan(input: Partial<DomainRoutePlanInput> = {}) {
  return createDomainRoutePlan({ desired: route(), currentClaims: [], ...input });
}
function expectPlanError(input: DomainRoutePlanInput, code: DomainRoutePlanError["code"]) {
  let caught: unknown;
  try { createDomainRoutePlan(input); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(DomainRoutePlanError);
  expect((caught as DomainRoutePlanError).code).toBe(code);
}

describe("domain route preflight", () => {
  it("plans creation when no current claim exists", () => {
    expect(plan()).toEqual({ action: "create", route: route(), previousDeploymentId: null });
  });

  it("treats the same project, domain, and deployment as an idempotent no-op", () => {
    expect(plan({ currentClaims: [route("project-1", "deployment-1", " APP.EXAMPLE.COM ")] }))
      .toEqual({ action: "no-op", route: route(), previousDeploymentId: "deployment-1" });
  });

  it("attaches a deployment to an existing domain owned by the same project", () => {
    expect(plan({ currentClaims: [{ schemaVersion: 1, projectId: "project-1", deploymentId: null, domain: "app.example.com" }] }))
      .toEqual({ action: "attach", route: route(), previousDeploymentId: null });
  });

  it("previews a same-project retarget and preserves the prior target", () => {
    expect(plan({
      desired: route("project-1", "deployment-2"),
      currentClaims: [route("project-1", "deployment-1")]
    })).toEqual({ action: "retarget", route: route("project-1", "deployment-2"), previousDeploymentId: "deployment-1" });
  });

  it("fails closed when a different project already owns the domain", () => {
    expectPlanError({ desired: route(), currentClaims: [route("project-2", "deployment-2")] }, "domain-conflict");
    expectPlanError({ desired: route(), currentClaims: [{ schemaVersion: 1, projectId: "project-2", deploymentId: null, domain: "app.example.com" }] }, "domain-conflict");
  });

  it("fails closed on duplicate or ambiguous current claims", () => {
    const existing = route();
    expectPlanError({ desired: route(), currentClaims: [existing, existing] }, "ambiguous-claims");
    expectPlanError({ desired: route(), currentClaims: [existing, route("project-2", "deployment-2")] }, "ambiguous-claims");
  });

  it("fails closed if the requested or persisted claim is invalid", () => {
    expectPlanError({ desired: route("project-1", "deployment-1", "*.example.com"), currentClaims: [] }, "desired-invalid");
    expectPlanError({ desired: route(), currentClaims: [{ ...route(), domain: "bad..example.com" }] }, "stored-claim-invalid");
  });
});
