ALTER TABLE control_commands DROP CONSTRAINT control_commands_status_valid;
ALTER TABLE control_commands ADD CONSTRAINT control_commands_status_valid CHECK (status IN ('pending_confirmation', 'eligible', 'dispatching', 'rejected', 'completed'));
