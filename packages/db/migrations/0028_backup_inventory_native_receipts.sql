-- Preserve the existing immutable inventory, keys, command/audit references and P3 rows.
-- Native receipts use the same project/volume/destination projection; no new store.
ALTER TABLE backup_inventory DROP CONSTRAINT backup_inventory_receipt_bound;
ALTER TABLE backup_inventory ADD CONSTRAINT backup_inventory_receipt_bound CHECK ((
  receipt @> jsonb_build_object(
    'schemaVersion', 1, 'redacted', true, 'projectId', project_id::text,
    'commandId', command_id::text, 'volumeKey', volume_key,
    'destinationId', destination_id, 'archiveId', archive_id)
  AND (
    receipt->>'action' = 'compose.volume.backup'
    OR (
      receipt->>'action' = 'database.runtime.backup'
      AND jsonb_typeof(receipt->'databaseId') = 'string'
      AND volume_key = 'db-' || (receipt->>'databaseId')
    )
  )
) IS TRUE);
