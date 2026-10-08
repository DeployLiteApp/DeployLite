import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposePreviewError, createComposePreview } from "./compose-preview.js";
const image = `registry.example.com/team/app@sha256:${"a".repeat(64)}`;
const policy = { policyVersion: "compose-yaml-test-1", trustedHosts: ["registry.example.com"], allowTags: false, allowDigests: true };
const json = JSON.stringify({ services: { web: { image, networks: ["backend"], volumes: [{ type: "volume", source: "data", target: "/data", read_only: true }], environment: { API_KEY: "${APP_API_KEY}" } }, worker: { image } }, networks: { backend: { internal: true } }, volumes: { data: {} } });
const yaml = `# Project document
services:
  worker:
    image: '${image}'
  web:
    environment:
      API_KEY: "\${APP_API_KEY}"
    volumes:
      - type: volume
        source: data
        target: /data
        read_only: true
    networks: [backend]
    image: ${image}
volumes:
  data: {}
networks:
  backend:
    internal: true
`;
const preview = (document: string, project = "project-1") => createComposePreview(document, project, policy);
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function rejects(document: string, code: string) {
  let observed: unknown;
  try { preview(document); } catch (error) { observed = error; }
  expect(observed).toBeInstanceOf(ComposePreviewError);
  expect(observed).toMatchObject({ code });
  expect(String(observed)).not.toContain("fixture_inline_secret");
}
describe("closed YAML1.2 Compose input", () => {
  it("matches JSON canonical intent including named mounts, implicit networks and unresolved references", () => {
    expect(() => preview(yaml)).not.toThrow();
    const plan = preview(yaml);
    expect(plan).toEqual(preview(json));
    expect(plan.executionAllowed).toBe(false);
    expect(plan.networks.map((v) => v.key)).toEqual(["backend", "default"]);
    expect(plan.services.find((v) => v.name === "web")?.secretRefs).toEqual([{ key: "API_KEY", secretRefId: "APP_API_KEY" }]);
  });
  it.each([yaml, "\uFEFF" + yaml, "%YAML 1.2\n---\n" + yaml, "---\n" + yaml + "...\n", yaml.replace("# Project document", "# a comment with fixture_inline_secret")])("canonicalizes supported markers, BOM and comments %#", (document) => {
    expect(() => preview(document)).not.toThrow();
    expect(preview(document).canonicalDocument).toBe(preview(json).canonicalDocument);
    expect(preview(document).configDigest).toBe(preview(json).configDigest);
    expect(JSON.stringify(preview(document))).not.toContain("fixture_inline_secret");
  });
  it("normalizes flow style, quotes, null resource definitions and explicit defaults", () => {
    expect(() => preview(`services: {web: {image: '${image}'}}`)).not.toThrow();
    const a = preview(`services: {web: {image: '${image}', networks: [backend]}}\nnetworks: {backend: null}\nvolumes: {data: null}\n`);
    const b = preview(JSON.stringify({ services: { web: { image, networks: ["backend"] } }, networks: { backend: { driver: "bridge", internal: false } }, volumes: { data: { driver: "local" } } }));
    expect(a).toEqual(b);
  });
  it("does not consult ambient secrets or write parser warnings/source excerpts", () => {
    vi.stubEnv("APP_API_KEY", "fixture_inline_secret");
    const warn = vi.spyOn(console, "warn"), error = vi.spyOn(console, "error");
    expect(() => preview(yaml)).not.toThrow();
    expect(JSON.stringify(preview(yaml))).not.toContain("fixture_inline_secret");
    rejects("services: !unknown fixture_inline_secret", "COMPOSE_INVALID_DOCUMENT");
    expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  });
  it("binds equivalent YAML and JSON plans to project and effective image policy", () => {
    expect(() => preview(yaml, "project-2")).not.toThrow();
    expect(preview(yaml, "project-2").configDigest).not.toBe(preview(yaml).configDigest);
    expect(createComposePreview(yaml, "project-1", { ...policy, policyVersion: "another-policy" }).configDigest).not.toBe(preview(yaml).configDigest);
  });
  it.each([
    ["literal secret", `services:\n  web:\n    image: ${image}\n    environment: {TOKEN: fixture_inline_secret}`, "COMPOSE_POLICY_REJECTED"],
    ["ambient/null secret", `services:\n  web:\n    image: ${image}\n    environment: {TOKEN: null}`, "COMPOSE_POLICY_REJECTED"],
    ["secret defaults", `services:\n  web:\n    image: ${image}\n    environment: {TOKEN: '\${TOKEN:-fixture_inline_secret}'}`, "COMPOSE_POLICY_REJECTED"],
    ["host bind", `services:\n  web:\n    image: ${image}\n    volumes: [{type: bind, source: /etc, target: /data}]`, "COMPOSE_POLICY_REJECTED"],
    ["external resource", `services: {web: {image: '${image}'}}\nnetworks: {foreign: {external: true}}`, "COMPOSE_POLICY_REJECTED"],
    ["include", `services: {web: {image: '${image}'}}\ninclude: /private/file.yml`, "COMPOSE_POLICY_REJECTED"],
    ["tag image", "services: {web: {image: 'registry.example.com/team/app:latest'}}", "COMPOSE_IMAGE_REJECTED"],
    ["missing resource", `services: {web: {image: '${image}', networks: [absent]}}`, "COMPOSE_UNDECLARED_RESOURCE"]
  ])("applies the same closed policy to YAML %s", (_name, document, code) => rejects(document, code));
  it.each([
    ["syntax", "services: [fixture_inline_secret"],
    ["multiple documents", yaml + "---\nservices: {}"],
    ["YAML1.1 directive", "%YAML 1.1\n---\n" + yaml],
    ["future YAML version", "%YAML 1.3\n---\n" + yaml],
    ["duplicate root key", `services: {web: {image: '${image}'}}\nservices: {worker: {image: '${image}'}}`],
    ["duplicate service property", `services:\n  web:\n    image: ${image}\n    image: ${image}`],
    ["duplicate JSON key", `{"services":{"web":{"image":"${image}","image":"${image}"}}}`],
    ["alias", `services: {web: &base {image: '${image}'}, worker: *base}`],
    ["cyclic alias", "services: &base {web: *base}"],
    ["merge key", `services: {web: {<<: {image: '${image}'}}}`],
    ["custom tag", "services: !unknown fixture_inline_secret"],
    ["explicit scalar tag", `services: {web: {image: !!str '${image}'}}`],
    ["binary tag", "services: !!binary Zml4dHVyZV9pbmxpbmVfc2VjcmV0"],
    ["complex key", `services: {[web]: {image: '${image}'}}`],
    ["deep nesting", "[".repeat(30) + "fixture_inline_secret" + "]".repeat(30)],
    ["AST node budget", "[" + Array(10_000).fill("x").join(",") + "]"],
    ["oversized bytes", "é".repeat(32_769)],
    ["empty document", "# fixture_inline_secret\n"]
  ])("rejects unsupported/ambiguous/bounded YAML or JSON %s without source reflection", (_name, document) => rejects(document, "COMPOSE_INVALID_DOCUMENT"));
});

describe("YAML bounds inside a mapping", () => {
  it.each([
    ["nested mapping content", `services: {web: {image: '${image}', environment: {TOKEN: ${"[".repeat(30)}fixture_inline_secret${"]".repeat(30)}}}}`],
    ["large mapping content", `services: {web: {image: '${image}', environment: {TOKEN: [${Array(10_000).fill("x").join(",")}]}}}`],
    ["unused anchor", `services: {web: &base {image: '${image}'}}`],
    ["custom tag directive", "%TAG !fixture! tag:example.test,2026:\n---\n" + yaml]
  ])("rejects unsupported %s before model conversion", (_name, document) => rejects(document, "COMPOSE_INVALID_DOCUMENT"));
});

describe("source-safe YAML diagnostics", () => {
  it.each(["LOG_STREAM", "LOG_TOKENS"])("fails closed when dependency diagnostic flags enable %s", (flag) => {
    vi.stubEnv(flag, "1");
    const outputs = [vi.spyOn(console, "dir").mockImplementation(() => {}), vi.spyOn(console, "log").mockImplementation(() => {}), vi.spyOn(console, "warn").mockImplementation(() => {}), vi.spyOn(console, "error").mockImplementation(() => {})];
    rejects(yaml, "COMPOSE_INVALID_DOCUMENT");
    for (const output of outputs) expect(output).not.toHaveBeenCalled();
  });
});
