CREATE TABLE IF NOT EXISTS agent_replay (
  command_id text PRIMARY KEY, fingerprint text NOT NULL, status text NOT NULL DEFAULT 'in_progress', claim_owner text NOT NULL,
  lease_id text NOT NULL, lease_expires_at timestamptz NOT NULL, receipt jsonb, claimed_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
  CONSTRAINT agent_replay_status_valid CHECK (status IN ('in_progress', 'completed'))
);
CREATE INDEX IF NOT EXISTS agent_replay_status_lease_idx ON agent_replay (status, lease_expires_at);
