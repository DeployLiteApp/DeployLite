import type { DockerImageCandidateV1 } from "@deploylite/domain";

const DIGEST_IMAGE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NETWORK = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const TMPFS = ["/tmp", "/var/cache/nginx", "/var/run"] as const;
const TMPFS_OPTIONS = "rw,noexec,nosuid,nodev";

export type DockerRunArgvInput = Readonly<{
  candidate: DockerImageCandidateV1;
  containerName: string;
  hostPort: number;
  containerPort: number;
  owner: string;
  allowedNetworks: readonly string[];
  networkName?: string;
}>;

function reject(message: string): never { throw new Error(message); }
function assertPort(value: number, label: string): void { if (!Number.isInteger(value) || value < 1 || value > 65535) reject(`${label} is unsafe`); }
function assertId(value: string, label: string): void { if (!IDENTIFIER.test(value)) reject(`${label} is unsafe`); }
function assertCandidate(candidate: DockerImageCandidateV1): void {
  if (!DIGEST_IMAGE.test(candidate.effectiveImage)) reject("docker effective image is unsafe");
  assertId(candidate.deploymentId, "deployment identity");
  assertPort(candidate.runtimePort, "runtime port");
  const prefix = `${candidate.deploymentId}:candidate:`;
  if (!candidate.candidateId.startsWith(prefix)) reject("candidate identity is unsafe");
  assertId(candidate.candidateId.slice(prefix.length), "candidate identity");
}

export function buildDockerRunArgv(input: DockerRunArgvInput): readonly string[] {
  assertCandidate(input.candidate); assertId(input.containerName, "container name"); assertId(input.owner, "owner");
  assertPort(input.hostPort, "host port"); if (input.hostPort < 1024) reject("host port is unsafe"); assertPort(input.containerPort, "container port");
  if (input.networkName !== undefined && (!NETWORK.test(input.networkName) || !input.allowedNetworks.includes(input.networkName))) reject("docker network is unsafe");
  return Object.freeze(["docker", "run", "--detach", "--name", input.containerName, "--label", "com.deploylite.owner=" + input.owner, "--label", "com.deploylite.deployment=" + input.candidate.deploymentId, "--label", "com.deploylite.candidate=" + input.candidate.candidateId, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--restart=no", ...TMPFS.flatMap((path) => ["--tmpfs", `${path}:${TMPFS_OPTIONS}`]), ...(input.networkName ? ["--network", input.networkName] : []), "--publish", `127.0.0.1:${input.hostPort}:${input.containerPort}`, input.candidate.effectiveImage]);
}

export function buildDockerInspectArgv(containerName: string): readonly string[] { assertId(containerName, "container name"); return Object.freeze(["docker", "inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", containerName]); }
export function buildDockerRenameArgv(source: string, target: string): readonly string[] { assertId(source, "source container"); assertId(target, "target container"); return Object.freeze(["docker", "rename", source, target]); }
export function buildDockerRemoveArgv(containerName: string): readonly string[] { assertId(containerName, "container name"); return Object.freeze(["docker", "rm", "--force", containerName]); }
