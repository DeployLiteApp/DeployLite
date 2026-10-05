import { createHash } from "node:crypto";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { redactLogMessage } from "@deploylite/config";
import { createDeploymentSnapshot, trustedPriorExecutionReceiptSchema, type Agent, type Deployment, type DeploymentSnapshotV1, type LogEvent, type Project } from "@deploylite/contracts";
import type { AgentRepository, DeploymentRepository, DeploymentSnapshotRepository, ProjectRepository } from "@deploylite/domain";

import type { DeployLiteDb } from "../client.js";
import { agents, deploymentLogs, deployments, projects } from "../schema.js";


export class DbAgentRepository implements AgentRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async save(agent: Agent): Promise<Agent> {
    const [row] = await this.db
      .insert(agents)
      .values({
        id: agent.id,
        name: agent.name,
        endpoint: agent.endpoint,
        status: agent.status,
        lastHeartbeatAt: agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt) : null,
        resourceSnapshot: agent.resourceSnapshot
      })
      .onConflictDoUpdate({
        target: agents.id,
        set: {
          name: agent.name,
          endpoint: agent.endpoint,
          status: agent.status,
          lastHeartbeatAt: agent.lastHeartbeatAt ? new Date(agent.lastHeartbeatAt) : null,
          resourceSnapshot: agent.resourceSnapshot,
          updatedAt: new Date()
        }
      })
      .returning();

    if (!row) throw new Error("Failed to save agent");
    return toAgent(row);
  }

  async findById(id: string): Promise<Agent | null> {
    const [row] = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return row ? toAgent(row) : null;
  }

  async list(): Promise<Agent[]> {
    const rows = await this.db.select().from(agents);
    return rows.map(toAgent);
  }
}

export class DbProjectRepository implements ProjectRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async save(project: Project): Promise<Project> {
    const [row] = await this.db
      .insert(projects)
      .values({
        id: project.id,
        name: project.name,
        repoUrl: project.repoUrl,
        defaultBranch: project.defaultBranch,
        buildCommand: project.buildCommand,
        runCommand: project.runCommand,
        port: project.port,
        description: project.description,
        imageTag: project.imageTag
      })
      .onConflictDoUpdate({
        target: projects.id,
        set: {
          name: project.name,
          repoUrl: project.repoUrl,
          defaultBranch: project.defaultBranch,
          buildCommand: project.buildCommand,
          runCommand: project.runCommand,
          port: project.port,
          description: project.description,
          imageTag: project.imageTag,
          updatedAt: new Date()
        }
      })
      .returning();

    if (!row) throw new Error("Failed to save project");
    return toProject(row);
  }

  async list(): Promise<Project[]> {
    const rows = await this.db.select().from(projects);
    return rows.map(toProject);
  }

  async findById(id: string): Promise<Project | null> {
    const [row] = await this.db.select().from(projects).where(eq(projects.id, id)).limit(1);
    return row ? toProject(row) : null;
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id });
    return result.length > 0;
  }
}

function toProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    name: row.name,
    repoUrl: row.repoUrl,
    defaultBranch: row.defaultBranch,
    buildCommand: row.buildCommand,
    runCommand: row.runCommand,
    port: row.port,
    description: row.description,
    imageTag: row.imageTag
  };
}

export class DbDeploymentRepository implements DeploymentRepository, DeploymentSnapshotRepository {
  constructor(private readonly db: DeployLiteDb) {}

  async save(deployment: Deployment): Promise<Deployment> {
    const next = structuredClone(deployment);
    const metadataValue = {
      ...(next.sourceDeploymentId ? { sourceDeploymentId: next.sourceDeploymentId } : {}),
      ...(next.snapshotOriginId ? { snapshotOriginId: next.snapshotOriginId } : {}),
      ...(next.stopTarget ? { stopTarget: next.stopTarget } : {})
    };
    const [row] = await this.db
      .insert(deployments)
      .values({
        id: next.id,
        projectId: next.projectId,
        agentId: next.agentId,
        status: next.status,
        commitSha: next.commitSha,
        snapshotHash: next.snapshotHash ?? null,
        executionReceipt: next.executionReceipt ? trustedPriorExecutionReceiptSchema.parse(next.executionReceipt) : null,
        startedAt: new Date(next.startedAt),
        finishedAt: next.finishedAt ? new Date(next.finishedAt) : null,
        metadata: metadataValue
      })
      .onConflictDoUpdate({
        target: deployments.id,
        set: mutableDeploymentValues(next),
        setWhere: genericDeploymentWriteGuard(next)
      })
      .returning();

    if (!row) throw new Error("Deployment identity, snapshot, proof, and terminal outcome are immutable");
    const saved = toDeployment(row);
    if (!saved) throw new Error("Failed to save attached deployment");
    return saved;
  }

  async saveIfStatus(deployment: Deployment, expectedStatus: Deployment["status"]): Promise<Deployment | null> {
    const next = structuredClone(deployment);
    const [row] = await this.db.update(deployments)
      .set(mutableDeploymentValues(next))
      .where(and(eq(deployments.id, next.id), eq(deployments.status, expectedStatus), genericDeploymentWriteGuard(next)))
      .returning();
    return row ? toDeployment(row) : null;
  }

  async saveSnapshot(snapshot: DeploymentSnapshotV1): Promise<void> {
    const next = structuredClone(snapshot);
    const equalEvidence = and(eq(deployments.snapshotHash, next.hash), eq(deployments.snapshotEvidence, next.canonicalJson));
    const result = await this.db.update(deployments)
      .set({ snapshotHash: next.hash, snapshotEvidence: next.canonicalJson, updatedAt: new Date() })
      .where(and(
        eq(deployments.id, next.deploymentId), eq(deployments.projectId, next.projectId),
        sql`(${deployments.snapshotHash} is null or ${deployments.snapshotHash} = ${next.hash})`,
        sql`(${deployments.snapshotEvidence} is null or ${deployments.snapshotEvidence} = ${next.canonicalJson})`,
        sql`(${equalEvidence} or (${deployments.status} in ('queued', 'running') and ${deployments.executionReceipt} is null))`
      ))
      .returning({ id: deployments.id });
    if (!result.length) throw new Error("Deployment is missing or its snapshot is immutable");
  }

  async findByHash(hash: string): Promise<DeploymentSnapshotV1 | null> {
    const [row] = await this.db.select({
      id: deployments.id,
      projectId: deployments.projectId,
      agentId: deployments.agentId,
      commitSha: deployments.commitSha,
      hash: deployments.snapshotHash,
      evidence: deployments.snapshotEvidence
    }).from(deployments)
      .where(and(eq(deployments.snapshotHash, hash), isNotNull(deployments.snapshotEvidence)))
      .limit(1);
    if (!row) return null;
    try {
      const data = JSON.parse(row.evidence!) as DeploymentSnapshotV1;
      if (data.schemaVersion !== 1 || data.source?.schemaVersion !== 1
        || (data.source.sourceMode !== "build" && data.source.sourceMode !== "image")
        || typeof data.sourceSchemaVersion !== "number"
        || (data.runtimePort !== null && typeof data.runtimePort !== "number")) {
        throw new Error("Invalid canonical snapshot data");
      }
      const snapshot = createDeploymentSnapshot({ ...data, schemaVersion: data.sourceSchemaVersion }, {
        sha256: (bytes) => createHash("sha256").update(bytes).digest("hex")
      });
      if (snapshot.canonicalJson !== row.evidence || snapshot.hash !== hash || snapshot.hash !== row.hash
        || snapshot.deploymentId !== row.id || snapshot.projectId !== row.projectId
        || (snapshot.agentId !== undefined && snapshot.agentId !== row.agentId)
        || (snapshot.commitSha !== undefined && snapshot.commitSha !== row.commitSha)) {
        throw new Error("Canonical snapshot binding mismatch");
      }
      return snapshot;
    } catch (cause) {
      throw new Error("Stored deployment snapshot evidence is invalid", { cause });
    }
  }

  async findById(id: string): Promise<Deployment | null> {
    const [row] = await this.db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
    return row ? toDeployment(row) : null;
  }

  async list(): Promise<Deployment[]> {
    const rows = await this.db.select().from(deployments).where(isNotNull(deployments.agentId)).orderBy(asc(deployments.startedAt), asc(deployments.createdAt));
    return rows.map(toDeployment).filter((deployment): deployment is Deployment => deployment !== null);
  }

  async appendLog(event: LogEvent): Promise<LogEvent> {
    const [row] = await this.db
      .insert(deploymentLogs)
      .values({
        id: event.id,
        deploymentId: event.deploymentId,
        sequence: event.sequence,
        level: event.level,
        message: redactLogMessage(event.message),
        redactionApplied: true,
        requestId: event.requestId,
        correlationId: event.correlationId
      })
      .returning();

    if (!row) throw new Error("Failed to append deployment log");
    return toLogEvent(row);
  }

  async listLogs(deploymentId: string, afterSequence = -1): Promise<LogEvent[]> {
    const rows = await this.db.select().from(deploymentLogs).where(eq(deploymentLogs.deploymentId, deploymentId)).orderBy(asc(deploymentLogs.sequence));
    return toOrderedLogEvents(rows.filter((row) => row.sequence > afterSequence));
  }
}

function mutableDeploymentValues(next: Deployment) {
  return {
    status: next.status,
    finishedAt: next.finishedAt ? new Date(next.finishedAt) : null,
    ...(next.stopTarget ? { metadata: sql`coalesce(${deployments.metadata}, '{}'::jsonb) || jsonb_build_object('stopTarget', ${JSON.stringify(next.stopTarget)}::jsonb)` } : {}),
    updatedAt: new Date()
  };
}

function genericDeploymentWriteGuard(next: Deployment) {
  return and(
    eq(deployments.projectId, next.projectId), eq(deployments.agentId, next.agentId), eq(deployments.commitSha, next.commitSha),
    sql`coalesce(${deployments.startedAt}, ${deployments.createdAt}) = ${next.startedAt}::timestamptz`,
    sql`${deployments.metadata}->>'sourceDeploymentId' is not distinct from ${next.sourceDeploymentId ?? null}`,
    sql`${deployments.metadata}->>'snapshotOriginId' is not distinct from ${next.snapshotOriginId ?? null}`,
    // Omitted hashes retain evidence attached by saveSnapshot before a legacy lifecycle update.
    next.snapshotHash === undefined ? undefined : sql`${deployments.snapshotHash} is not distinct from ${next.snapshotHash}`,
    sql`${deployments.executionReceipt} is not distinct from ${next.executionReceipt ? JSON.stringify(next.executionReceipt) : null}::jsonb`,
    sql`(${deployments.status} not in ('succeeded', 'failed', 'canceled') or (
      ${deployments.status} = ${next.status}
      and ${deployments.finishedAt} is not distinct from ${next.finishedAt}::timestamptz
      and ${deployments.metadata}->'stopTarget' is not distinct from ${next.stopTarget ? JSON.stringify(next.stopTarget) : null}::jsonb
    ))`
  );
}

function toAgent(row: typeof agents.$inferSelect): Agent {
  return {
    id: row.id,
    name: row.name,
    endpoint: row.endpoint,
    status: row.status === "online" || row.status === "stale" ? row.status : "offline",
    lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
    resourceSnapshot: toResourceSnapshot(row.resourceSnapshot)
  };
}

function toResourceSnapshot(value: Record<string, unknown> | null): Agent["resourceSnapshot"] {
  if (!value) return null;

  const { cpuLoad, memoryUsedBytes, memoryTotalBytes, diskUsedBytes, diskTotalBytes } = value;
  if (
    typeof cpuLoad === "number" &&
    typeof memoryUsedBytes === "number" &&
    typeof memoryTotalBytes === "number" &&
    typeof diskUsedBytes === "number" &&
    typeof diskTotalBytes === "number"
  ) {
    return { cpuLoad, memoryUsedBytes, memoryTotalBytes, diskUsedBytes, diskTotalBytes };
  }

  return null;
}

export function toDeployment(row: typeof deployments.$inferSelect): Deployment | null {
  if (!row.agentId) {
    return null;
  }

  return structuredClone({
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    status: row.status === "running" || row.status === "succeeded" || row.status === "failed" || row.status === "canceled" ? row.status : "queued",
    commitSha: row.commitSha,
    startedAt: row.startedAt?.toISOString() ?? row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    ...(row.metadata && typeof row.metadata === "object" && row.metadata["stopTarget"] ? { stopTarget: row.metadata["stopTarget"] as Deployment["stopTarget"] } : {}),
    ...(row.metadata && typeof row.metadata === "object" && typeof row.metadata["sourceDeploymentId"] === "string" ? { sourceDeploymentId: row.metadata["sourceDeploymentId"] } : {}),
    ...(typeof row.metadata?.["snapshotOriginId"] === "string" ? { snapshotOriginId: row.metadata["snapshotOriginId"] } : {}),
    ...(row.snapshotHash ? { snapshotHash: row.snapshotHash } : {}),
    ...(row.executionReceipt ? { executionReceipt: trustedPriorExecutionReceiptSchema.parse(row.executionReceipt) } : {})
  });
}

export function toLogEvent(row: typeof deploymentLogs.$inferSelect): LogEvent {
  return {
    id: row.id,
    deploymentId: row.deploymentId,
    sequence: row.sequence,
    level: row.level === "debug" || row.level === "warn" || row.level === "error" ? row.level : "info",
    message: row.message,
    timestamp: row.createdAt.toISOString(),
    redactionApplied: row.redactionApplied,
    requestId: row.requestId,
    correlationId: row.correlationId
  };
}

export function toOrderedLogEvents(rows: Array<typeof deploymentLogs.$inferSelect>): LogEvent[] {
  return [...rows].sort((left, right) => left.sequence - right.sequence).map(toLogEvent);
}
