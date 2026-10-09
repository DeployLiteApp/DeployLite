import type { TrustedPriorExecutionReceiptV1, DeploymentExecutionAuthorityV1, ComposePreviewV1, ProjectControlAuthorityV1 } from "@deploylite/contracts";
import { sql } from "drizzle-orm";
import { boolean, check, customType, foreignKey, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; notNull: false; default: false }>({
  dataType() {
    return "bytea";
  }
});

export const canonicalRoleNames = ["admin", "operator", "read-only", "auditor"] as const;
export type CanonicalRoleName = (typeof canonicalRoleNames)[number];

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
};

const jsonObject = <Name extends string>(name: Name) => jsonb(name).$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("roles_name_unique").on(table.name),
    check("roles_name_canonical", sql`${table.name} in ('admin', 'operator', 'read-only', 'auditor')`)
  ]
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    emailNormalized: text("email_normalized").notNull(),
    passwordHash: text("password_hash").notNull(),
    roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "restrict", onUpdate: "cascade" }),
    status: text("status").notNull().default("active"),
    ...timestamps
  },
  (table) => [
    uniqueIndex("users_email_normalized_unique").on(table.emailNormalized),
    index("users_role_id_idx").on(table.roleId),
    check("users_status_valid", sql`${table.status} in ('active', 'disabled')`),
    check("users_email_normalized_lower", sql`${table.emailNormalized} = lower(${table.emailNormalized})`)
  ]
);

export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
  },
  (table) => [
    uniqueIndex("user_sessions_token_hash_unique").on(table.tokenHash),
    index("user_sessions_user_id_idx").on(table.userId),
    index("user_sessions_expires_at_idx").on(table.expiresAt)
  ]
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    status: text("status").notNull().default("active"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => [
    uniqueIndex("api_keys_key_hash_unique").on(table.keyHash),
    index("api_keys_user_id_idx").on(table.userId),
    check("api_keys_status_valid", sql`${table.status} in ('active', 'revoked')`)
  ]
);

export const servers = pgTable(
  "servers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    endpoint: text("endpoint").notNull(),
    status: text("status").notNull().default("offline"),
    metadata: jsonObject("metadata"),
    ...timestamps
  },
  (table) => [check("servers_status_valid", sql`${table.status} in ('online', 'offline', 'stale', 'disabled')`)]
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serverId: uuid("server_id").references(() => servers.id, { onDelete: "set null", onUpdate: "cascade" }),
    name: text("name").notNull(),
    endpoint: text("endpoint").notNull(),
    status: text("status").notNull().default("offline"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    resourceSnapshot: jsonb("resource_snapshot").$type<Record<string, unknown> | null>(),
    ...timestamps
  },
  (table) => [
    index("agents_server_id_idx").on(table.serverId),
    check("agents_status_valid", sql`${table.status} in ('online', 'offline', 'stale', 'disabled')`)
  ]
);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  repoUrl: text("repo_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  buildCommand: text("build_command"),
  runCommand: text("run_command"),
  port: integer("port"),
  description: text("description"),
  imageTag: text("image_tag"),
  ...timestamps
});

export const deployments = pgTable(
  "deployments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict", onUpdate: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null", onUpdate: "cascade" }),
    status: text("status").notNull().default("queued"),
    commitSha: text("commit_sha").notNull(),
    snapshotHash: text("snapshot_hash"),
    snapshotEvidence: text("snapshot_evidence"),
    executionReceipt: jsonb("execution_receipt").$type<TrustedPriorExecutionReceiptV1 | null>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    metadata: jsonObject("metadata"),
    ...timestamps
  },
  (table) => [
    index("deployments_project_id_idx").on(table.projectId),
    index("deployments_agent_id_idx").on(table.agentId),
    uniqueIndex("deployments_id_project_id_unique").on(table.id, table.projectId),
    index("deployments_snapshot_hash_idx").on(table.snapshotHash).where(sql`${table.snapshotHash} is not null`),
    check("deployments_status_valid", sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'canceled')`)
  ]
);

export const deploymentLogs = pgTable(
  "deployment_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    deploymentId: uuid("deployment_id").notNull().references(() => deployments.id, { onDelete: "cascade", onUpdate: "cascade" }),
    sequence: integer("sequence").notNull(),
    level: text("level").notNull(),
    message: text("message").notNull(),
    redactionApplied: boolean("redaction_applied").notNull().default(true),
    requestId: text("request_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("deployment_logs_deployment_sequence_unique").on(table.deploymentId, table.sequence),
    index("deployment_logs_deployment_id_idx").on(table.deploymentId),
    check("deployment_logs_level_valid", sql`${table.level} in ('debug', 'info', 'warn', 'error')`)
  ]
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    requestId: text("request_id").notNull(),
    correlationId: text("correlation_id").notNull(),
    metadata: jsonObject("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("audit_events_actor_user_id_idx").on(table.actorUserId),
    index("audit_events_created_at_idx").on(table.createdAt),
    index("audit_events_target_idx").on(table.targetType, table.targetId)
  ]
);

export const envVariableMetadata = pgTable(
  "env_variable_metadata",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    key: text("key").notNull(),
    scope: text("scope").notNull().default("project"),
    valuePresent: boolean("value_present").notNull().default(false),
    valueFingerprint: text("value_fingerprint"),
    required: boolean("required").notNull().default(false),
    description: text("description"),
    metadata: jsonObject("metadata"),
    ...timestamps
  },
  (table) => [
    uniqueIndex("env_variable_metadata_project_key_scope_unique").on(table.projectId, table.key, table.scope),
    index("env_variable_metadata_project_id_idx").on(table.projectId),
    check("env_variable_metadata_scope_valid", sql`${table.scope} in ('project', 'deployment')`)
  ]
);

export const envSecretValues = pgTable(
  "env_secret_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    key: text("key").notNull(),
    scope: text("scope").notNull().default("project"),
    encryptedValue: bytea("encrypted_value").notNull(),
    valueFingerprint: text("value_fingerprint").notNull(),
    keyVersion: smallint("key_version").notNull().default(1),
    ...timestamps
  },
  (table) => [
    uniqueIndex("env_secret_values_project_key_scope_unique").on(table.projectId, table.key, table.scope),
    index("env_secret_values_project_id_idx").on(table.projectId),
    check("env_secret_values_scope_valid", sql`${table.scope} in ('project', 'deployment')`),
    check(
      "env_secret_values_key_fingerprint_not_blank",
      sql`length(btrim(${table.valueFingerprint})) > 0`
    ),
    check("env_secret_values_key_version_positive", sql`${table.keyVersion} > 0`)
  ]
);

export const controlCommands = pgTable(
  "control_commands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    action: text("action").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeKey: text("scope_key").notNull(),
    inputDigest: text("input_digest").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    correlationId: text("correlation_id").notNull(),
    status: text("status").notNull().default("pending"),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    executionAuthority: jsonb("execution_authority").$type<DeploymentExecutionAuthorityV1 | ProjectControlAuthorityV1 | null>(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps
  },
  (table) => [
    uniqueIndex("control_commands_idempotency_unique").on(table.actorUserId, table.action, table.scopeKey, table.idempotencyKey),
    index("control_commands_actor_user_id_idx").on(table.actorUserId),
    check("control_commands_action_valid", sql`${table.action} in ('project.delete', 'project.deploy', 'project.update', 'deployment.stop', 'deployment.redeploy', 'deployment.rollback', 'platform.agent.register')`),
    check("control_commands_scope_valid", sql`${table.scopeKind} in ('platform', 'project', 'deployment')`),
    check("control_commands_status_valid", sql`${table.status} in ('pending_confirmation', 'eligible', 'dispatching', 'rejected', 'completed')`)
  ]
);

export const controlGrants = pgTable(
  "control_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
    action: text("action").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeKey: text("scope_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("control_grants_actor_action_scope_unique").on(table.actorUserId, table.action, table.scopeKind, table.scopeKey),
    index("control_grants_actor_user_id_idx").on(table.actorUserId),
    check("control_grants_action_valid", sql`${table.action} in ('project.delete', 'project.deploy', 'project.update', 'deployment.stop', 'deployment.redeploy', 'deployment.rollback', 'platform.agent.register')`),
    check("control_grants_scope_valid", sql`${table.scopeKind} in ('platform', 'project')`)
  ]
);

export const controlCommandConfirmations = pgTable(
  "control_command_confirmations",
  {
    id: uuid("id").primaryKey(), commandId: uuid("command_id").notNull().unique().references(() => controlCommands.id, { onDelete: "restrict", onUpdate: "cascade" }),
    actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }), action: text("action").notNull(),
    scopeKind: text("scope_kind").notNull(), scopeKey: text("scope_key").notNull(), inputDigest: text("input_digest").notNull(),
    classification: text("classification").notNull(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("control_command_confirmations_actor_user_id_idx").on(table.actorUserId)]
);

export const controlCommandAudits = pgTable(
  "control_command_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(), commandId: uuid("command_id").notNull().references(() => controlCommands.id, { onDelete: "restrict", onUpdate: "cascade" }),
    confirmationId: uuid("confirmation_id").references(() => controlCommandConfirmations.id, { onDelete: "restrict", onUpdate: "cascade" }), correlationId: text("correlation_id").notNull(),
    outcome: text("outcome").notNull(), reason: text("reason"), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("control_command_audits_command_id_idx").on(table.commandId), index("control_command_audits_correlation_id_idx").on(table.correlationId)]
);

export const agentReplay = pgTable("agent_replay", {
  commandId: text("command_id").primaryKey(), fingerprint: text("fingerprint").notNull(),
  status: text("status").notNull().default("in_progress"), claimOwner: text("claim_owner").notNull(),
  leaseId: text("lease_id").notNull(), claimToken: text("claim_token").notNull(), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
  receipt: jsonb("receipt").$type<Record<string, unknown> | null>(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(), resolvedAt: timestamp("resolved_at", { withTimezone: true })
}, (table) => [index("agent_replay_status_lease_idx").on(table.status, table.leaseExpiresAt), check("agent_replay_status_valid", sql`${table.status} in ('in_progress', 'completed')`)]);

export const domains = pgTable(
  "domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    hostname: text("hostname").notNull(),
    deploymentId: uuid("deployment_id").references(() => deployments.id, { onDelete: "set null", onUpdate: "cascade" }),
    status: text("status").notNull().default("pending"),
    metadata: jsonObject("metadata"),
    ...timestamps
  },
  (table) => [
    uniqueIndex("domains_hostname_unique").on(table.hostname),
    uniqueIndex("domains_id_project_hostname_unique").on(table.id, table.projectId, table.hostname),
    index("domains_deployment_id_idx").on(table.deploymentId),
    index("domains_project_id_idx").on(table.projectId),
    check("domains_status_valid", sql`${table.status} in ('pending', 'active', 'failed', 'disabled')`)
  ]
);

export const domainRouteRevisions = pgTable("domain_route_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  domainId: uuid("domain_id").notNull(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
  hostname: text("hostname").notNull(),
  deploymentId: uuid("deployment_id").notNull().references(() => deployments.id, { onDelete: "restrict", onUpdate: "cascade" }),
  revisionNumber: integer("revision_number").notNull(),
  operation: text("operation").notNull(),
  commandId: uuid("command_id").references(() => controlCommands.id, { onDelete: "restrict", onUpdate: "cascade" }),
  rollbackRevisionId: uuid("rollback_revision_id").references((): AnyPgColumn => domainRouteRevisions.id, { onDelete: "cascade", onUpdate: "cascade" }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
  correlationId: text("correlation_id"),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  foreignKey({ name: "domain_route_revisions_domain_fk", columns: [table.domainId, table.projectId, table.hostname],
    foreignColumns: [domains.id, domains.projectId, domains.hostname] }).onDelete("cascade").onUpdate("cascade"),
  uniqueIndex("domain_route_revisions_domain_number_unique").on(table.domainId, table.revisionNumber),
  uniqueIndex("domain_route_revisions_command_unique").on(table.commandId).where(sql`${table.commandId} is not null`),
  index("domain_route_revisions_project_hostname_idx").on(table.projectId, table.hostname, table.revisionNumber),
  check("domain_route_revisions_number_positive", sql`${table.revisionNumber} > 0`),
  check("domain_route_revisions_operation_valid", sql`${table.operation} in ('baseline', 'apply', 'rollback')`),
  check("domain_route_revisions_evidence_redacted", sql`(jsonb_typeof(${table.evidence}) = 'object' and ${table.evidence}->'redacted' = 'true'::jsonb and (${table.evidence} - 'state' - 'contentDigest' - 'observedAt' - 'redacted') = '{}'::jsonb) is true`),
  check("domain_route_revisions_operation_binding", sql`(${table.operation} = 'baseline' and ${table.commandId} is null and ${table.rollbackRevisionId} is null) or (${table.operation} = 'apply' and ${table.commandId} is not null and ${table.rollbackRevisionId} is null) or (${table.operation} = 'rollback' and ${table.commandId} is not null and ${table.rollbackRevisionId} is not null)`)
]);
export type DomainRouteRevisionRow = typeof domainRouteRevisions.$inferSelect;

export const domainRouteReservations = pgTable("domain_route_reservations", {
  hostname: text("hostname").primaryKey(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict", onUpdate: "cascade" }),
  commandId: uuid("command_id").notNull().unique().references(() => controlCommands.id, { onDelete: "restrict", onUpdate: "cascade" }),
  route: jsonb("route").$type<Record<string, unknown>>().notNull(),
  plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
  operation: text("operation").notNull().default("apply"),
  rollbackRevisionId: uuid("rollback_revision_id").references(() => domainRouteRevisions.id, { onDelete: "restrict", onUpdate: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  index("domain_route_reservations_project_idx").on(table.projectId),
  check("domain_route_reservations_route_scope", sql`(${table.route}->>'domain' = ${table.hostname} and ${table.route}->>'projectId' = ${table.projectId}::text and ${table.plan}->'route' = ${table.route}) is true`),
  check("domain_route_reservations_plan_action_valid", sql`${table.plan}->>'action' in ('create', 'attach', 'retarget', 'no-op')`),
  check("domain_route_reservations_operation_valid", sql`(${table.operation} = 'apply' and ${table.rollbackRevisionId} is null) or (${table.operation} = 'rollback' and ${table.rollbackRevisionId} is not null)`)
]);

export const transportPortClaims = pgTable("transport_port_claims", {
  protocol: text("protocol").notNull(),
  publishedPort: integer("published_port").notNull(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict", onUpdate: "cascade" }),
  deploymentId: uuid("deployment_id"),
  targetPort: integer("target_port").notNull(),
  ...timestamps
}, (table) => [
  primaryKey({ name: "transport_port_claims_protocol_published_port_pk", columns: [table.protocol, table.publishedPort] }),
  foreignKey({ name: "transport_port_claims_deployment_project_fk", columns: [table.deploymentId, table.projectId], foreignColumns: [deployments.id, deployments.projectId] })
    .onDelete("restrict").onUpdate("cascade"),
  index("transport_port_claims_project_idx").on(table.projectId),
  index("transport_port_claims_deployment_project_idx").on(table.deploymentId, table.projectId),
  check("transport_port_claims_protocol_valid", sql`${table.protocol} in ('tcp', 'udp')`),
  check("transport_port_claims_published_port_valid", sql`${table.publishedPort} between 1 and 65535`),
  check("transport_port_claims_target_port_valid", sql`${table.targetPort} between 1 and 65535`)
]);
export type TransportPortClaimRow = typeof transportPortClaims.$inferSelect;

export const transportPortRevisions = pgTable("transport_port_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict", onUpdate: "cascade" }),
  protocol: text("protocol").notNull(),
  publishedPort: integer("published_port").notNull(),
  deploymentId: uuid("deployment_id").notNull(),
  targetPort: integer("target_port").notNull(),
  revisionNumber: integer("revision_number").notNull(),
  operation: text("operation").notNull(),
  commandId: uuid("command_id").notNull().references(() => controlCommands.id, { onDelete: "restrict", onUpdate: "cascade" }),
  rollbackRevisionId: uuid("rollback_revision_id").references((): AnyPgColumn => transportPortRevisions.id, { onDelete: "restrict", onUpdate: "cascade" }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null", onUpdate: "cascade" }),
  correlationId: text("correlation_id").notNull(),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  foreignKey({ name: "transport_port_revisions_deployment_project_fk", columns: [table.deploymentId, table.projectId],
    foreignColumns: [deployments.id, deployments.projectId] }).onDelete("restrict").onUpdate("cascade"),
  uniqueIndex("transport_port_revisions_key_number_unique").on(table.protocol, table.publishedPort, table.revisionNumber),
  uniqueIndex("transport_port_revisions_command_unique").on(table.commandId),
  index("transport_port_revisions_project_key_idx").on(table.projectId, table.protocol, table.publishedPort, table.revisionNumber),
  check("transport_port_revisions_protocol_valid", sql`${table.protocol} in ('tcp', 'udp')`),
  check("transport_port_revisions_published_port_valid", sql`${table.publishedPort} between 1 and 65535`),
  check("transport_port_revisions_target_port_valid", sql`${table.targetPort} between 1 and 65535`),
  check("transport_port_revisions_number_positive", sql`${table.revisionNumber} > 0`),
  check("transport_port_revisions_operation_valid", sql`${table.operation} in ('apply', 'rollback')`),
  check("transport_port_revisions_evidence_redacted", sql`(jsonb_typeof(${table.evidence}) = 'object' and ${table.evidence}->'redacted' = 'true'::jsonb and (${table.evidence} - 'state' - 'observedAt' - 'redacted') = '{}'::jsonb) is true`),
  check("transport_port_revisions_operation_binding", sql`(${table.operation} = 'apply' and ${table.rollbackRevisionId} is null) or (${table.operation} = 'rollback' and ${table.rollbackRevisionId} is not null)`)
]);
export type TransportPortRevisionRow = typeof transportPortRevisions.$inferSelect;

export const transportPortRuntimeStates = pgTable("transport_port_runtime_states", {
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict", onUpdate: "cascade" }),
  deploymentId: uuid("deployment_id").notNull(),
  containerId: text("container_id").notNull(),
  bindings: jsonb("bindings").$type<Record<string, unknown>[]>().notNull(),
  commandId: uuid("command_id").notNull().unique().references(() => controlCommands.id, { onDelete: "restrict", onUpdate: "cascade" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  primaryKey({ name: "transport_port_runtime_states_project_deployment_pk", columns: [table.projectId, table.deploymentId] }),
  foreignKey({ name: "transport_port_runtime_states_deployment_project_fk", columns: [table.deploymentId, table.projectId],
    foreignColumns: [deployments.id, deployments.projectId] }).onDelete("restrict").onUpdate("cascade"),
  index("transport_port_runtime_states_project_updated_idx").on(table.projectId, table.updatedAt),
  check("transport_port_runtime_states_container_id_valid", sql`${table.containerId} ~ '^[a-f0-9]{64}$'`),
  check("transport_port_runtime_states_bindings_array", sql`jsonb_typeof(${table.bindings}) = 'array'`)
]);
export type TransportPortRuntimeStateRow = typeof transportPortRuntimeStates.$inferSelect;

export const transportPortReservations = pgTable("transport_port_reservations", {
  protocol: text("protocol").notNull(),
  publishedPort: integer("published_port").notNull(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "restrict", onUpdate: "cascade" }),
  commandId: uuid("command_id").notNull().unique().references(() => controlCommands.id, { onDelete: "restrict", onUpdate: "cascade" }),
  route: jsonb("route").$type<Record<string, unknown>>().notNull(),
  plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
  currentContainerId: text("current_container_id").notNull(),
  bindings: jsonb("bindings").$type<Record<string, unknown>[]>().notNull(),
  previousBindings: jsonb("previous_bindings").$type<Record<string, unknown>[]>().notNull(),
  operation: text("operation").notNull().default("apply"),
  rollbackRevisionId: uuid("rollback_revision_id").references(() => transportPortRevisions.id, { onDelete: "restrict", onUpdate: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  primaryKey({ name: "transport_port_reservations_key_pk", columns: [table.protocol, table.publishedPort] }),
  index("transport_port_reservations_project_idx").on(table.projectId),
  check("transport_port_reservations_protocol_valid", sql`${table.protocol} in ('tcp', 'udp')`),
  check("transport_port_reservations_published_port_valid", sql`${table.publishedPort} between 1 and 65535`),
  check("transport_port_reservations_container_id_valid", sql`${table.currentContainerId} ~ '^[a-f0-9]{64}$'`),
  check("transport_port_reservations_bindings_array", sql`jsonb_typeof(${table.bindings}) = 'array' and jsonb_typeof(${table.previousBindings}) = 'array'`),
  check("transport_port_reservations_route_scope", sql`(${table.route}->>'protocol' = ${table.protocol} and (${table.route}->>'publishedPort')::integer = ${table.publishedPort} and ${table.route}->>'projectId' = ${table.projectId}::text and ${table.plan}->'route' = ${table.route}) is true`),
  check("transport_port_reservations_plan_action_valid", sql`${table.plan}->>'action' in ('create', 'attach', 'no-op', 'retarget')`),
  check("transport_port_reservations_operation_valid", sql`(${table.operation} = 'apply' and ${table.rollbackRevisionId} is null) or (${table.operation} = 'rollback' and ${table.rollbackRevisionId} is not null)`)
]);

export const certificates = pgTable(
  "certificates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domainId: uuid("domain_id").notNull().references(() => domains.id, { onDelete: "cascade", onUpdate: "cascade" }),
    provider: text("provider").notNull().default("acme-metadata-only"),
    status: text("status").notNull().default("pending"),
    notBefore: timestamp("not_before", { withTimezone: true }),
    notAfter: timestamp("not_after", { withTimezone: true }),
    metadata: jsonObject("metadata"),
    ...timestamps
  },
  (table) => [
    index("certificates_domain_id_idx").on(table.domainId),
    check("certificates_status_valid", sql`${table.status} in ('pending', 'issued', 'expired', 'revoked', 'failed')`)
  ]
);

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserSession = typeof userSessions.$inferSelect;
export type NewUserSession = typeof userSessions.$inferInsert;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type Server = typeof servers.$inferSelect;
export type NewServer = typeof servers.$inferInsert;
export type AgentRow = typeof agents.$inferSelect;
export type NewAgentRow = typeof agents.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type DeploymentRow = typeof deployments.$inferSelect;
export type NewDeploymentRow = typeof deployments.$inferInsert;
export type DeploymentLogRow = typeof deploymentLogs.$inferSelect;
export type NewDeploymentLogRow = typeof deploymentLogs.$inferInsert;
export type NewEnvVariableMetadata = typeof envVariableMetadata.$inferInsert;
export type EnvSecretValueRow = typeof envSecretValues.$inferSelect;
export type NewEnvSecretValue = typeof envSecretValues.$inferInsert;
export type ControlCommandRow = typeof controlCommands.$inferSelect;
export type ControlGrantRow = typeof controlGrants.$inferSelect;
export type ControlCommandConfirmationRow = typeof controlCommandConfirmations.$inferSelect;
export type AgentReplayRow = typeof agentReplay.$inferSelect;

// Logical saved intent. Runtime resource ownership is a separate P3 boundary.
export const composeResources = pgTable("compose_resources", {
  id: uuid("id").primaryKey(), projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull()
}, (table) => [uniqueIndex("compose_resources_id_project_unique").on(table.id, table.projectId), index("compose_resources_project_idx").on(table.projectId)]);
export const composeRevisions = pgTable("compose_revisions", {
  id: uuid("id").primaryKey().references(() => controlCommands.id, { onDelete: "restrict", onUpdate: "cascade" }),
  composeId: uuid("compose_id").notNull(), projectId: uuid("project_id").notNull(), number: integer("number").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict", onUpdate: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), preview: jsonb("preview").$type<ComposePreviewV1>().notNull()
}, (table) => [foreignKey({ name: "compose_revisions_owner_fk", columns: [table.composeId, table.projectId], foreignColumns: [composeResources.id, composeResources.projectId] }).onDelete("cascade").onUpdate("cascade"),
  uniqueIndex("compose_revisions_number_unique").on(table.composeId, table.number), index("compose_revisions_project_idx").on(table.projectId),
  check("compose_revisions_number_positive", sql`${table.number} > 0`),
  check("compose_revisions_preview_safe", sql`(jsonb_typeof(${table.preview}) = 'object' and ${table.preview}->>'projectId' = ${table.projectId}::text and ${table.preview}->'executionAllowed' = 'false'::jsonb) is true`)]);
export type ComposeRevisionRow = typeof composeRevisions.$inferSelect;
