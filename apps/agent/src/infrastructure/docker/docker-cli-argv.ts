import type { DockerImageCandidateV1 } from "@deploylite/domain";

const DIGEST_IMAGE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const NETWORK = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const TMPFS = ["/tmp", "/var/cache/nginx", "/var/run"] as const;
const TMPFS_OPTIONS = "rw,noexec,nosuid,nodev";

export type DockerRunArgvInput = Readonly<{
  candidate: DockerImageCandidateV1;
  projectId?: string;
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
  assertCandidate(input.candidate); if (input.projectId !== undefined) assertId(input.projectId, "project identity"); assertId(input.containerName, "container name"); assertId(input.owner, "owner");
  assertPort(input.hostPort, "host port"); if (input.hostPort < 1024) reject("host port is unsafe"); assertPort(input.containerPort, "container port");
  if (input.networkName !== undefined && (!NETWORK.test(input.networkName) || !input.allowedNetworks.includes(input.networkName))) reject("docker network is unsafe");
  return Object.freeze(["docker", "run", "--detach", "--name", input.containerName, "--label", "com.deploylite.owner=" + input.owner, ...(input.projectId ? ["--label", "com.deploylite.project=" + input.projectId] : []), "--label", "com.deploylite.deployment=" + input.candidate.deploymentId, "--label", "com.deploylite.candidate=" + input.candidate.candidateId, "--label", "com.deploylite.image=" + input.candidate.effectiveImage, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--restart=no", ...TMPFS.flatMap((path) => ["--tmpfs", `${path}:${TMPFS_OPTIONS}`]), ...(input.networkName ? ["--network", input.networkName] : []), "--publish", `127.0.0.1:${input.hostPort}:${input.containerPort}`, input.candidate.effectiveImage]);
}

export function buildDockerInspectArgv(containerName: string): readonly string[] { assertId(containerName, "container name"); return Object.freeze(["docker", "inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", containerName]); }
export function buildDockerOwnershipInspectArgv(containerName: string): readonly string[] { assertId(containerName, "container name"); return Object.freeze(["docker", "inspect", "--format", "{{index .Config.Labels \"com.deploylite.owner\"}}|{{index .Config.Labels \"com.deploylite.deployment\"}}|{{index .Config.Labels \"com.deploylite.candidate\"}}|{{index .Config.Labels \"com.deploylite.image\"}}", containerName]); }
export function buildDockerOwnedStopLookupArgv(input: { owner: string; projectId: string; deploymentId: string; candidateId: string; effectiveImage: string }): readonly string[] { assertId(input.owner, "owner"); assertId(input.projectId, "project identity"); assertId(input.deploymentId, "deployment identity"); if (!input.candidateId.startsWith(`${input.deploymentId}:candidate:`)) reject("candidate identity is unsafe"); assertId(input.candidateId.slice(`${input.deploymentId}:candidate:`.length), "candidate identity"); if (!DIGEST_IMAGE.test(input.effectiveImage)) reject("docker effective image is unsafe"); return Object.freeze(["docker", "ps", "--all", "--filter", `label=com.deploylite.owner=${input.owner}`, "--filter", `label=com.deploylite.project=${input.projectId}`, "--filter", `label=com.deploylite.deployment=${input.deploymentId}`, "--filter", `label=com.deploylite.candidate=${input.candidateId}`, "--filter", `label=com.deploylite.image=${input.effectiveImage}`, "--format", "{{.ID}}|{{.Status}}"]); }
export function buildDockerStopOwnershipInspectArgv(containerId: string): readonly string[] { if (!/^[a-f0-9]{12,64}$/.test(containerId)) reject("container identity is unsafe"); return Object.freeze(["docker", "inspect", "--format", "{{index .Config.Labels \"com.deploylite.owner\"}}|{{index .Config.Labels \"com.deploylite.project\"}}|{{index .Config.Labels \"com.deploylite.deployment\"}}|{{index .Config.Labels \"com.deploylite.candidate\"}}|{{index .Config.Labels \"com.deploylite.image\"}}|{{.State.Status}}", containerId]); }
export function buildDockerStopArgv(containerId: string): readonly string[] { if (!/^[a-f0-9]{12,64}$/.test(containerId)) reject("container identity is unsafe"); return Object.freeze(["docker", "stop", "--time", "10", containerId]); }
export function buildDockerRenameArgv(source: string, target: string): readonly string[] { assertId(source, "source container"); assertId(target, "target container"); return Object.freeze(["docker", "rename", source, target]); }
export function buildDockerRemoveArgv(containerName: string): readonly string[] { assertId(containerName, "container name"); return Object.freeze(["docker", "rm", "--force", containerName]); }
