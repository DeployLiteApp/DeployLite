import { isAbsolute, relative, resolve, sep } from "node:path";

export const COMPOSE_VOLUME_BACKUP_CONFIG_ENV = "DEPLOYLITE_COMPOSE_VOLUME_BACKUP_ROOTS" as const;
export type ComposeVolumeBackupRuntimeConfig = Readonly<{
  sourceRoots: ReadonlyMap<string, string>;
  destinations: ReadonlyMap<string, string>;
}>;

const identity = /^[A-Za-z0-9_-]{1,200}$/;
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function roots(value: unknown): Map<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 128) return null;
  const result = new Map<string, string>();
  for (const [id, root] of entries) {
    if (!identity.test(id) || typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root) return null;
    result.set(id, root);
  }
  return result;
}

/** Parses only trusted runtime configuration; it never probes or creates configured paths. */
export function parseComposeVolumeBackupRuntimeConfig(raw: string | undefined): ComposeVolumeBackupRuntimeConfig | null {
  if (raw === undefined) return null;
  if (raw.length > 65_536) throw new Error("volume backup configuration is invalid");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("volume backup configuration is invalid"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    || Object.keys(parsed).some(key => key !== "sourceRoots" && key !== "destinations")) throw new Error("volume backup configuration is invalid");
  const sourceRoots = roots((parsed as Record<string, unknown>).sourceRoots), destinations = roots((parsed as Record<string, unknown>).destinations);
  if (!sourceRoots || !destinations || (sourceRoots.size === 0) !== (destinations.size === 0)) throw new Error("volume backup configuration is invalid");
  if (sourceRoots.size === 0) return null;
  for (const source of sourceRoots.values()) for (const destination of destinations.values()) {
    if (inside(source, destination) || inside(destination, source)) throw new Error("volume backup configuration is invalid");
  }
  return { sourceRoots, destinations };
}
