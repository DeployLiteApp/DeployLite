import {readFileSync, existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {expect, it} from "vitest";
import {PgDialect, getTableConfig, type PgTable} from "drizzle-orm/pg-core";
import * as schema from "./schema.js";

const migrationPath = fileURLToPath(new URL("../migrations/0031_compose_volume_restore_protections.sql", import.meta.url));
const normalize = (value: string) => value.replaceAll('"', "").replace(/\s+/g, " ").trim().toLowerCase();
function table() {
  const value = (schema as unknown as Record<string, PgTable>).composeVolumeRestoreProtections;
  expect(value, "separate P3 protection table is required").toBeDefined();
  return getTableConfig(value!);
}
function migration() {
  expect(existsSync(migrationPath), "additive P3 migration is required").toBe(true);
  return normalize(readFileSync(migrationPath, "utf8"));
}
function checks() {
  return table().checks.map(check => normalize(new PgDialect().sqlToQuery(check.value).sql)).join(" ");
}
it("declares distinct insert-only P3 protection storage without expiry or archive uniqueness", () => {
  const config = table();
  expect(config.name).toBe("compose_volume_restore_protections");
  expect(config.columns.map(column => column.name).sort()).toEqual([
    "restore_command_id", "confirmation_id", "project_id", "volume_key", "destination_id", "archive_id",
    "backup_command_id", "input_digest", "archive_sha256", "manifest_sha256", "source_binding", "created_at"
  ].sort());
  expect(config.columns.every(column => column.notNull)).toBe(true);
  expect(config.columns.filter(column => column.primary).map(column => column.name)).toEqual(["restore_command_id"]);
  expect(config.columns.filter(column => column.isUnique).map(column => column.name)).toEqual(["confirmation_id"]);
  expect(config.indexes.map(index => index.config.columns.map(column => "name" in column ? column.name : ""))).toEqual([["project_id", "volume_key", "destination_id"]]);
});
it("retains original ledger, unique nonce and complete immutable inventory foreign keys", () => {
  const keys = table().foreignKeys.map(key => ({
    columns: key.reference().columns.map(column => column.name),
    foreign: key.reference().foreignColumns.map(column => column.name),
    delete: key.onDelete, update: key.onUpdate
  }));
  expect(keys).toHaveLength(4);
  for (const key of keys) expect(key).toMatchObject({delete: "restrict", update: "cascade"});
  expect(keys.map(key => key.columns)).toContainEqual(["restore_command_id"]);
  expect(keys.map(key => key.columns)).toContainEqual(["confirmation_id"]);
  expect(keys.map(key => key.columns)).toContainEqual(["backup_command_id"]);
  expect(keys).toContainEqual({columns: ["project_id", "volume_key", "destination_id", "archive_id"],
    foreign: ["project_id", "volume_key", "destination_id", "archive_id"], delete: "restrict", update: "cascade"});
});
it.each(["input_digest", "archive_sha256", "manifest_sha256"])("requires lower-case SHA256 for %s in schema and SQL", column => {
  expect(checks()).toContain(`${column} ~ '^[a-f0-9]{64}$'`);
  expect(migration()).toContain(`${column} ~ '^[a-f0-9]{64}$'`);
});
it.each(["volume_key", "destination_id", "archive_id"])("uses P3 identifier grammar for %s, not native-only names", column => {
  expect(checks()).toContain(`${column} ~ '^[a-za-z0-9_-]{1,200}$'`);
  expect(migration()).toContain(`${column} ~ '^[a-za-z0-9_-]{1,200}$'`);
});
it("binds the complete preparatory source envelope and scalar receipt identities with fail-closed JSON checks", () => {
  for (const text of [checks(), migration()]) {
    for (const fragment of ["'operation', 'compose.volume.restore.source'", "'executionallowed', false", "'schemaversion', 1",
      "'action', 'compose.volume.backup'", "'redacted', true", "'projectid'", "'commandid'", "'volumekey'",
      "'destinationid'", "'archiveid'", "'archivesha256'", "'manifestsha256'", "'createdatms'", "is true"])
      expect(text).toContain(fragment);
    expect(text).toContain("restore_command_id <>");
    expect(text).toContain("backup_command_id");
    expect(text).toContain("created_at >= timestamptz 'epoch'");
  }
});
it("adds only the separate table and scope index, with no native ALTER, expiry release or destructive SQL", () => {
  const text = migration();
  expect(text).toContain("create table compose_volume_restore_protections");
  expect(text).toContain("primary key");
  expect(text).toContain("confirmation_id uuid not null unique references control_command_confirmations(id)");
  expect(text).toContain("references backup_inventory(project_id, volume_key, destination_id, archive_id) on delete restrict on update cascade");
  expect(text).toContain("create index compose_volume_restore_protections_scope_idx");
  expect(text).not.toMatch(/\b(alter|drop|delete|truncate|trigger|expires_at|consumed_at)\b(?! restrict)/);
});
it("preserves the native table's restrictive archive and database-volume grammar", () => {
  const config = getTableConfig(schema.backupRestoreProtections);
  const text = normalize(config.checks.map(check => new PgDialect().sqlToQuery(check.value).sql).join(" "));
  expect(text).toContain("^backup_[a-f0-9]{32}$");
  expect(text).toContain("^db-[a-za-z0-9_-]{1,63}$");
  expect(config.name).toBe("backup_restore_protections");
});
