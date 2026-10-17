-- Separate P3 protection storage; runtime corroboration and arbitration are not activated.
CREATE TABLE compose_volume_restore_protections (
  restore_command_id uuid PRIMARY KEY REFERENCES control_commands(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  confirmation_id uuid NOT NULL UNIQUE REFERENCES control_command_confirmations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  project_id uuid NOT NULL,
  volume_key text NOT NULL,
  destination_id text NOT NULL,
  archive_id text NOT NULL,
  backup_command_id uuid NOT NULL REFERENCES control_commands(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  input_digest text NOT NULL,
  archive_sha256 text NOT NULL,
  manifest_sha256 text NOT NULL,
  source_binding jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  FOREIGN KEY (project_id, volume_key, destination_id, archive_id)
    REFERENCES backup_inventory(project_id, volume_key, destination_id, archive_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT compose_volume_restore_protections_identity_valid CHECK (
    volume_key ~ '^[A-Za-z0-9_-]{1,200}$' AND destination_id ~ '^[A-Za-z0-9_-]{1,200}$'
    AND archive_id ~ '^[A-Za-z0-9_-]{1,200}$' AND restore_command_id <> backup_command_id),
  CONSTRAINT compose_volume_restore_protections_digest_valid CHECK (
    input_digest ~ '^[a-f0-9]{64}$' AND archive_sha256 ~ '^[a-f0-9]{64}$' AND manifest_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT compose_volume_restore_protections_created_valid CHECK (created_at >= timestamptz 'epoch'),
  CONSTRAINT compose_volume_restore_protections_binding_valid CHECK ((
    source_binding @> jsonb_build_object('schemaVersion', 1, 'operation', 'compose.volume.restore.source', 'executionAllowed', false)
    AND source_binding - array['schemaVersion', 'operation', 'executionAllowed', 'source'] = '{}'::jsonb
    AND source_binding->'source' @> jsonb_build_object('schemaVersion', 1)
    AND (source_binding->'source') - array['schemaVersion', 'receipt', 'createdAtMs'] = '{}'::jsonb
    AND jsonb_typeof(source_binding->'source'->'createdAtMs') = 'number'
    AND (source_binding->'source'->>'createdAtMs')::numeric BETWEEN 0 AND 8640000000000000
    AND trunc((source_binding->'source'->>'createdAtMs')::numeric) = (source_binding->'source'->>'createdAtMs')::numeric
    AND source_binding->'source'->'receipt' @> jsonb_build_object('schemaVersion', 1, 'action', 'compose.volume.backup', 'redacted', true,
      'projectId', project_id::text, 'commandId', backup_command_id::text,
      'volumeKey', volume_key, 'destinationId', destination_id, 'archiveId', archive_id,
      'archiveSha256', archive_sha256, 'manifestSha256', manifest_sha256)) IS TRUE)
);
CREATE INDEX compose_volume_restore_protections_scope_idx
  ON compose_volume_restore_protections(project_id, volume_key, destination_id);
