-- Preparatory, insert-only archive retirement reservation. No executor or expiry release.
CREATE TABLE backup_retirement_reservations (
  command_id uuid NOT NULL UNIQUE REFERENCES control_commands(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  confirmation_id uuid NOT NULL UNIQUE REFERENCES control_command_confirmations(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  project_id uuid NOT NULL, volume_key text NOT NULL, destination_id text NOT NULL, archive_id text NOT NULL,
  input_digest text NOT NULL, binding jsonb NOT NULL, created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, volume_key, destination_id, archive_id),
  FOREIGN KEY (project_id, volume_key, destination_id, archive_id)
    REFERENCES backup_inventory(project_id, volume_key, destination_id, archive_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT backup_retirement_reservations_digest_valid CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT backup_retirement_reservations_created_valid CHECK (created_at >= timestamptz 'epoch'),
  CONSTRAINT backup_retirement_reservations_binding_valid CHECK ((binding->>'operation' = 'backup.retire'
    AND binding->'executionAllowed' = 'false'::jsonb
    AND binding->'receipt' @> jsonb_build_object('projectId', project_id::text,
      'volumeKey', volume_key, 'destinationId', destination_id, 'archiveId', archive_id)) IS TRUE)
);
