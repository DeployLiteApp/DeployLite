CREATE TABLE backup_restore_protections (
  restore_command_id uuid PRIMARY KEY REFERENCES control_commands(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  confirmation_id uuid NOT NULL REFERENCES control_command_confirmations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  project_id uuid NOT NULL, volume_key text NOT NULL, destination_id text NOT NULL, archive_id text NOT NULL,
  backup_command_id uuid NOT NULL REFERENCES control_commands(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  input_digest text NOT NULL, archive_sha256 text NOT NULL, manifest_sha256 text NOT NULL, created_at timestamptz NOT NULL,
  FOREIGN KEY (project_id, volume_key, destination_id, archive_id)
    REFERENCES backup_inventory(project_id, volume_key, destination_id, archive_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT backup_restore_protections_binding_valid CHECK (
    archive_sha256 ~ '^[a-f0-9]{64}$' AND manifest_sha256 ~ '^[a-f0-9]{64}$'
    AND input_digest ~ '^[a-f0-9]{64}$' AND archive_id ~ '^backup_[a-f0-9]{32}$'
    AND volume_key ~ '^db-[A-Za-z0-9_-]{1,63}$' AND destination_id ~ '^[A-Za-z0-9_-]{1,200}$'
    AND restore_command_id <> backup_command_id),
  CONSTRAINT backup_restore_protections_created_valid CHECK (created_at >= timestamptz 'epoch')
);
CREATE INDEX backup_restore_protections_scope_idx ON backup_restore_protections(project_id, volume_key, destination_id);
