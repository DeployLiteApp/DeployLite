import {
  createDeploymentPlan,
  createDeploymentSnapshot,
  createSourceIntent,
  type DeploymentSnapshotV1,
  type ImageReferencePolicyV1
} from "@deploylite/contracts";
import {
  DockerImageExecutor,
  FakeDockerImageTransport,
  InMemoryProtocolTransport,
  renderDockerImageCandidate,
  type DockerImageExecutionReceiptV1
} from "@deploylite/domain";
import { buildDockerRunArgv } from "./infrastructure/docker/docker-cli-argv.js";
import { DockerReconciliation } from "./infrastructure/docker/docker-reconciliation.js";
import { pathToFileURL } from "node:url";

export type DryRunScenario = "success" | "failure" | "canceled" | "invalid";
export type DockerDryRunReport = Readonly<Record<string, unknown>>;

const digest = `sha256:${"a".repeat(64)}`;
const policy: ImageReferencePolicyV1 = {
  policyVersion: "policy-1",
  trustedHosts: ["registry.example.com"],
  allowTags: true,
  allowDigests: true
};

function snapshot(scenario: DryRunScenario): DeploymentSnapshotV1 {
  const reference = scenario === "invalid" ? "registry.example.com/team/app:stable" : `registry.example.com/team/app@${digest}`;
  return createDeploymentSnapshot({
    deploymentId: "dep-dry-run",
    projectId: "project-dry-run",
    source: createSourceIntent({ sourceMode: "image", requestedReference: reference }, policy),
    configRevision: "config-1",
    runtimeRevision: "runtime-1",
    runtimePort: 43123,
    secretRefs: [],
    policyVersion: policy.policyVersion,
    schemaVersion: 1,
    resolvedDigest: scenario === "invalid" ? undefined : digest
  }, { sha256: () => "b".repeat(64) });
}

function protocol(): InMemoryProtocolTransport {
  return new InMemoryProtocolTransport({
    clock: { now: () => 1_000 },
    leasePolicy: { ttlMs: 10_000 },
    retryPolicy: { maxAttempts: 1, deadlineMs: 0, backoffMs: () => 0 },
    capabilities: ["deploy.execute"]
  });
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : "dry-run failed";
  return message.replace(/(?:password|token|secret|key)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]").slice(0, 160);
}

export async function runDockerContractDryRun(scenario: DryRunScenario = "success"): Promise<DockerDryRunReport> {
  const p = protocol();
  const s = snapshot(scenario);
  const plan = createDeploymentPlan(s);
  const transport = new FakeDockerImageTransport(scenario === "failure" ? { health: [false] } : undefined);
  const controller = new AbortController();
  if (scenario === "canceled") controller.abort();
  try {
    if (plan.status !== "executable") throw new Error(plan.blocked?.code ?? "deployment plan blocked");
    const lease = p.claimLease(s.deploymentId);
    const input = { snapshot: s, commandId: "candidate-1", lease, networkName: "deploylite", signal: controller.signal };
    const executor = new DockerImageExecutor({ protocol: p, transport, trustedHosts: policy.trustedHosts, allowedNetworks: ["deploylite"] });
    const result = await executor.execute(input);
    const candidate = renderDockerImageCandidate(input, policy.trustedHosts, ["deploylite"]);
    const reconciliation = new DockerReconciliation("agent-dry-run");
    const reconciled = reconciliation.reconcile(s.deploymentId, "candidate-1", []);
    const argv = buildDockerRunArgv({ candidate, containerName: reconciled.candidateName, hostPort: reconciled.hostPort, containerPort: s.runtimePort!, owner: "agent-dry-run", allowedNetworks: ["deploylite"], networkName: "deploylite" });
    return report(scenario, s, plan, result, argv, reconciled, p.getAck(s.deploymentId), transport.calls);
  } catch (error) {
    return {
      schemaVersion: 1,
      mode: "docker-contract-dry-run",
      scenario,
      ok: false,
      error: boundedError(error),
      effects: { processSpawned: false, networkAccessed: false, secretSourceRead: false, infrastructureMutated: false }
    };
  }
}

function report(scenario: DryRunScenario, s: DeploymentSnapshotV1, plan: ReturnType<typeof createDeploymentPlan>, result: DockerImageExecutionReceiptV1, argv: readonly string[], reconciliation: ReturnType<DockerReconciliation["reconcile"]>, ack: unknown, calls: readonly string[]): DockerDryRunReport {
  return {
    schemaVersion: 1,
    mode: "docker-contract-dry-run",
    scenario,
    ok: result.terminalStatus === "succeeded",
    snapshot: { hash: s.hash, sourceMode: s.source.sourceMode, reference: s.source.sourceMode === "image" ? s.source.image.redactedReference : "build", runtimePort: s.runtimePort },
    plan: { status: plan.status, steps: plan.steps.map((step) => step.action) },
    candidate: { image: result.effectiveImage, runtimePort: result.runtimePort, reconciliation },
    dockerArgv: argv,
    protocol: { terminalAck: (ack as { kind?: string } | null)?.kind ?? null, transportCalls: calls.slice(0, 8) },
    result: { health: result.health, terminalStatus: result.terminalStatus, rollback: result.rollback, proven: result.proven },
    effects: { processSpawned: false, networkAccessed: false, secretSourceRead: false, infrastructureMutated: false }
  };
}

async function main(): Promise<void> {
  const scenario = (process.argv[2] ?? "success") as DryRunScenario;
  if (!["success", "failure", "canceled", "invalid"].includes(scenario)) {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, mode: "docker-contract-dry-run", scenario, ok: false, error: "scenario is invalid" }) + "\n");
    process.exitCode = 2;
    return;
  }
  const result = await runDockerContractDryRun(scenario);
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
