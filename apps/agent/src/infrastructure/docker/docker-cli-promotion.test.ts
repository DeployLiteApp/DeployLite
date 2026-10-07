import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerImageCandidateV1, DockerPromotionContext } from "@deploylite/domain";
import { DockerCliImageTransport } from "./docker-cli-image-transport.js";
import { buildDockerRunArgv } from "./docker-cli-argv.js";
import { DockerProcessError } from "./docker-process-runner.js";
const image = `registry.example.com/team/app@sha256:${"a".repeat(64)}`;
const candidate: DockerImageCandidateV1 = { projectId: "project", deploymentId: "b", candidateId: "b:candidate:new", effectiveImage: image, runtimePort: 3000 };
const prior = { deploymentId: "a", projectId: "project", candidateId: "a:candidate:old", effectiveImage: image, runtimePort: 3000, runtimeConfig: { hostPort: 43000, containerPort: 3000 }, terminalStatus: "succeeded" as const, health: "passed" as const, proven: true as const, rollback: { target: null, result: "not-required" as const }, executionReceipt: { schemaVersion: 1 as const, deploymentId: "a", projectId: "project", candidateId: "a:candidate:old", snapshotOriginId: "a", snapshotHash: "b".repeat(64), effectiveImageDigest: image.split("@")[1]!, runtimeHost: "agent", container: "deploylite-active-a", containerId: "1".repeat(64), hostPort: 43000, containerPort: 3000, network: null } };
type Container = { id: string; name: string; owner: string; project: string; deployment: string; candidate: string; image: string; port: number; running: boolean; healthy: boolean };
function fixture() {
  let counter = 1, authorized = true; const operations: string[][] = [];
  const containers = new Map<string, Container>([["deploylite-active-a", { id: "1".repeat(64), name: "deploylite-active-a", owner: "owner", project: "project", deployment: "a", candidate: prior.candidateId, image, port: 43000, running: true, healthy: true }]]);
  const authority = { expiresAt: Date.now() + 200_000, assertValid: async () => { if (!authorized) throw new Error("authority lost"); } };
  const context: DockerPromotionContext = { prior: structuredClone(prior), policy: { maxOutageMs: 30_000, maxRecoveryMs: 60_000 }, authority, candidate };
  let hook: ((argv: readonly string[]) => Promise<void>) | undefined;
  const runner = { run: async (argv: readonly string[], abort: AbortSignal) => {
    operations.push([...argv]); await hook?.(argv); if (abort.aborted) throw new Error("canceled");
    let stdout = ""; const name = argv.at(-1)!; const selected = containers.get(name) ?? [...containers.values()].find((value) => value.id === name);
    if (argv[1] === "run") {
      const value = (flag: string) => argv[argv.indexOf(flag) + 1]!;
      const label = (key: string) => argv.find((part) => part.startsWith(`com.deploylite.${key}=`))!.split("=")[1]!;
      const newName = value("--name"); if (containers.has(newName)) return { exitCode: 1, signal: null, stdout: "", stderr: "name conflict" };
      const port = Number(value("--publish").split(":")[1]);
      if ([...containers.values()].some((value) => value.running && value.port === port)) return { exitCode: 1, signal: null, stdout: "", stderr: "port occupied" };
      containers.set(newName, { id: String(++counter).repeat(64), name: newName, owner: label("owner"), project: label("project"), deployment: label("deployment"), candidate: label("candidate"), image: name, port, running: true, healthy: true });
    } else if (argv[1] === "ps") { stdout = [...containers.values()].map((value) => `${value.id}|Up`).join("\n");
    } else if (argv[1] === "container") {
      if (!selected) throw new DockerProcessError("failed", { exitCode: 1, signal: null, stdout: "", stderr: `Error: No such container: ${name}` });
      if (argv[argv.indexOf("--format") + 1]?.includes('"state"')) return { exitCode: 0, signal: null, stderr: "", stdout: JSON.stringify({ id: selected.id, name: `/${selected.name}`, owner: selected.owner, project: selected.project, deployment: selected.deployment, candidate: selected.candidate, image: selected.image, state: selected.running ? "running" : "exited" }) };
      const binding = { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: String(selected.port) }] };
      stdout = JSON.stringify({ id: selected.id, name: `/${selected.name}`, imageId: `sha256:${"c".repeat(64)}`, owner: selected.owner, projectId: selected.project, deploymentId: selected.deployment, candidateId: selected.candidate, effectiveImage: selected.image, running: selected.running, health: selected.healthy ? "healthy" : "unhealthy", hostBindings: binding, portBindings: binding, networkMode: "default", networks: { bridge: { networkId: "d".repeat(64), endpointId: "e".repeat(64) } } });
    } else if (argv[1] === "image") stdout = JSON.stringify(`sha256:${"c".repeat(64)}`);
    else if (argv[1] === "inspect") {
      if (!selected) throw new DockerProcessError("failed", { exitCode: 1, signal: null, stdout: "", stderr: `Error: No such container: ${name}` });
      const format = argv[argv.indexOf("--format") + 1]!;
      stdout = format.includes("com.deploylite.project") ? `${selected.owner}|${selected.project}|${selected.deployment}|${selected.candidate}|${selected.image}|${selected.running ? "running" : "exited"}|${selected.healthy ? "healthy" : "unhealthy"}` : format.includes("com.deploylite.owner") ? `${selected.owner}|${selected.deployment}|${selected.candidate}|${selected.image}` : selected.healthy ? "healthy" : "unhealthy";
    } else if (argv[1] === "stop" && selected) selected.running = false;
    else if (argv[1] === "start" && selected) selected.running = true;
    else if (argv[1] === "rm" && selected) containers.delete(selected.name);
    else if (argv[1] === "rename") { const old = containers.get(argv[2]!); if (old) { containers.delete(old.name); old.name = name; containers.set(name, old); } }
    return { exitCode: 0, signal: null, stdout, stderr: "" };
  } };
  const options = { runner, owner: "owner", hostPort: 43000, temporaryHostPort: 43001, containerPort: 3000, allowedNetworks: [] };
  expect(() => buildDockerRunArgv({ ...options, candidate, containerName: "deploylite-candidate-b-new", hostPort: 43001, projectId: "project" })).not.toThrow();
  const transport = new DockerCliImageTransport(options);
  const prepare = () => { containers.set("deploylite-candidate-b-new", { id: "2".repeat(64), name: "deploylite-candidate-b-new", owner: "owner", project: "project", deployment: "b", candidate: candidate.candidateId, image, port: 43001, running: true, healthy: true }); counter = 2; };
  const mutations = () => operations.filter((argv) => ["run", "stop", "start", "rm", "rename"].includes(argv[1]!));
  return { transport, options, context, containers, operations, mutations, prepare, lose: () => { authorized = false; }, hook: (value: typeof hook) => { hook = value; } };
}
afterEach(() => vi.useRealTimers());
describe("bounded owned active-port handoff and recovery", () => {
  it.each(["before-preparation", "before-cutover"])("rejects a physical substitute of A with copied labels %s", async (stage) => {
    const f = fixture();
    f.containers.get("deploylite-active-a")!.id = "9".repeat(64);
    if (stage === "before-cutover") f.prepare();
    const result = stage === "before-preparation" ? f.transport.startCandidate(candidate, new AbortController().signal, f.context) : f.transport.promoteCandidate(candidate, prior, new AbortController().signal, f.context);
    await expect(result).rejects.toThrow(); expect(f.mutations()).toEqual([]);
    expect(f.containers.get("deploylite-active-a")?.running).toBe(true);
  });
  it("rejects a physical substitute at stop despite identical owned labels", async () => {
    const f = fixture(); f.containers.get("deploylite-active-a")!.id = "9".repeat(64);
    const input = { projectId: prior.projectId, deploymentId: prior.deploymentId, candidateId: prior.candidateId, effectiveImage: image, containerId: prior.executionReceipt.containerId };
    expect(await f.transport.stopOwned(input, new AbortController().signal, f.context.authority)).toBe("failed");
    expect(f.mutations()).toEqual([]); expect(f.containers.get("deploylite-active-a")?.running).toBe(true);
  });
  it.each([0, 20_000])("preserves healthy A if only 80 seconds of authority remain after %s milliseconds preparation", async (preparation) => {
    vi.useFakeTimers(); vi.setSystemTime(0); const f = fixture();
    (f.context.authority as { expiresAt: number }).expiresAt = preparation + 80_000;
    vi.setSystemTime(preparation); f.prepare();
    await expect(f.transport.promoteCandidate(candidate, prior, new AbortController().signal, f.context)).rejects.toThrow();
    expect(f.mutations()).toEqual([]); expect(f.containers.get("deploylite-active-a")?.running).toBe(true);
  });
  it("blocks late destructive effects when a read ignores cancellation and settles after the outage deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const f = fixture(); f.prepare();
    const run = f.options.runner.run;
    f.options.runner.run = async (argv, abort) => {
      if (argv[1] === "container" && String(argv[argv.indexOf("--format") + 1]).includes('"state"') && argv.at(-1) === "deploylite-candidate-b-new") {
        await new Promise((resolve) => setTimeout(resolve, 31_000));
        // A selected read may return after abort; the adapter must check its signal itself.
        return run(argv, new AbortController().signal);
      }
      return run(argv, abort);
    };
    let outcome: string | undefined;
    f.transport.promoteCandidate(candidate, prior, new AbortController().signal, f.context).then(() => { outcome = "succeeded"; }, () => { outcome = "failed"; });
    await vi.advanceTimersByTimeAsync(30_000); expect(outcome).toBe("failed");
    await vi.advanceTimersByTimeAsync(1_000); expect(f.mutations().map((argv) => argv[1])).toEqual(["stop"]);
    expect(f.containers.get("deploylite-active-a")?.running).toBe(false);
    await f.transport.restorePrior(prior, new AbortController().signal, f.context);
    expect(f.containers.get("deploylite-active-a")?.running).toBe(true);
  });
  it("polls starting candidate health until healthy before any stop of A", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const f = fixture(); f.prepare(); let reads = 0;
    const run = f.options.runner.run;
    f.options.runner.run = async (argv, abort) => argv[1] === "inspect" && argv[argv.indexOf("--format") + 1]?.includes(".State.Health.Status") && ++reads <= 2 ? { exitCode: 0, signal: null, stdout: "starting", stderr: "" } : run(argv, abort);
    let healthy: boolean | undefined; f.transport.checkHealth(candidate, new AbortController().signal).then((value) => { healthy = value; });
    await vi.advanceTimersByTimeAsync(200); expect(healthy).toBe(true); expect(reads).toBe(3);
    expect(f.mutations()).toEqual([]); expect(f.containers.get("deploylite-active-a")?.running).toBe(true);
  });
  it.each(["starting", "unhealthy"])("waits for %s candidate health only within preparation and cancels without late inspection or cutover", async (state) => {
    vi.useFakeTimers(); vi.setSystemTime(0); const f = fixture(); f.prepare(); const abort = new AbortController(); let reads = 0;
    const run = f.options.runner.run;
    f.options.runner.run = async (argv, signal) => { if (argv[1] === "inspect" && argv[argv.indexOf("--format") + 1]?.includes(".State.Health.Status")) { reads++; return { exitCode: 0, signal: null, stdout: state, stderr: "" }; } return run(argv, signal); };
    let outcome: string | undefined; f.transport.checkHealth(candidate, abort.signal).then((value) => { outcome = String(value); }, () => { outcome = "canceled"; });
    const deadline = setTimeout(() => abort.abort(), 30_000);
    await vi.advanceTimersByTimeAsync(29_900); expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(100); expect(outcome).toBe("canceled"); const count = reads;
    await vi.advanceTimersByTimeAsync(100); expect(reads).toBe(count); expect(f.mutations()).toEqual([]);
    expect(f.containers.get("deploylite-active-a")?.running).toBe(true); clearTimeout(deadline);
  });
  it("includes a hanging authority read inside the separate recovery deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const f = fixture();
    f.context.authority.assertValid = async () => { await new Promise(() => {}); };
    let outcome: string | undefined; f.transport.restorePrior(prior, new AbortController().signal, f.context).then(() => { outcome = "restored"; }, () => { outcome = "not-available"; });
    await vi.advanceTimersByTimeAsync(60_000); expect(outcome).toBe("not-available"); expect(f.mutations()).toEqual([]);
  });
  it.each(["missing", "lost-before-stop"])("fails closed for %s stop authority before destructive effects", async (fault) => {
    const f = fixture();
    f.hook(async (argv) => { if (argv[1] === "inspect") f.lose(); });
    const result = await f.transport.stopOwned({ projectId: prior.projectId, deploymentId: prior.deploymentId, candidateId: prior.candidateId, effectiveImage: image }, new AbortController().signal, fault === "missing" ? undefined : f.context.authority);
    expect(result).toBe("failed"); expect(f.mutations()).toEqual([]);
    if (fault === "missing") expect(f.operations).toEqual([]);
  });
  it("prepares healthy B on an explicit temporary port before stopping A, recreates B and observes its independent physical identity", async () => {
    const f = fixture(), signal = new AbortController().signal;
    expect(await f.transport.startCandidate(candidate, signal, f.context).then(() => true, () => false)).toBe(true);
    expect(f.containers.get("deploylite-candidate-b-new")?.port).toBe(43001);
    expect(f.containers.get("deploylite-active-a")?.running).toBe(true);
    expect(await f.transport.checkHealth(candidate, signal)).toBe(true);
    const result = await f.transport.promoteCandidate(candidate, prior, signal, f.context);
    expect(result).toMatchObject({ deploymentId: "b", container: "deploylite-active-b", containerId: "3".repeat(64), hostPort: 43000 });
    expect(f.containers.get("deploylite-active-a")?.running).toBe(false);
    expect(f.mutations().map((argv) => argv[1])).toEqual(["run", "stop", "rm", "run"]);
    expect(f.operations.findIndex((argv) => argv[1] === "stop")).toBeGreaterThan(f.operations.findIndex((argv) => argv[1] === "container" && argv.at(-1) === "deploylite-candidate-b-new"));
  });
  it.each(["missing-policy", "missing-authority", "missing-temp-port", "same-temp-port", "foreign-A", "unhealthy-A"])("rejects %s before disturbing current A", async (fault) => {
    const f = fixture();
    if (fault === "missing-policy") (f.context as { policy?: unknown }).policy = undefined;
    if (fault === "missing-authority") (f.context as { authority?: unknown }).authority = undefined;
    if (fault === "missing-temp-port") (f.options as { temporaryHostPort?: number }).temporaryHostPort = undefined;
    if (fault === "same-temp-port") f.options.temporaryHostPort = 43000;
    if (fault === "foreign-A") f.containers.get("deploylite-active-a")!.project = "foreign";
    if (fault === "unhealthy-A") f.containers.get("deploylite-active-a")!.healthy = false;
    await expect(f.transport.startCandidate(candidate, new AbortController().signal, f.context)).rejects.toThrow();
    expect(f.mutations()).toEqual([]); expect(f.containers.get("deploylite-active-a")?.running).toBe(true);
  });
  it.each(["Error: No such container: ", "Error response from daemon: No such container: ", "No such object: "])("recovers exact stopped A after terminal thrown missing candidate-active inspection (%s)", async (prefix) => {
    const f = fixture(), signal = new AbortController().signal, historical = structuredClone(prior);
    f.containers.get("deploylite-active-a")!.running = false; f.prepare(); const run = f.options.runner.run;
    f.options.runner.run = async (argv, abort) => {
      if (argv[1] === "container" && argv.at(-1) === "deploylite-active-b") throw new DockerProcessError("failed", { exitCode: 1, signal: null, stdout: "", stderr: `${prefix}deploylite-active-b` });
      return run(argv, abort);
    };
    await f.transport.restorePrior(prior, signal, f.context);
    expect(f.mutations().map((argv) => argv.slice(1))).toEqual([["start", prior.executionReceipt.containerId]]);
    expect(f.containers.get("deploylite-active-a")).toMatchObject({ id: prior.executionReceipt.containerId, running: true });
    expect(f.containers.has("deploylite-candidate-b-new")).toBe(true); expect(prior).toEqual(historical);
  });
  it.each(["timeout", "output-limit", "canceled", "exit2", "signal", "foreign-target", "permission", "image", "partial-output", "untyped"] as const)("refuses %s as missing candidate-active proof and never restarts A", async (fault) => {
    const f = fixture(); f.containers.get("deploylite-active-a")!.running = false; const run = f.options.runner.run;
    f.options.runner.run = async (argv, abort) => {
      if (argv[1] !== "container" || argv.at(-1) !== "deploylite-active-b") return run(argv, abort);
      const result = { exitCode: fault === "exit2" ? 2 : 1, signal: fault === "signal" ? "SIGTERM" as const : null, stdout: fault === "partial-output" ? "partial observation" : "", stderr: fault === "foreign-target" ? "Error: No such container: foreign" : fault === "permission" ? "permission denied" : fault === "image" ? "Error: No such image: deploylite-active-b" : "Error: No such container: deploylite-active-b" };
      if (fault === "untyped") throw Object.assign(new Error("unclassified"), { result });
      throw new DockerProcessError(["timeout", "output-limit", "canceled"].includes(fault) ? fault as "timeout" | "output-limit" | "canceled" : "failed", result);
    };
    await expect(f.transport.restorePrior(prior, new AbortController().signal, f.context)).rejects.toThrow();
    expect(f.mutations()).toEqual([]); expect(f.containers.get("deploylite-active-a")?.running).toBe(false);
  });
  it("restores A after partial failure with an independent signal and retains immutable historical proof", async () => {
    const f = fixture(), controller = new AbortController(), historical = structuredClone(prior);
    f.prepare();
    f.hook(async (argv) => { if (argv[1] === "run" && argv.includes("deploylite-active-b")) { controller.abort(); throw new Error("creation interrupted"); } });
    await expect(f.transport.promoteCandidate(candidate, prior, controller.signal, f.context)).rejects.toThrow();
    expect(f.containers.get("deploylite-active-a")?.running).toBe(false);
    f.hook(undefined); await f.transport.restorePrior(prior, new AbortController().signal, f.context);
    expect(f.containers.get("deploylite-active-a")?.running).toBe(true); expect(prior).toEqual(historical);
    expect(f.containers.has("deploylite-active-b")).toBe(false);
  });
  it("does not recover destructively after authority is lost", async () => {
    const f = fixture(), signal = new AbortController().signal; f.prepare();
    f.hook(async (argv) => { if (argv[1] === "stop") { f.lose(); throw new Error("authority revoked during stop"); } });
    await expect(f.transport.promoteCandidate(candidate, prior, signal, f.context)).rejects.toThrow();
    f.lose(); const count = f.mutations().length;
    await expect(f.transport.restorePrior(prior, signal, f.context)).rejects.toThrow();
    await expect(f.transport.discardCandidate(candidate, signal, f.context)).rejects.toThrow(); expect(f.mutations()).toHaveLength(count);
  });
  it("bounds normal outage at 30 seconds even when a runner never settles", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const f = fixture(), signal = new AbortController().signal;
    f.prepare();
    f.hook(async (argv) => { if (argv[1] === "run" && argv.includes("deploylite-active-b")) await new Promise(() => {}); });
    const result = f.transport.promoteCandidate(candidate, prior, signal, f.context).then(() => "succeeded", () => "failed");
    await vi.advanceTimersByTimeAsync(30_000); expect(await result).toBe("failed"); expect(f.operations.some((argv) => argv[1] === "stop")).toBe(true); expect(Date.now()).toBe(30_000);
    f.hook(undefined); await f.transport.restorePrior(prior, signal, f.context); expect(f.containers.get("deploylite-active-a")?.running).toBe(true);
  });
  it("bounds recovery separately at 60 seconds and never reports an unavailable restoration as healthy", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const f = fixture(), signal = new AbortController().signal;
    f.containers.get("deploylite-active-a")!.running = false;
    f.hook(async (argv) => { if (argv[1] === "start") await new Promise(() => {}); });
    let outcome: string | undefined; f.transport.restorePrior(prior, signal, f.context).then(() => { outcome = "restored"; }, () => { outcome = "not-available"; });
    await vi.advanceTimersByTimeAsync(60_000); expect(outcome).toBe("not-available"); expect(f.containers.get("deploylite-active-a")?.running).toBe(false);
  });
  it("restores exceptional recreated A truthfully without granting its historical proof future control eligibility", async () => {
    const f = fixture(), signal = new AbortController().signal; f.containers.delete("deploylite-active-a");
    expect(await f.transport.restorePrior(prior, signal, f.context).then(() => true, () => false)).toBe(true);
    expect(f.containers.get("deploylite-active-a")).toMatchObject({ id: "2".repeat(64), running: true, port: 43000 });
    expect(prior.executionReceipt.containerId).toBe("1".repeat(64));
    const mutations = f.mutations().length;
    await expect(f.transport.startCandidate(candidate, signal, f.context)).rejects.toThrow();
    expect(f.mutations()).toHaveLength(mutations);
  });
});


describe("pre-cutover inspection cancellation", () => {
  it("settles a fresh authority read that never returns and forbids late mutations", async () => {
    vi.useFakeTimers(); const f = fixture(); f.prepare(); const abort = new AbortController(); let resume!: () => void; const barrier = new Promise<void>((resolve) => { resume = resolve; });
    f.context.authority.assertValid = async () => barrier; let outcome = "pending";
    const pending = f.transport.promoteCandidate(candidate, prior, abort.signal, f.context).then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
    abort.abort(); await vi.advanceTimersByTimeAsync(0);
    try { expect(outcome).toBe("rejected"); expect(f.mutations()).toEqual([]); }
    finally { resume(); await pending; }
    expect(f.mutations()).toEqual([]); expect(f.containers.get("deploylite-active-a")?.running).toBe(true);
  });
});
