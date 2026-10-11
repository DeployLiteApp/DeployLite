import { managedDatabaseNativeImagePolicy, parseManagedDatabaseRuntimeConfiguration, type ProjectRepository } from "@deploylite/domain";
import type { ManagedDatabaseCredentialCreationRepository } from "@deploylite/domain";
import { parseComposeResourceProjectBindings, projectUpdateControls } from "./compose-resource-runtime.js";
import { AuthenticatedManagedDatabaseRuntimeTransport } from "./managed-database-runtime-transport.js";
import type { ManagedDatabaseRuntimeApplyAccess } from "./managed-database-runtime-apply.js";
import type { ManagedDatabaseCredentialConfiguration } from "./managed-database-credentials-route.js";
import { awaitAbortable } from "@deploylite/domain";
export const MANAGED_DATABASE_PROJECT_AGENTS_ENV = "DEPLOYLITE_MANAGED_DATABASE_PROJECT_AGENTS_JSON" as const;
export function parseManagedDatabaseApiConfiguration(raw: string | undefined, rawBindings: string | undefined) {
  if (raw === undefined && rawBindings === undefined) return undefined;
  try {
    const configuration = parseManagedDatabaseRuntimeConfiguration(raw);
    if (!configuration || rawBindings === undefined || rawBindings.length > 65536) throw new Error();
    const bindings = parseComposeResourceProjectBindings(rawBindings);
    if (!bindings.length) throw new Error();
    return { configuration, bindings };
  } catch { throw new Error("Database API configuration is invalid."); }
}
/** Existing authenticated endpoint/repositories only; explicit project binding supplies no network/runtime effect. */
export async function createConfiguredManagedDatabaseApi(input: Readonly<{
  parsed: NonNullable<ReturnType<typeof parseManagedDatabaseApiConfiguration>>;
  projects: Pick<ProjectRepository, "findById">; controls: unknown; secrets?: ManagedDatabaseCredentialCreationRepository;
  agent: Readonly<{ endpoint?: string; agentId?: string; trustKey?: string }>;
}>) {
  const controls = projectUpdateControls(input.controls), secrets = input.secrets;
  let parsed: NonNullable<ReturnType<typeof parseManagedDatabaseApiConfiguration>>;
  try { parsed = parseManagedDatabaseApiConfiguration(JSON.stringify(input.parsed.configuration), JSON.stringify(input.parsed.bindings))!; }
  catch { throw new Error("Database API configuration is invalid."); }
  const { configuration, bindings } = parsed, { endpoint, agentId, trustKey } = input.agent;
  if (!controls || !secrets || !endpoint || !agentId || !trustKey) throw new Error("Database API configuration is invalid.");
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), configuration.limits.deadlineMs);
  try {
    const transport = new AuthenticatedManagedDatabaseRuntimeTransport({ endpoint, agentId, trustKey, allowInsecureInternal: true, timeoutMs: configuration.limits.deadlineMs });
    if (!transport.available()) throw new Error();
    const executions = new Map<string, ManagedDatabaseRuntimeApplyAccess>();
    for (const binding of bindings) {
      if (binding.agentId !== agentId || executions.has(binding.projectId)) throw new Error();
      const project = await awaitAbortable(() => input.projects.findById(binding.projectId), controller.signal);
      if (!project || project.id !== binding.projectId) throw new Error();
      executions.set(binding.projectId, { controls, transport, agentId, now: Date.now,
        commandTtlMs: configuration.limits.deadlineMs, deadlineMs: configuration.limits.deadlineMs });
    }
    const credentials: ManagedDatabaseCredentialConfiguration = { profiles: new Map(Object.entries(configuration.profiles) as [keyof typeof configuration.profiles, typeof configuration.profiles.postgres][]),
      store: secrets, projectIds: new Set(bindings.map(binding => binding.projectId)), deadlineMs: configuration.limits.deadlineMs };
    return { credentials, executions, imagePolicy: managedDatabaseNativeImagePolicy() };
  } catch { throw new Error("Database API configuration is invalid."); }
  finally { clearTimeout(timer); }
}
