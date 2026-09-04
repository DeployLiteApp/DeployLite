ALTER TABLE agent_replay ADD COLUMN IF NOT EXISTS claim_token text;
UPDATE agent_replay SET claim_token = lease_id WHERE claim_token IS NULL;
ALTER TABLE agent_replay ALTER COLUMN claim_token SET NOT NULL;
