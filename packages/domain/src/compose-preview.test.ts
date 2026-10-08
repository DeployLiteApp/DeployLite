import { describe, expect, it } from "vitest";
import { createComposePreview } from "./compose-preview.js";

const image = `registry.example.com/team/app@sha256:${"a".repeat(64)}`;
const policy = { policyVersion: "compose-test-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const document = {
  services: {
    web: { image, networks: ["backend"], volumes: [{ type: "volume", source: "data", target: "/data", read_only: true }], environment: { API_KEY: "${APP_API_KEY}" } },
    worker: { image }
  },
  networks: { backend: { internal: true } },
  volumes: { data: {} }
};
const preview = (value: unknown, project = "project-1") => createComposePreview(JSON.stringify(value), project, policy);

describe("bounded Compose JSON preview", () => {
  it("plans explicit and implicit networks, named-volume attachments and unresolved secret references", () => {
    const result = preview(document);
    expect(result.executionAllowed).toBe(false);
    expect(result.services.map((s) => s.name)).toEqual(["web", "worker"]);
    expect(result.services[0]).toMatchObject({ image, networks: ["backend"], volumes: [{ source: "data", target: "/data", readOnly: true }], secretRefs: [{ key: "API_KEY", secretRefId: "APP_API_KEY" }] });
    expect(result.networks).toEqual([
      expect.objectContaining({ key: "backend", projectId: "project-1", driver: "bridge", internal: true, attachedServices: ["web"] }),
      expect.objectContaining({ key: "default", internal: false, attachedServices: ["worker"] })
    ]);
    expect(result.volumes).toEqual([expect.objectContaining({ key: "data", projectId: "project-1", driver: "local", attachedServices: ["web"] })]);
    expect(JSON.parse(result.canonicalDocument).services.web.environment.API_KEY).toBe("${APP_API_KEY}");
  });

  it("normalizes map order, defaults and unordered attachment lists without altering intent", () => {
    const a = preview({ services: { web: { image, networks: ["b", "a"], volumes: [{ type: "volume", source: "x", target: "/x" }, { type: "volume", source: "y", target: "/y" }] } }, networks: { b: {}, a: {} }, volumes: { x: {}, y: {} } });
    const b = preview({ volumes: { y: { driver: "local" }, x: {} }, networks: { a: { driver: "bridge", internal: false }, b: {} }, services: { web: { volumes: [{ target: "/y", source: "y", read_only: false, type: "volume" }, { target: "/x", source: "x", type: "volume" }], networks: ["a", "b"], image } } });
    expect(a.canonicalDocument).toBe(b.canonicalDocument);
    expect(a.configDigest).toBe(b.configDigest);
    expect(a.services[0]!.volumes.map((v) => v.target)).toEqual(["/x", "/y"]);
    expect(a.configDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(preview({ services: { web: { image } } }).networks).toHaveLength(1);
  });

  it("binds ownership and digest to the project and effective image policy", () => {
    const a = preview(document), b = preview(document, "project-2");
    expect(a.configDigest).not.toBe(b.configDigest);
    expect(a.volumes[0]!.runtimeName).not.toBe(b.volumes[0]!.runtimeName);
    expect(createComposePreview(JSON.stringify(document), "project-1", { ...policy, policyVersion: "compose-test-2" }).configDigest).not.toBe(a.configDigest);
  });

  it("owns detached input state so caller mutation cannot change a returned plan", () => {
    const input = structuredClone(document), result = preview(input), saved = JSON.stringify(result);
    input.services.web.volumes[0]!.target = "/changed";
    expect(JSON.stringify(result)).toBe(saved);
  });

  it.each([
    ["empty services", { services: {} }],
    ["literal secret", { services: { web: { image, environment: { API_KEY: "fixture_inline_secret" } } } }],
    ["ambient lookup", { services: { web: { image, environment: { API_KEY: null } } } }],
    ["secret default", { services: { web: { image, environment: { API_KEY: "${API_KEY:-fixture_inline_secret}" } } } }],
    ["host bind", { services: { web: { image, volumes: [{ type: "bind", source: "/etc", target: "/data" }] } } }],
    ["driver options bind", { services: { web: { image } }, volumes: { data: { driver_opts: { type: "none", o: "bind", device: "/etc" } } } }],
    ["foreign external network", { services: { web: { image } }, networks: { foreign: { external: true } } }],
    ["custom global volume name", { services: { web: { image } }, volumes: { data: { name: "foreign" } } }],
    ["privileged service", { services: { web: { image, privileged: true } } }],
    ["host network", { services: { web: { image, network_mode: "host" } } }],
    ["env file", { services: { web: { image, env_file: "/private/env" } } }],
    ["include file", { services: { web: { image } }, include: "/private/compose.yml" }],
    ["build", { services: { web: { build: "." } } }],
    ["tag", { services: { web: { image: "registry.example.com/team/app:latest" } } }],
    ["unknown registry", { services: { web: { image: image.replace("registry.example.com", "untrusted.example") } } }],
    ["undefined network", { services: { web: { image, networks: ["absent"] } } }],
    ["inherited resource name", { services: { web: { image, networks: ["constructor"] } } }],
    ["undefined volume", { services: { web: { image, volumes: [{ type: "volume", source: "absent", target: "/data" }] } } }],
    ["duplicate network attachment", { services: { web: { image, networks: ["a", "a"] } }, networks: { a: {} } }],
    ["overlapping volume mount", { services: { web: { image, volumes: [{ type: "volume", source: "data", target: "/data" }, { type: "volume", source: "data", target: "/data/sub" }] } }, volumes: { data: {} } }],
    ["traversing mount", { services: { web: { image, volumes: [{ type: "volume", source: "data", target: "/data/../proc" }] } }, volumes: { data: {} } }],
    ["devices mount", { services: { web: { image, volumes: [{ type: "volume", source: "data", target: "/dev" }] } }, volumes: { data: {} } }]
  ])("rejects %s without returning submitted input", (_name, input) => {
    expect(() => preview(input)).toThrow();
    try { preview(input); } catch (error) { expect(String(error)).not.toContain("fixture_inline_secret"); }
  });

  it.each(["{fixture_inline_secret", "services:\n  app:\n    image: fixture_inline_secret", " ", "x".repeat(65_537)])("rejects malformed, unsupported-format and oversized input without source excerpts", (input) => {
    expect(() => createComposePreview(input, "project-1", policy)).toThrow();
    try { createComposePreview(input, "project-1", policy); } catch (error) { expect(String(error)).not.toContain("fixture_inline_secret"); }
  });
});
