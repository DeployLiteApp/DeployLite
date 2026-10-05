-- Additive authority storage on the existing control command ledger.
-- Local draft only: applying this migration requires separate runtime authorization.
ALTER TABLE control_commands ADD COLUMN execution_authority jsonb;
