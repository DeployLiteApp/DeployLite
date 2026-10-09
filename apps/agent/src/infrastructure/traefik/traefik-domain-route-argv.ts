import { buildDockerActiveIdentityInspectArgv, buildDockerImageIdentityInspectArgv } from "../docker/docker-cli-argv.js";

const identity = /^[A-Za-z0-9_-]{1,200}$/;
const objectId = /^[a-f0-9]{64}$/;
const networkName = /^deploylite-project-[a-f0-9]{24}$/;

export const DOMAIN_ROUTE_NETWORK_INSPECT_FORMAT = "{\"id\":{{json .Id}},\"name\":{{json .Name}},\"driver\":{{json .Driver}},\"internal\":{{json .Internal}},\"owner\":{{json (index .Labels \"com.deploylite.owner\")}},\"project\":{{json (index .Labels \"com.deploylite.project\")}},\"kind\":{{json (index .Labels \"com.deploylite.kind\")}},\"containers\":{{json .Containers}}}";
export const DOMAIN_ROUTE_TRAEFIK_INSPECT_FORMAT = "{\"id\":{{json .Id}},\"name\":{{json .Name}},\"project\":{{json (index .Config.Labels \"com.docker.compose.project\")}},\"service\":{{json (index .Config.Labels \"com.docker.compose.service\")}},\"image\":{{json .Config.Image}},\"state\":{{json .State.Status}}}";
export const DOMAIN_ROUTE_CONTAINER_INSPECT_FORMAT = "{\"id\":{{json .Id}},\"name\":{{json .Name}},\"owner\":{{json (index .Config.Labels \"com.deploylite.owner\")}},\"project\":{{json (index .Config.Labels \"com.deploylite.project\")}},\"deployment\":{{json (index .Config.Labels \"com.deploylite.deployment\")}},\"state\":{{json .State.Status}}}";

export function buildDomainRouteTraefikLookupArgv(): readonly string[] {
  return Object.freeze(["docker", "container", "ls", "--all", "--filter", "label=com.docker.compose.project=deploylite",
    "--filter", "label=com.docker.compose.service=traefik", "--format", "{{.ID}}"]);
}

export function buildDomainRouteTraefikInspectArgv(containerId: string): readonly string[] {
  if (!objectId.test(containerId)) throw new Error("Traefik container identity is invalid");
  return Object.freeze(["docker", "container", "inspect", "--format", DOMAIN_ROUTE_TRAEFIK_INSPECT_FORMAT, containerId]);
}

export function buildDomainRouteNetworkInspectArgv(name: string): readonly string[] {
  if (!networkName.test(name)) throw new Error("domain route network name is invalid");
  return Object.freeze(["docker", "network", "inspect", "--format", DOMAIN_ROUTE_NETWORK_INSPECT_FORMAT, name]);
}

export function buildDomainRouteNetworkCreateArgv(name: string, projectId: string): readonly string[] {
  if (!networkName.test(name) || !identity.test(projectId)) throw new Error("domain route network scope is invalid");
  return Object.freeze(["docker", "network", "create", "--driver", "bridge", "--label", "com.deploylite.owner=deploylite",
    "--label", `com.deploylite.project=${projectId}`, "--label", "com.deploylite.kind=domain-route", name]);
}

export function buildDomainRouteNetworkConnectArgv(name: string, containerId: string): readonly string[] {
  if (!networkName.test(name) || !objectId.test(containerId)) throw new Error("domain route network connection is invalid");
  return Object.freeze(["docker", "network", "connect", name, containerId]);
}

export function buildDomainRouteContainerInspectArgv(containerId: string): readonly string[] {
  if (!objectId.test(containerId)) throw new Error("domain route container identity is invalid");
  return Object.freeze(["docker", "container", "inspect", "--format", DOMAIN_ROUTE_CONTAINER_INSPECT_FORMAT, containerId]);
}

export { buildDockerActiveIdentityInspectArgv, buildDockerImageIdentityInspectArgv };
