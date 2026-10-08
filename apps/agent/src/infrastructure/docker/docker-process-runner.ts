import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { redactSecrets } from "@deploylite/config";

import { buildDockerActiveIdentityInspectArgv, buildDockerImageIdentityInspectArgv, buildDockerLifecycleInspectArgv,
  buildDockerOwnedStopLookupArgv, buildDockerOwnershipInspectArgv, buildDockerRestoreInspectArgv,
  buildDockerStopOwnershipInspectArgv } from "./docker-cli-argv.js";

import { COMPOSE_INSPECTION_FORMATS } from "./docker-compose-resource-argv.js";

const DOCKER_ID = /^(?:sha256:)?[0-9a-f]{64}$/;
const DOCKER_IMAGE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;
const protocolSample = { owner: "probe", projectId: "probe", deploymentId: "probe", candidateId: "probe:candidate:command", effectiveImage: `registry.example/probe@sha256:${"0".repeat(64)}` };
const protocolFormats = new Set([
  ...COMPOSE_INSPECTION_FORMATS,
  ...[buildDockerImageIdentityInspectArgv(protocolSample.effectiveImage), buildDockerLifecycleInspectArgv("probe"),
    buildDockerOwnershipInspectArgv("probe"), buildDockerRestoreInspectArgv("probe"),
    buildDockerStopOwnershipInspectArgv("0".repeat(64)), buildDockerOwnedStopLookupArgv(protocolSample),
    buildDockerActiveIdentityInspectArgv({ candidate: { ...protocolSample, runtimePort: 8080, networkName: "probe" },
      projectId: "probe", owner: "probe", containerName: "probe", hostPort: 49170, containerPort: 8080, allowedNetworks: ["probe"], networkName: "probe" })
  ].map((argv) => argv[argv.indexOf("--format") + 1]!),
  "{{.ID}}", "{{.ID}}|{{.Status}}",
  '{"id":{{json .ID}},"os":{{json .OSType}},"architecture":{{json .Architecture}},"cpu":{{json .NCPU}},"memory":{{json .MemTotal}}}',
  '{"id":{{json .Id}},"os":{{json .Os}},"arch":{{json .Architecture}},"repoDigests":{{json .RepoDigests}},"healthType":{{if .Config.Healthcheck}}{{if .Config.Healthcheck.Test}}{{json (index .Config.Healthcheck.Test 0)}}{{else}}null{{end}}{{else}}null{{end}},"healthInterval":{{if .Config.Healthcheck}}{{json .Config.Healthcheck.Interval}}{{else}}0{{end}}}',
  '{"id":{{json .Id}},"name":{{json .Name}},"owner":{{json (index .Labels "com.deploylite.owner")}},"project":{{json (index .Labels "com.deploylite.project")}},"internal":{{json .Internal}},"driver":{{json .Driver}},"options":{{json .Options}},"containers":{{json .Containers}}}',
  '{"id":{{json .Id}},"cpu":{{json .HostConfig.NanoCpus}},"memory":{{json .HostConfig.Memory}},"pids":{{json .HostConfig.PidsLimit}}}'
]);
function redactDockerProtocolOutput(value: string, argv: readonly string[]): string {
  if (argv[0] !== "docker") return redactDockerDiagnostic(value);
  const words = argv.slice(1);
  while ((words[0] === "--config" || words[0] === "--host") && words[1]) words.splice(0, 2);
  const op = words[0], format = words[words.indexOf("--format") + 1];
  if (op === "run" || (op === "network" && words[1] === "create")) return /^[0-9a-f]{64}\n?$/.test(value) ? value : redactDockerDiagnostic(value);
  const composeFormat = COMPOSE_INSPECTION_FORMATS.has(format ?? "");
  if (!(["inspect", "info", "ps"].includes(op ?? "") || (op === "container" && words[1] === "ls") || (["container", "image", "network"].includes(op ?? "") && words[1] === "inspect") || (composeFormat && op === "volume" && words[1] === "inspect")) || !words.includes("--format") || !protocolFormats.has(format ?? "")) return redactDockerDiagnostic(value);
  const safeJson = (nested: unknown, path: string[] = []): unknown => {
    const key = path.at(-1) ?? "";
    if (/(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential)/i.test(key)) return "[REDACTED]";
    if (typeof nested === "string") {
      if (composeFormat && key === "name" && /^dl-[a-f0-9]{32}-(?:net|vol)-[a-z][a-z0-9_-]{0,62}$/.test(nested)
        && (path.length === 1 || (path.length === 3 && ["networks", "mounts"].includes(path[0]!)))) return nested;
      if (DOCKER_ID.test(nested) && ((path.length === 1 && ["id", "imageId"].includes(key) && format!.includes(`"${key}":`)) || (path.length === 3 && path[0] === "networks" && ["networkId", "endpointId"].includes(key) && format!.includes(`"${key}":`)))) return nested;
      if (DOCKER_IMAGE.test(nested) && ((path.length === 1 && ["image", "effectiveImage"].includes(key) && format!.includes(`"${key}":`)) || (path.length === 2 && path[0] === "repoDigests" && format!.includes(".RepoDigests")))) return nested;
      return redactDockerDiagnostic(nested);
    }
    if (Array.isArray(nested)) return nested.map((item, index) => safeJson(item, [...path, String(index)]));
    if (nested && typeof nested === "object") return Object.fromEntries(Object.entries(nested).map(([name, item]) => [name, safeJson(item, [...path, name])]));
    return nested;
  };
  if ((op === "ps" || (op === "container" && words[1] === "ls")) && ["{{.ID}}", "{{.ID}}|{{.Status}}"].includes(format!)) return value.split("\n").map((line) => line.split("|").map((part, position) => position === 0 && /^[0-9a-f]{64}$/.test(part) ? part : redactDockerDiagnostic(part)).join("|")).join("\n");
  if (op === "inspect" && format!.includes("|")) {
    const fields = format!.split("|"), imagePosition = fields.indexOf('{{index .Config.Labels "com.deploylite.image"}}');
    return value.split("\n").map((line) => {
      const parts = line.split("|");
      if (parts.length !== fields.length) return redactDockerDiagnostic(line);
      return parts.map((part, position) => position === imagePosition && DOCKER_IMAGE.test(part) ? part : redactDockerDiagnostic(part)).join("|");
    }).join("\n");
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (format === "{{json .Id}}" && typeof parsed === "string" && /^sha256:[0-9a-f]{64}$/.test(parsed)) return value;
    const projected = safeJson(parsed);
    return JSON.stringify(projected) + (value.endsWith("\n") ? "\n" : "");
  } catch {
    return redactDockerDiagnostic(value);
  }
}


export type DockerProcessExit = Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
export class DockerProcessError extends Error { constructor(readonly kind: "failed" | "timeout" | "canceled" | "output-limit", readonly result?: DockerProcessExit) { super(`docker process ${kind}`); this.name = "DockerProcessError"; } }
export function redactDockerDiagnostic(value: string): string { return redactSecrets(value).replace(/\b(password|secret|token|authorization)\s*[:=]\s*\S+/gi, "$1=[REDACTED]").replace(/:\/\/[^\s/:]+:[^\s@]+@/g, "://[REDACTED]@"); }
export type SpawnedProcess = Pick<ChildProcess, "stdout" | "stderr" | "once" | "kill"> & { pid?: number };
export type SpawnProcess = (file: string, args: readonly string[], options: { shell: false; detached: boolean; stdio: ["ignore", "pipe", "pipe"]; env?: NodeJS.ProcessEnv }) => SpawnedProcess;
const defaultSpawn: SpawnProcess = (file, args, options) => nodeSpawn(file, args, options);

export type DockerProcessRunnerOptions = Readonly<{ spawn?: SpawnProcess; timeoutMs?: number; maxOutputBytes?: number }>;
export class DockerProcessRunner {
  readonly #spawn: SpawnProcess; readonly #timeoutMs: number; readonly #maxOutputBytes: number;
  constructor(options: DockerProcessRunnerOptions = {}) { this.#spawn = options.spawn ?? defaultSpawn; this.#timeoutMs = options.timeoutMs ?? 30_000; this.#maxOutputBytes = options.maxOutputBytes ?? 64 * 1024; }
  run(argv: readonly string[], signal: AbortSignal, environment?: Readonly<Record<string, string>>): Promise<DockerProcessExit> {
    if (argv.length === 0 || argv.some((part) => typeof part !== "string")) return Promise.reject(new DockerProcessError("failed"));
    const injected = environment ? { ...environment } : undefined;
    if (injected && Object.entries(injected).some(([key, value]) => !/^[A-Z_][A-Z0-9_]{0,127}$/.test(key) || typeof value !== "string" || value.includes("\u0000")
      || ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"].includes(key))) {
      return Promise.reject(new DockerProcessError("failed"));
    }
    return new Promise((resolve, reject) => {
      const childEnvironment = injected ? { ...process.env, ...injected, ...(process.env.PATH ? { PATH: process.env.PATH } : {}) } : undefined;
      let child: SpawnedProcess; try { child = this.#spawn(argv[0]!, argv.slice(1), { shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"], ...(childEnvironment ? { env: childEnvironment } : {}) }); } catch (error) { reject(error); return; }
      let stdout = ""; let stderr = ""; let settled = false; let timer: ReturnType<typeof setTimeout> | undefined;
      const redactInjected = (value: string) => Object.values(injected ?? {}).filter(secret => secret.length > 0).reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
      const finish = (error?: DockerProcessError) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); signal.removeEventListener("abort", onAbort); if (error) reject(error); };
      const kill = () => { try { child.kill("SIGKILL"); } catch { /* process may already be gone */ } if (child.pid && process.platform !== "win32") { try { process.kill(-child.pid, "SIGKILL"); } catch { /* group may already be gone */ } } };
      const onAbort = () => { kill(); finish(new DockerProcessError("canceled")); };
      const safeResult = (exitCode: number | null, exitSignal: NodeJS.Signals | null): DockerProcessExit => ({
        exitCode, signal: exitSignal,
        stdout: redactInjected(exitCode === 0 && exitSignal === null ? redactDockerProtocolOutput(stdout, argv) : redactDockerDiagnostic(stdout)),
        stderr: redactInjected(redactDockerDiagnostic(stderr))
      });
      const append = (chunk: Buffer | string, target: "stdout" | "stderr") => { const value = chunk.toString(); if (stdout.length + stderr.length + value.length > this.#maxOutputBytes) { kill(); finish(new DockerProcessError("output-limit", safeResult(null, null))); return; } if (target === "stdout") stdout += value; else stderr += value; };
      child.stdout?.on("data", (chunk) => append(chunk, "stdout")); child.stderr?.on("data", (chunk) => append(chunk, "stderr"));
      const onExit = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => { const result = safeResult(exitCode, exitSignal); if (settled) return; if (exitCode === 0) { settled = true; if (timer) clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(result); } else finish(new DockerProcessError("failed", result)); };
      child.once("close", onExit); signal.addEventListener("abort", onAbort, { once: true }); timer = setTimeout(() => { kill(); finish(new DockerProcessError("timeout", safeResult(null, "SIGKILL"))); }, this.#timeoutMs);
      if (signal.aborted) onAbort();
    });
  }
}
