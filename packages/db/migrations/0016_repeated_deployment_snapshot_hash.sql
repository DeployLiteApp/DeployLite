DROP INDEX deployments_snapshot_hash_unique;
CREATE INDEX deployments_snapshot_hash_idx ON deployments (snapshot_hash) WHERE snapshot_hash IS NOT NULL;
