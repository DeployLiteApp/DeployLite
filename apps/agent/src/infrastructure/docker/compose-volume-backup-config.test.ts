import { describe, expect, it } from "vitest";
import { COMPOSE_VOLUME_BACKUP_CONFIG_ENV, parseComposeVolumeBackupRuntimeConfig } from "./compose-volume-backup-config.js";

describe("explicit local volume backup configuration", () => {
  it("keeps capability disabled when no allowlist is configured", () => {
    expect(COMPOSE_VOLUME_BACKUP_CONFIG_ENV).toBe("DEPLOYLITE_COMPOSE_VOLUME_BACKUP_ROOTS");
    expect(parseComposeVolumeBackupRuntimeConfig(undefined)).toBeNull();
    expect(parseComposeVolumeBackupRuntimeConfig(JSON.stringify({ sourceRoots: {}, destinations: {} }))).toBeNull();
  });

  it("parses exact server-owned source and destination maps without touching the paths", () => {
    const parsed = parseComposeVolumeBackupRuntimeConfig(JSON.stringify({ sourceRoots: { "project_data": "/var/lib/app/data" }, destinations: { "local_vault": "/var/backups/deploylite" } }));
    expect(parsed && [...parsed.sourceRoots]).toEqual([["project_data", "/var/lib/app/data"]]);
    expect(parsed && [...parsed.destinations]).toEqual([["local_vault", "/var/backups/deploylite"]]);
  });

  it.each([
    "{bad",
    JSON.stringify({ sourceRoots: { data: "/var/data" } }),
    JSON.stringify({ sourceRoots: { data: "relative" }, destinations: { vault: "/var/backups" } }),
    JSON.stringify({ sourceRoots: { data: "/var/data/../other" }, destinations: { vault: "/var/backups" } }),
    JSON.stringify({ sourceRoots: { data: "/var/data" }, destinations: { vault: "/var/data/backups" } }),
    JSON.stringify({ sourceRoots: { data: "/var/data" }, destinations: { vault: "/var/backups" }, arbitrary: "/tmp" })
  ])("rejects invalid or overlapping allowlists", value => {
    expect(() => parseComposeVolumeBackupRuntimeConfig(value)).toThrow("volume backup configuration is invalid");
  });
});
