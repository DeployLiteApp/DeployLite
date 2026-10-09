import { describe, expect, it } from "vitest";
import { createTransportPortPlan, TransportPortPlanError, type TransportPortPlanInput } from "./transport-port-plan.js";

const route = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, projectId: "project-1", deploymentId: "deployment-1", protocol: "tcp", publishedPort: 30_000, targetPort: 25565, ...overrides
});
function plan(input: Partial<TransportPortPlanInput> = {}) {
  return createTransportPortPlan({ desired: route(), currentClaims: [], ...input });
}
function expectPlanError(input: TransportPortPlanInput, code: TransportPortPlanError["code"]) {
  let caught: unknown;
  try { createTransportPortPlan(input); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(TransportPortPlanError);
  expect((caught as TransportPortPlanError).code).toBe(code);
}

describe("transport port preflight", () => {
  it("plans an unclaimed TCP port", () => {
    expect(plan()).toEqual({ action: "create", route: route(), previous: null });
  });

  it("treats an identical protocol, published port, target, and deployment as an idempotent no-op", () => {
    expect(plan({ currentClaims: [route()] })).toEqual({
      action: "no-op", route: route(), previous: { deploymentId: "deployment-1", targetPort: 25565 }
    });
  });

  it("allows TCP and UDP to claim the same numeric port independently", () => {
    expect(plan({ currentClaims: [route({ protocol: "udp", deploymentId: "deployment-2", targetPort: 19132 })] }))
      .toMatchObject({ action: "create", route: { protocol: "tcp", publishedPort: 30_000 } });
  });

  it("attaches a same-project claim that has no deployment", () => {
    expect(plan({ currentClaims: [route({ deploymentId: null })] })).toMatchObject({ action: "attach", previous: null });
  });

  it("previews a same-project retarget and preserves the prior target", () => {
    expect(plan({ desired: route({ deploymentId: "deployment-2", targetPort: 25566 }), currentClaims: [route()] })).toEqual({
      action: "retarget", route: route({ deploymentId: "deployment-2", targetPort: 25566 }),
      previous: { deploymentId: "deployment-1", targetPort: 25565 }
    });
  });

  it("fails closed on another project's claim for the same protocol and published port", () => {
    expectPlanError({ desired: route(), currentClaims: [route({ projectId: "project-2" })] }, "port-conflict");
  });

  it("fails closed on duplicate claims and malformed persisted claims", () => {
    expectPlanError({ desired: route(), currentClaims: [route(), route()] }, "ambiguous-claims");
    expectPlanError({ desired: route(), currentClaims: [{ ...route(), protocol: "sctp" }] }, "stored-claim-invalid");
  });

  it("fails closed when the desired protocol or port is invalid", () => {
    expectPlanError({ desired: route({ protocol: "SCTP" }), currentClaims: [] }, "desired-invalid");
    expectPlanError({ desired: route({ publishedPort: 65_536 }), currentClaims: [] }, "desired-invalid");
  });
});
