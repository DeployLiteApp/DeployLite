CREATE TABLE backup_inventory (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  volume_key text NOT NULL,
  destination_id text NOT NULL,
  archive_id text NOT NULL,
  command_id uuid NOT NULL REFERENCES control_commands(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  audit_id uuid NOT NULL REFERENCES audit_events(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, volume_key, destination_id, archive_id),
  CONSTRAINT backup_inventory_receipt_bound CHECK (receipt @> jsonb_build_object(
    'schemaVersion', 1, 'action', 'compose.volume.backup', 'redacted', true,
    'projectId', project_id::text, 'commandId', command_id::text,
    'volumeKey', volume_key, 'destinationId', destination_id, 'archiveId', archive_id)),
  CONSTRAINT backup_inventory_created_valid CHECK (created_at >= timestamptz 'epoch')
);
CREATE UNIQUE INDEX backup_inventory_command_unique ON backup_inventory (command_id);
CREATE UNIQUE INDEX backup_inventory_audit_unique ON backup_inventory (audit_id);
