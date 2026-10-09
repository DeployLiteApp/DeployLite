import { describe, expect, it } from "vitest";
import { domainRouteClaimSchema, domainRouteHostnameSchema, domainRouteIntentSchema, domainRoutePreviewRequestSchema } from "./domain-route.js";

describe("domain route claim contract", () => {
  it("canonicalizes a DNS hostname and binds it to a project deployment", () => {
    expect(domainRouteIntentSchema.parse({
      schemaVersion: 1,
      projectId: "project-1",
      deploymentId: "deployment-1",
      domain: " App.Example.COM "
    })).toEqual({
      schemaVersion: 1,
      projectId: "project-1",
      deploymentId: "deployment-1",
      domain: "app.example.com"
    });
  });

  it("canonicalizes the preview request hostname and rejects unsafe host syntax", () => {
    expect(domainRoutePreviewRequestSchema.parse({ domain: " APP.EXAMPLE.COM ", deploymentId: "deployment-1" }))
      .toEqual({ domain: "app.example.com", deploymentId: "deployment-1" });
    expect(domainRoutePreviewRequestSchema.safeParse({ domain: "*.example.com", deploymentId: "deployment-1" }).success).toBe(false);
  });

  it("preserves an existing domain owner before any application target is attached", () => {
    const claim = { schemaVersion: 1, projectId: "project-1", deploymentId: null, domain: "app.example.com" };
    expect(domainRouteClaimSchema.safeParse(claim).success).toBe(true);
    expect(domainRouteIntentSchema.safeParse(claim).success).toBe(false);
  });

  it.each([
    ["single-label host", "localhost"],
    ["wildcard", "*.example.com"],
    ["trailing root dot", "app.example.com."],
    ["empty label", "app..example.com"],
    ["leading hyphen", "-app.example.com"],
    ["trailing hyphen", "app-.example.com"],
    ["overlong label", `${"a".repeat(64)}.example.com`]
  ])("rejects %s", (_label, domain) => {
    expect(domainRouteHostnameSchema.safeParse(domain).success).toBe(false);
  });

  it("rejects claim fields outside the versioned contract", () => {
    expect(domainRouteClaimSchema.safeParse({
      schemaVersion: 1,
      projectId: "project-1",
      deploymentId: "deployment-1",
      domain: "app.example.com",
      dnsRecord: "unexpected"
    }).success).toBe(false);
  });
});
