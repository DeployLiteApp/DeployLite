ALTER TABLE deployments
  ADD COLUMN IF NOT EXISTS snapshot_hash text,
  ADD COLUMN IF NOT EXISTS snapshot_evidence text;

CREATE UNIQUE INDEX IF NOT EXISTS deployments_snapshot_hash_unique ON deployments (snapshot_hash) WHERE snapshot_hash IS NOT NULL;
