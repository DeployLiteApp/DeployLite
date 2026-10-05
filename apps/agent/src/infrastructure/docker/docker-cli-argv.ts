import type { DockerImageCandidateV1 } from "@deploylite/domain";

const DIGEST_IMAGE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[1-9][0-9]{0,4})?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
const CONTAINER_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
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
function assertContainerName(value: string, label: string): void { if (!CONTAINER_NAME.test(value)) reject(`${label} is unsafe`); }
function assertCandidate(candidate: DockerImageCandidateV1): void {
  if (!DIGEST_IMAGE.test(candidate.effectiveImage)) reject("docker effective image is unsafe");
  assertId(candidate.deploymentId, "deployment identity");
  assertPort(candidate.runtimePort, "runtime port");
  const prefix = `${candidate.deploymentId}:candidate:`;
  if (!candidate.candidateId.startsWith(prefix)) reject("candidate identity is unsafe");
  assertId(candidate.candidateId.slice(prefix.length), "candidate identity");
}

export function buildDockerRunArgv(input: DockerRunArgvInput): readonly string[] {
  assertCandidate(input.candidate); if (input.projectId !== undefined) assertId(input.projectId, "project identity"); assertContainerName(input.containerName, "container name"); assertId(input.owner, "owner");
  assertPort(input.hostPort, "host port"); if (input.hostPort < 1024) reject("host port is unsafe"); assertPort(input.containerPort, "container port");
  if (input.networkName !== undefined && (!NETWORK.test(input.networkName) || !input.allowedNetworks.includes(input.networkName))) reject("docker network is unsafe");
  return Object.freeze(["docker", "run", "--detach", "--name", input.containerName, "--label", "com.deploylite.owner=" + input.owner, ...(input.projectId ? ["--label", "com.deploylite.project=" + input.projectId] : []), "--label", "com.deploylite.deployment=" + input.candidate.deploymentId, "--label", "com.deploylite.candidate=" + input.candidate.candidateId, "--label", "com.deploylite.image=" + input.candidate.effectiveImage, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--restart=no", ...TMPFS.flatMap((path) => ["--tmpfs", `${path}:${TMPFS_OPTIONS}`]), ...(input.networkName ? ["--network", input.networkName] : []), "--publish", `127.0.0.1:${input.hostPort}:${input.containerPort}`, input.candidate.effectiveImage]);
}

export function buildDockerInspectArgv(containerName: string): readonly string[] { assertContainerName(containerName, "container name"); return Object.freeze(["docker", "inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}", containerName]); }
export function buildDockerRestoreInspectArgv(containerName: string): readonly string[] { assertContainerName(containerName, "container name"); return Object.freeze(["docker", "inspect", "--format", "{{index .Config.Labels \"com.deploylite.owner\"}}|{{index .Config.Labels \"com.deploylite.project\"}}|{{index .Config.Labels \"com.deploylite.deployment\"}}|{{index .Config.Labels \"com.deploylite.candidate\"}}|{{index .Config.Labels \"com.deploylite.image\"}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}", containerName]); }
export function buildDockerStartArgv(containerName: string): readonly string[] { assertContainerName(containerName, "container name"); return Object.freeze(["docker", "start", containerName]); }
export function buildDockerOwnershipInspectArgv(containerName: string): readonly string[] { assertContainerName(containerName, "container name"); return Object.freeze(["docker", "inspect", "--format", "{{index .Config.Labels \"com.deploylite.owner\"}}|{{index .Config.Labels \"com.deploylite.deployment\"}}|{{index .Config.Labels \"com.deploylite.candidate\"}}|{{index .Config.Labels \"com.deploylite.image\"}}", containerName]); }
export function buildDockerOwnedStopLookupArgv(input: { owner: string; projectId: string; deploymentId: string; candidateId: string; effectiveImage: string }): readonly string[] { assertId(input.owner, "owner"); assertId(input.projectId, "project identity"); assertId(input.deploymentId, "deployment identity"); if (!input.candidateId.startsWith(`${input.deploymentId}:candidate:`)) reject("candidate identity is unsafe"); assertId(input.candidateId.slice(`${input.deploymentId}:candidate:`.length), "candidate identity"); if (!DIGEST_IMAGE.test(input.effectiveImage)) reject("docker effective image is unsafe"); return Object.freeze(["docker", "ps", "--all", "--no-trunc", "--filter", `label=com.deploylite.owner=${input.owner}`, "--filter", `label=com.deploylite.project=${input.projectId}`, "--filter", `label=com.deploylite.deployment=${input.deploymentId}`, "--filter", `label=com.deploylite.candidate=${input.candidateId}`, "--filter", `label=com.deploylite.image=${input.effectiveImage}`, "--format", "{{.ID}}|{{.Status}}"]); }
export function buildDockerStopOwnershipInspectArgv(containerId: string): readonly string[] { if (!/^[a-f0-9]{12,64}$/.test(containerId)) reject("container identity is unsafe"); return Object.freeze(["docker", "inspect", "--format", "{{index .Config.Labels \"com.deploylite.owner\"}}|{{index .Config.Labels \"com.deploylite.project\"}}|{{index .Config.Labels \"com.deploylite.deployment\"}}|{{index .Config.Labels \"com.deploylite.candidate\"}}|{{index .Config.Labels \"com.deploylite.image\"}}|{{.State.Status}}", containerId]); }
export function buildDockerStopArgv(containerId: string): readonly string[] { if (!/^[a-f0-9]{12,64}$/.test(containerId)) reject("container identity is unsafe"); return Object.freeze(["docker", "stop", "--time", "10", containerId]); }
export function buildDockerRenameArgv(source: string, target: string): readonly string[] { assertContainerName(source, "source container"); assertContainerName(target, "target container"); return Object.freeze(["docker", "rename", source, target]); }
export function buildDockerRemoveArgv(containerName: string): readonly string[] { assertContainerName(containerName, "container name"); return Object.freeze(["docker", "rm", "--force", containerName]); }

const ACTIVE_IDENTITY_FORMAT = [
  '{"id":{{json .Id}},"name":{{json .Name}},"imageId":{{json .Image}},',
  '"owner":{{json (index .Config.Labels "com.deploylite.owner")}},',
  '"projectId":{{json (index .Config.Labels "com.deploylite.project")}},',
  '"deploymentId":{{json (index .Config.Labels "com.deploylite.deployment")}},',
  '"candidateId":{{json (index .Config.Labels "com.deploylite.candidate")}},',
  '"effectiveImage":{{json (index .Config.Labels "com.deploylite.image")}},',
  '"running":{{json .State.Running}},',
  '"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},',
  '"hostBindings":{{json .HostConfig.PortBindings}},"portBindings":{{json .NetworkSettings.Ports}},',
  '"networkMode":{{json .HostConfig.NetworkMode}},"networks":{',
  '{{$separator := ""}}{{range $name, $attachment := .NetworkSettings.Networks}}',
  '{{$separator}}{{json $name}}:{"networkId":{{json $attachment.NetworkID}},',
  '"endpointId":{{json $attachment.EndpointID}}}{{$separator = ","}}{{end}}}}'
].join("");

export function buildDockerActiveIdentityInspectArgv(input: DockerRunArgvInput): readonly string[] {
  // Reuse pure token validation; the run argv is never sent to the runner.
  buildDockerRunArgv(input);
  if (!input.projectId || input.projectId !== input.candidate.projectId) reject("project identity is unsafe");
  return Object.freeze(["docker", "container", "inspect", "--format", ACTIVE_IDENTITY_FORMAT, input.containerName]);
}

export function buildDockerImageIdentityInspectArgv(effectiveImage: string): readonly string[] {
  if (!DIGEST_IMAGE.test(effectiveImage)) reject("docker effective image is unsafe");
  return Object.freeze(["docker", "image", "inspect", "--format", "{{json .Id}}", effectiveImage]);
}

/** Select only lifecycle ownership and physical identity; never dump container configuration. */
export function buildDockerLifecycleInspectArgv(containerName: string): readonly string[] {
  assertContainerName(containerName, "container name");
  const fields = ["\"id\":{{json .Id}}", "\"name\":{{json .Name}}", "\"state\":{{json .State.Status}}", ...["owner", "project", "deployment", "candidate", "image"].map((label) => `"${label}":{{json (index .Config.Labels "com.deploylite.${label}")}}`)];
  return Object.freeze(["docker", "container", "inspect", "--format", `{${fields.join(",")}}`, containerName]);
}
