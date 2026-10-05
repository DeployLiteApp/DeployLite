import { describe, expect, it, vi } from "vitest";
import { DockerCliImageTransport } from "./docker-cli-image-transport.js";
const digest = `sha256:${"a".repeat(64)}`; const candidate = { candidateId: "dep-1:candidate:cmd-1", projectId: "project-1", deploymentId: "dep-1", effectiveImage: `registry.example.com/team/app@${digest}`, runtimePort: 3000 } as const;
describe("DockerCliImageTransport", () => {
  it("delegates lifecycle operations to safe argv and does not orchestrate", async () => {
    const run = vi.fn(async (argv: readonly string[]) => ({
      exitCode: 0, signal: null,
      stdout: argv[1] === "container" && argv[2] === "inspect" ? JSON.stringify(selectedMetadata())
        : argv[1] === "image" && argv[2] === "inspect" ? JSON.stringify(observedImageId)
        : argv[1] === "inspect" ? (argv[3]?.includes("Labels") ? `agent-1|dep-1|dep-1:candidate:cmd-1|${candidate.effectiveImage}` : "healthy") : "",
      stderr: ""
    }));
    const transport = new DockerCliImageTransport({ runner: { run }, owner: "agent-1", hostPort: 43000, containerPort: 3000, allowedNetworks: [] });
    const controller = new AbortController();
    await transport.startCandidate(candidate, controller.signal);
    expect(run.mock.calls[0]?.[0]).toContain("--read-only");
    expect(run.mock.calls[0]?.[0]).not.toContain("--privileged");
    expect(await transport.checkHealth(candidate, controller.signal)).toBe(true);
    await transport.promoteCandidate(candidate, controller.signal);
    await transport.discardCandidate(candidate, controller.signal);
    expect(run).toHaveBeenCalledTimes(8);
  });
  it("fails closed when ownership labels do not match", async () => { const run = vi.fn(async (argv: readonly string[]) => ({ exitCode: 0, signal: null, stdout: argv[3]?.includes("Labels") ? `other|dep-1|dep-1:candidate:cmd-1|${candidate.effectiveImage}` : "", stderr: "" })); const transport = new DockerCliImageTransport({ runner: { run }, owner: "agent-1", hostPort: 43000, containerPort: 3000, allowedNetworks: [] }); await expect(transport.discardCandidate(candidate, new AbortController().signal)).rejects.toMatchObject({ name: "DockerCliTransportFailure" }); expect(run).toHaveBeenCalledTimes(1); });
  it("reports non-zero exits as typed failures", async () => { const transport = new DockerCliImageTransport({ runner: { run: vi.fn(async () => ({ exitCode: 1, signal: null, stdout: "", stderr: "password=hidden" })) }, owner: "agent-1", hostPort: 43000, containerPort: 3000, allowedNetworks: [] }); await expect(transport.promoteCandidate(candidate, new AbortController().signal)).rejects.toMatchObject({ name: "DockerCliTransportFailure" }); });
  it("invokes the runner for production-shaped deployment identities", async () => { const run = vi.fn(async (argv: readonly string[]) => ({ exitCode: 0, signal: null, stdout: argv[1] === "inspect" ? "healthy" : "", stderr: "" })); const productionCandidate = { ...candidate, deploymentId: "dep_0123456789abcdef", candidateId: "dep_0123456789abcdef:candidate:command_1" }; const transport = new DockerCliImageTransport({ runner: { run }, owner: "agent_1", hostPort: 43000, containerPort: 3000, allowedNetworks: [] }); await transport.startCandidate(productionCandidate, new AbortController().signal); await transport.checkHealth(productionCandidate, new AbortController().signal); expect(run).toHaveBeenCalledTimes(2); expect(run.mock.calls[0]?.[0].some((token) => token.includes("dep_0123456789abcdef"))).toBe(true); });
  it("requires the exact proven restore identity", async () => { const run = vi.fn(async () => ({ exitCode: 0, signal: null, stdout: "agent-1|project-1|dep-1|dep-1:candidate:prior|registry.example.com/other@sha256:" + "b".repeat(64) + "|running|healthy", stderr: "" })); const transport = new DockerCliImageTransport({ runner: { run }, owner: "agent-1", hostPort: 43000, containerPort: 3000, allowedNetworks: [] }); const receipt = { deploymentId: "dep-1", projectId: "project-1", candidateId: "dep-1:candidate:prior", effectiveImage: candidate.effectiveImage, runtimePort: 3000, runtimeConfig: { hostPort: 43000, containerPort: 3000 }, health: "passed" as const, terminalStatus: "succeeded" as const, rollback: { target: null, result: "not-required" as const }, proven: true as const }; await expect(transport.restorePrior(receipt, new AbortController().signal)).rejects.toMatchObject({ name: "DockerCliTransportFailure" }); expect(run).toHaveBeenCalledTimes(1); });
  it.each([["running", "healthy", "accept"], ["exited", "", "restart"], ["running", "unhealthy", "reject"]] as const)("restores only owned healthy prior state (%s/%s)", async (state, health, action) => { const run = vi.fn(async (argv: readonly string[]) => ({ exitCode: 0, signal: null, stdout: argv[1] === "inspect" && argv[3]?.includes("Labels") ? `agent-1|project-1|dep-1|dep-1:candidate:prior|${candidate.effectiveImage}|${state}|${health}` : argv[1] === "inspect" ? "healthy" : "", stderr: "" })); const transport = new DockerCliImageTransport({ runner: { run }, owner: "agent-1", hostPort: 43000, containerPort: 3000, allowedNetworks: [] }); const receipt = { deploymentId: "dep-1", projectId: "project-1", candidateId: "dep-1:candidate:prior", effectiveImage: candidate.effectiveImage, runtimePort: 3000, runtimeConfig: { hostPort: 43000, containerPort: 3000 }, health: "passed" as const, terminalStatus: "succeeded" as const, rollback: { target: null, result: "not-required" as const }, proven: true as const }; if (action === "reject") await expect(transport.restorePrior(receipt, new AbortController().signal)).rejects.toMatchObject({ name: "DockerCliTransportFailure" }); else await expect(transport.restorePrior(receipt, new AbortController().signal)).resolves.toBeUndefined(); expect(run.mock.calls.some(([argv]) => argv[1] === "start")).toBe(action === "restart"); });
  it.each([["Up 2 seconds", "stopped"], ["Exited (0) 1 second ago", "already-stopped"], ["", "absent"]] as const)("stops only the exact owned record (%s)", async (state, expected) => { const run = vi.fn(async (argv: readonly string[]) => ({ exitCode: 0, signal: null, stdout: argv[1] === "ps" ? (state ? `0123456789ab|${state}` : "") : argv[1] === "inspect" ? `agent-1|project-1|dep-1|${candidate.candidateId}|${candidate.effectiveImage}|${state.startsWith("Up") ? "running" : "exited"}` : "", stderr: "" })); const transport = new DockerCliImageTransport({ runner: { run }, owner: "agent-1", hostPort: 43000, containerPort: 3000, allowedNetworks: [] }); await expect(transport.stopOwned({ projectId: "project-1", deploymentId: "dep-1", candidateId: candidate.candidateId, effectiveImage: candidate.effectiveImage }, new AbortController().signal, { assertValid: async () => {} })).resolves.toBe(expected); expect(run.mock.calls.some(([argv]) => argv[1] === "stop")).toBe(expected === "stopped"); });
  it("returns classified Docker failure without leaking diagnostics", async () => { const run = vi.fn(async (argv: readonly string[]) => ({ exitCode: argv[1] === "ps" ? 0 : 1, signal: null, stdout: argv[1] === "ps" ? "0123456789ab|Up 1 second" : "", stderr: "password=hidden" })); const transport = new DockerCliImageTransport({ runner: { run }, owner: "agent-1", hostPort: 43000, containerPort: 3000, allowedNetworks: [] }); await expect(transport.stopOwned({ projectId: "project-1", deploymentId: "dep-1", candidateId: candidate.candidateId, effectiveImage: candidate.effectiveImage }, new AbortController().signal, { assertValid: async () => {} })).resolves.toBe("failed"); });
});

const observedId = "1".repeat(64);
const observedImageId = `sha256:${"b".repeat(64)}`;
const attachment = { networkId: "2".repeat(64), endpointId: "3".repeat(64) };
const selectedMetadata = () => ({
  id: observedId, name: "/deploylite-active-dep-1", imageId: observedImageId,
  owner: "agent-1", projectId: "project-1", deploymentId: "dep-1",
  candidateId: candidate.candidateId, effectiveImage: candidate.effectiveImage,
  running: true, health: "healthy", networkMode: "default", networks: { bridge: { ...attachment } },
  hostBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }] },
  portBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }] }
});
const observationHarness = (metadata: unknown = selectedMetadata(), imageId: unknown = observedImageId, networkName?: string) => {
  const run = vi.fn(async (argv: readonly string[]) => ({
    exitCode: 0, signal: null,
    stdout: JSON.stringify(argv[1] === "image" ? imageId : metadata), stderr: ""
  }));
  const transport = new DockerCliImageTransport({ runner: { run }, owner: "agent-1", hostPort: 43000, containerPort: 3000, allowedNetworks: ["deploylite"], networkName });
  return { run, transport };
};

describe("active identity observation", () => {
  it("returns actual inspected IDs, labels and runtime configuration using only inspect", async () => {
    const { transport, run } = observationHarness();
    const result = await transport.observeActiveIdentity(candidate, new AbortController().signal);
    expect(result).toEqual({
      container: "deploylite-active-dep-1", containerId: observedId, imageId: observedImageId,
      owner: "agent-1", projectId: "project-1", deploymentId: "dep-1", candidateId: candidate.candidateId,
      effectiveImage: candidate.effectiveImage, running: true, health: "healthy",
      hostPort: 43000, containerPort: 3000, network: null
    });
    expect(run.mock.calls.map(([argv]) => argv.slice(0, 3))).toEqual([["docker", "container", "inspect"], ["docker", "image", "inspect"]]);
    expect(run.mock.calls[0]?.[0].at(-1)).toBe("deploylite-active-dep-1");
    expect(run.mock.calls[1]?.[0].at(-1)).toBe(candidate.effectiveImage);
  });
  it("observes a distinct actual container ID and explicit allowed network without sharing references", async () => {
    const metadata = { ...selectedMetadata(), id: "4".repeat(64), networkMode: "deploylite", networks: { deploylite: { ...attachment } } };
    const { transport } = observationHarness(metadata, observedImageId, "deploylite");
    const result = await transport.observeActiveIdentity({ ...candidate, networkName: "deploylite" }, new AbortController().signal);
    expect(result).toMatchObject({ containerId: "4".repeat(64), network: "deploylite" });
    metadata.id = "5".repeat(64);
    expect(result.containerId).toBe("4".repeat(64));
    expect(() => Object.assign(result, { containerId: "mutated" })).toThrow();
  });
  const invalidMetadata: readonly [string, unknown][] = [
    ...["owner", "projectId", "deploymentId", "candidateId", "effectiveImage"].map((field): [string, unknown] => [field, { ...selectedMetadata(), [field]: "foreign" }]),
    ["missing project", { ...selectedMetadata(), projectId: undefined }],
    ["wrong active name", { ...selectedMetadata(), name: "/deploylite-candidate-dep-1-cmd-1" }],
    ["logical ID", { ...selectedMetadata(), id: candidate.candidateId }],
    ["stopped", { ...selectedMetadata(), running: false }],
    ["unhealthy", { ...selectedMetadata(), health: "unhealthy" }],
    ["no health check", { ...selectedMetadata(), health: null }],
    ["running is not health", { ...selectedMetadata(), health: "running" }],
    ["actual image differs although requested image label matches", { ...selectedMetadata(), imageId: `sha256:${"c".repeat(64)}` }],
    ["nonloopback port", { ...selectedMetadata(), portBindings: { "3000/tcp": [{ HostIp: "0.0.0.0", HostPort: "43000" }] } }],
    ["wrong port", { ...selectedMetadata(), portBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43001" }] } }],
    ["wrong container port", { ...selectedMetadata(), portBindings: { "3001/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }] } }],
    ["multiple bindings", { ...selectedMetadata(), portBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43000" }, { HostIp: "127.0.0.1", HostPort: "43001" }] } }],
    ["unexpected exposed port", { ...selectedMetadata(), portBindings: { ...selectedMetadata().portBindings, "9999/tcp": [] } }],
    ["configured bindings differ", { ...selectedMetadata(), hostBindings: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "43001" }] } }],
    ["missing configured bindings", { ...selectedMetadata(), hostBindings: null }],
    ["unexpected network mode", { ...selectedMetadata(), networkMode: "host" }],
    ["wrong default attachment", { ...selectedMetadata(), networks: { foreign: attachment } }],
    ["multiple networks", { ...selectedMetadata(), networks: { bridge: attachment, foreign: attachment } }],
    ["missing attachment", { ...selectedMetadata(), networks: {} }],
    ["missing endpoint", { ...selectedMetadata(), networks: { bridge: { ...attachment, endpointId: "" } } }],
    ["malformed object", { bad: "password=hidden" }], ["missing object", null],
    ["unexpected inspection dump", { ...selectedMetadata(), Config: { Env: ["password=hidden"] } }]
  ];
  it.each(invalidMetadata)("fails closed for %s without lifecycle commands or diagnostics", async (_reason, metadata) => {
    const { transport, run } = observationHarness(metadata);
    await expect(transport.observeActiveIdentity(candidate, new AbortController().signal)).rejects.toMatchObject({ name: "DockerCliTransportFailure", operation: "observe", exit: undefined });
    expect(run.mock.calls.every(([argv]) => argv[1] === "container" || argv[1] === "image")).toBe(true);
  });
  it.each([null, "not-an-image-id", `sha256:${"c".repeat(64)}`])("rejects mismatched or missing digest-image inspection %s", async (imageId) => {
    const { transport } = observationHarness(selectedMetadata(), imageId);
    await expect(transport.observeActiveIdentity(candidate, new AbortController().signal)).rejects.toMatchObject({ name: "DockerCliTransportFailure", operation: "observe" });
  });
  it.each(["container", "image", "throw", "malformed"])("redacts failed %s inspection", async (failure) => {
    const { transport, run } = observationHarness();
    run.mockImplementation(async (argv) => {
      if (failure === "throw") throw new Error("password=hidden");
      return { exitCode: argv[1] === failure ? 1 : 0, signal: null, stdout: failure === "malformed" ? "password=hidden" : JSON.stringify(argv[1] === "image" ? observedImageId : selectedMetadata()), stderr: "password=hidden" };
    });
    const error = await transport.observeActiveIdentity(candidate, new AbortController().signal).catch((value: unknown) => value);
    expect(error).toMatchObject({ name: "DockerCliTransportFailure", operation: "observe", exit: undefined });
    expect(String(error) + JSON.stringify(error)).not.toContain("password=hidden");
  });
  it.each(["before", "container", "image"])("honors cancellation %s inspection", async (stage) => {
    const controller = new AbortController();
    const { transport, run } = observationHarness();
    if (stage === "before") controller.abort();
    else run.mockImplementation(async (argv) => {
      if (argv[1] === stage) controller.abort();
      return { exitCode: 0, signal: null, stdout: JSON.stringify(argv[1] === "image" ? observedImageId : selectedMetadata()), stderr: "" };
    });
    await expect(transport.observeActiveIdentity(candidate, controller.signal)).rejects.toMatchObject({ name: "DockerCliTransportCanceled", operation: "observe" });
    expect(run).toHaveBeenCalledTimes(stage === "before" ? 0 : stage === "container" ? 1 : 2);
  });
  it.each([{ ...candidate, runtimePort: 3001 }, { ...candidate, networkName: "deploylite" }])("rejects requested runtime configuration mismatches before inspection", async (value) => {
    const { transport, run } = observationHarness();
    await expect(transport.observeActiveIdentity(value, new AbortController().signal)).rejects.toMatchObject({ name: "DockerCliTransportFailure", operation: "observe" });
    expect(run).not.toHaveBeenCalled();
  });
  it("captures request and option values before awaiting the runner", async () => {
    const mutableCandidate = { ...candidate, effectiveImage: String(candidate.effectiveImage) };
    const options = { owner: "agent-1", hostPort: 43000, containerPort: 3000, allowedNetworks: [] };
    const { run } = observationHarness();
    const mutableOptions = { ...options, runner: { run } };
    run.mockImplementation(async (argv) => {
      mutableCandidate.effectiveImage = `registry.example.com/team/other@sha256:${"d".repeat(64)}`;
      mutableOptions.hostPort = 43001;
      return { exitCode: 0, signal: null, stdout: JSON.stringify(argv[1] === "image" ? observedImageId : selectedMetadata()), stderr: "" };
    });
    const result = await new DockerCliImageTransport(mutableOptions).observeActiveIdentity(mutableCandidate, new AbortController().signal);
    expect(result.hostPort).toBe(43000);
    expect(run.mock.calls[1]?.[0].at(-1)).toBe(candidate.effectiveImage);
  });
});

const promotedObservation = {
  container: "deploylite-active-dep-1", containerId: observedId, imageId: observedImageId,
  owner: "agent-1", projectId: "project-1", deploymentId: "dep-1", candidateId: candidate.candidateId,
  effectiveImage: candidate.effectiveImage, running: true, health: "healthy",
  hostPort: 43000, containerPort: 3000, network: null
};
const promotionHarness = (metadata: unknown = selectedMetadata()) => {
  const harness = observationHarness(metadata);
  harness.run.mockImplementation(async (argv) => ({
    exitCode: 0, signal: null,
    stdout: argv[1] === "inspect" ? `agent-1|dep-1|${candidate.candidateId}|${candidate.effectiveImage}`
      : argv[1] === "container" ? JSON.stringify(metadata)
      : argv[1] === "image" ? JSON.stringify(observedImageId) : "",
    stderr: ""
  }));
  return harness;
};

describe("promotion returns active identity observation", () => {
  it.each(["inspect", "rename"])("captures candidate identity before awaiting %s", async (stage) => {
    const mutableCandidate = { ...candidate };
    const { transport, run } = promotionHarness();
    const originalRun = run.getMockImplementation()!;
    run.mockImplementation(async (argv) => {
      if (argv[1] === stage) Object.assign(mutableCandidate, {
        deploymentId: "foreign", projectId: "foreign", candidateId: "foreign:candidate:other",
        effectiveImage: `registry.example.com/team/other@sha256:${"d".repeat(64)}`
      });
      return originalRun(argv);
    });
    await expect(transport.promoteCandidate(mutableCandidate, new AbortController().signal)).resolves.toEqual(promotedObservation);
    expect(run.mock.calls[2]?.[0].at(-1)).toBe("deploylite-active-dep-1");
    expect(run.mock.calls[3]?.[0].at(-1)).toBe(candidate.effectiveImage);
  });
  it.each(["direct", "prior", "supplied"])("preserves %s signal argument compatibility", async (variant) => {
    const { transport, run } = promotionHarness();
    const controller = new AbortController();
    const pending = variant === "direct" ? transport.promoteCandidate(candidate, controller.signal)
      : variant === "prior" ? transport.promoteCandidate(candidate, undefined, controller.signal)
      : transport.promoteCandidate(candidate, undefined, "source-execution", controller.signal);
    await expect(pending).resolves.toEqual(promotedObservation);
    expect(run).toHaveBeenCalledTimes(4);
  });
  it("retains the typed promotion failure when no signal is supplied", async () => {
    const { transport, run } = promotionHarness();
    await expect(transport.promoteCandidate(candidate, undefined)).rejects.toMatchObject({ name: "DockerCliTransportFailure", operation: "promote" });
    expect(run).not.toHaveBeenCalled();
  });
  it("returns observed active metadata instead of a derived identity", async () => {
    const { transport } = promotionHarness();
    await expect(transport.promoteCandidate(candidate, new AbortController().signal)).resolves.toEqual(promotedObservation);
  });
  it("inspects the actual active target only after the existing owned rename", async () => {
    const { transport, run } = promotionHarness();
    await transport.promoteCandidate(candidate, new AbortController().signal);
    expect(run.mock.calls.map(([argv]) => [argv.slice(0, 3), argv.at(-1)])).toEqual([
      [["docker", "inspect", "--format"], "deploylite-candidate-dep-1-cmd-1"],
      [["docker", "rename", "deploylite-candidate-dep-1-cmd-1"], "deploylite-active-dep-1"],
      [["docker", "container", "inspect"], "deploylite-active-dep-1"],
      [["docker", "image", "inspect"], candidate.effectiveImage]
    ]);
  });
  it.each([
    ["project mismatch", { ...selectedMetadata(), projectId: "foreign" }],
    ["unhealthy", { ...selectedMetadata(), health: "unhealthy" }],
    ["actual image mismatch", { ...selectedMetadata(), imageId: `sha256:${"c".repeat(64)}` }]
  ])("rejects %s active evidence after rename without adding lifecycle effects", async (_reason, metadata) => {
    const { transport, run } = promotionHarness(metadata);
    await expect(transport.promoteCandidate(candidate, new AbortController().signal)).rejects.toMatchObject({ name: "DockerCliTransportFailure", operation: "observe", exit: undefined });
    expect(run.mock.calls.filter(([argv]) => argv[1] !== "inspect" && argv[2] !== "inspect").map(([argv]) => argv[1])).toEqual(["rename"]);
  });
  it("rejects a failed active inspection with redacted diagnostics after rename", async () => {
    const { transport, run } = promotionHarness();
    run.mockImplementation(async (argv) => ({ exitCode: argv[1] === "container" ? 1 : 0, signal: null,
      stdout: argv[1] === "inspect" ? `agent-1|dep-1|${candidate.candidateId}|${candidate.effectiveImage}` : "", stderr: "password=hidden" }));
    await expect(transport.promoteCandidate(candidate, new AbortController().signal)).rejects.toMatchObject({ name: "DockerCliTransportFailure", operation: "observe", exit: undefined });
    expect(run.mock.calls.map(([argv]) => argv[1])).toEqual(["inspect", "rename", "container"]);
  });
});


describe("full physical ID Stop lookup", () => {
  it("requests full IDs so a real Docker-style lookup matches the inspected trusted proof", async () => {
    const fullId = "a".repeat(64);
    const run = vi.fn(async (argv: readonly string[]) => ({ exitCode: 0, signal: null, stderr: "", stdout: argv[1] === "ps" ? `${argv.includes("--no-trunc") ? fullId : fullId.slice(0, 12)}|Up 1 second` : argv[1] === "inspect" ? `agent-1|project-1|dep-1|${candidate.candidateId}|${candidate.effectiveImage}|running` : "" }));
    const transport = new DockerCliImageTransport({ runner: { run }, owner: "agent-1", hostPort: 43000, containerPort: 3000, allowedNetworks: [] });
    expect(await transport.stopOwned({ projectId: "project-1", deploymentId: "dep-1", candidateId: candidate.candidateId, effectiveImage: candidate.effectiveImage, containerId: fullId }, new AbortController().signal, { assertValid: async () => {} })).toBe("stopped");
    expect(run.mock.calls.find(([argv]) => argv[1] === "ps")?.[0]).toContain("--no-trunc");
    expect(run.mock.calls.find(([argv]) => argv[1] === "stop")?.[0].at(-1)).toBe(fullId);
  });
});
