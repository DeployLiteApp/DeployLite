export type DockerContainerRecord = Readonly<{ name: string; owner: string; deploymentId: string; candidateId?: string; hostPort: number; running: boolean }>;
export type ReconciliationResult = Readonly<{ candidateName: string; hostPort: number; staleNames: readonly string[] }>;
export class DockerOwnershipConflictError extends Error { constructor(name: string) { super(`docker resource is owned by another deployment: ${name}`); this.name = "DockerOwnershipConflictError"; } }
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
function valid(value: string, label: string): void { if (!ID.test(value)) throw new Error(`${label} is unsafe`); }
export class DockerReconciliation {
  constructor(private readonly owner: string, private readonly basePort = 43000, private readonly maxPort = 65000) { valid(owner, "owner"); if (!Number.isInteger(basePort) || basePort < 1024 || basePort >= maxPort) throw new Error("port range is unsafe"); }
  candidateName(deploymentId: string, candidateId: string): string { valid(deploymentId, "deployment"); valid(candidateId, "candidate"); return `deploylite-candidate-${deploymentId}-${candidateId}`; }
  activeName(deploymentId: string): string { valid(deploymentId, "deployment"); return `deploylite-active-${deploymentId}`; }
  portFor(deploymentId: string): number { valid(deploymentId, "deployment"); let hash = 0; for (const char of deploymentId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0; return this.basePort + (hash % (this.maxPort - this.basePort)); }
  reconcile(deploymentId: string, candidateId: string, existing: readonly DockerContainerRecord[]): ReconciliationResult {
    const candidateName = this.candidateName(deploymentId, candidateId); const hostPort = this.portFor(deploymentId);
    for (const resource of existing) { if (resource.name === candidateName || resource.name === this.activeName(deploymentId)) { if (resource.owner !== this.owner || resource.deploymentId !== deploymentId) throw new DockerOwnershipConflictError(resource.name); } }
    return Object.freeze({ candidateName, hostPort, staleNames: existing.filter((resource) => resource.owner === this.owner && resource.deploymentId === deploymentId && resource.name !== candidateName).map((resource) => resource.name).sort() });
  }
  cleanupNames(result: ReconciliationResult): readonly string[] { return result.staleNames.filter((name) => name.startsWith("deploylite-candidate-") || name.startsWith("deploylite-active-")); }
}
