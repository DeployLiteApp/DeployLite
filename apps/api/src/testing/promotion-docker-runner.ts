import { createHash } from "node:crypto";
import type { DockerCliRunner } from "../../../agent/src/infrastructure/docker/docker-cli-image-transport.js";
export type RecordedContainer = { id: string; name: string; labels: Record<string, string>; hostPort: number; containerPort: number; running: boolean; healthy: boolean };
/** Recording CLI boundary: no Docker engine, process, socket or listener. */
export function createPromotionDockerRunner() {
  const containers = new Map<string, RecordedContainer>(), calls: string[][] = [];
  const runs = new Map<string, number>(); let hook: ((argv: readonly string[]) => Promise<void>) | undefined;
  const imageId = `sha256:${"a".repeat(64)}`;
  const runner: DockerCliRunner = { run: async (argv, signal) => {
    calls.push([...argv]); await hook?.(argv); if (signal.aborted) throw new Error("recorded command canceled");
    const name = argv.at(-1)!, selected = containers.get(name) ?? [...containers.values()].find((entry) => entry.id === name);
    const result = (stdout = "", exitCode = 0, stderr = "") => ({ stdout, exitCode, stderr, signal: null });
    if (argv[1] === "run") {
      const labels = Object.fromEntries(argv.filter((part) => part.startsWith("com.deploylite.")).map((part) => part.split(/=(.*)/s).slice(0, 2)));
      const target = argv[argv.indexOf("--name") + 1]!, [hostPort, containerPort] = argv[argv.indexOf("--publish") + 1]!.split(":").slice(1).map(Number);
      if (containers.has(target) || [...containers.values()].some((entry) => entry.running && entry.hostPort === hostPort)) return result("", 1, "occupied");
      const deployment = labels["com.deploylite.deployment"]!, count = (runs.get(deployment) ?? 0) + 1; runs.set(deployment, count);
      const id = createHash("sha256").update(`physical-${deployment}${count === 1 ? "" : `-${count}`}`).digest("hex");
      containers.set(target, { id, name: target, labels, hostPort: hostPort!, containerPort: containerPort!, running: true, healthy: true }); return result(id);
    }
    if (argv[1] === "image") return result(JSON.stringify(imageId));
    if (argv[1] === "ps") {
      const wanted = argv.filter((part) => part.startsWith("label=")).map((part) => part.slice(6).split(/=(.*)/s).slice(0, 2));
      return result([...containers.values()].filter((entry) => wanted.every(([key, value]) => entry.labels[key!] === value)).map((entry) => `${argv.includes("--no-trunc") ? entry.id : entry.id.slice(0, 12)}|${entry.running ? "Up" : "Exited"}`).join("\n"));
    }
    if (argv[1] === "rename") { const source = containers.get(argv[2]!); if (!source || containers.has(name)) return result("", 1, "name conflict"); containers.delete(source.name); source.name = name; containers.set(name, source); return result(); }
    if (!selected) return result("", 1, "No such object");
    const labels = selected.labels, state = selected.running ? "running" : "exited", health = selected.healthy ? "healthy" : "unhealthy";
    if (argv[1] === "container") {
      if (argv[argv.indexOf("--format") + 1]?.includes('"state"')) return result(JSON.stringify({ id: selected.id, name: `/${selected.name}`, state, owner: labels["com.deploylite.owner"], project: labels["com.deploylite.project"], deployment: labels["com.deploylite.deployment"], candidate: labels["com.deploylite.candidate"], image: labels["com.deploylite.image"] }));
      const binding = { [`${selected.containerPort}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(selected.hostPort) }] };
      return result(JSON.stringify({ id: selected.id, name: `/${selected.name}`, imageId, owner: labels["com.deploylite.owner"], projectId: labels["com.deploylite.project"], deploymentId: labels["com.deploylite.deployment"], candidateId: labels["com.deploylite.candidate"], effectiveImage: labels["com.deploylite.image"], running: selected.running, health, hostBindings: binding, portBindings: binding, networkMode: "default", networks: { bridge: { networkId: "d".repeat(64), endpointId: "e".repeat(64) } } }));
    }
    if (argv[1] === "inspect") {
      const format = argv[argv.indexOf("--format") + 1] ?? "";
      return result(format.includes("com.deploylite.project") ? `${labels["com.deploylite.owner"]}|${labels["com.deploylite.project"]}|${labels["com.deploylite.deployment"]}|${labels["com.deploylite.candidate"]}|${labels["com.deploylite.image"]}|${state}|${health}` : format.includes("com.deploylite.owner") ? `${labels["com.deploylite.owner"]}|${labels["com.deploylite.deployment"]}|${labels["com.deploylite.candidate"]}|${labels["com.deploylite.image"]}` : health);
    }
    if (argv[1] === "stop") selected.running = false;
    if (argv[1] === "start") selected.running = true;
    if (argv[1] === "rm") containers.delete(selected.name);
    if (argv[1] === "rename") { containers.delete(argv[2]!); selected.name = name; containers.set(name, selected); }
    return result();
  } };
  return { runner, containers, calls, setHook: (value: typeof hook) => { hook = value; } };
}
