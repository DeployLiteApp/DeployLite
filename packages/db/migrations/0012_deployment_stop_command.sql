-- Extend the existing control ledger for authenticated, durable deployment stops.
ALTER TABLE control_commands ADD COLUMN result jsonb;
ALTER TABLE control_commands DROP CONSTRAINT control_commands_action_valid;
ALTER TABLE control_commands ADD CONSTRAINT control_commands_action_valid
  CHECK (action IN ('project.delete', 'project.deploy', 'project.update', 'deployment.stop', 'platform.agent.register'));
ALTER TABLE control_commands DROP CONSTRAINT control_commands_scope_valid;
ALTER TABLE control_commands ADD CONSTRAINT control_commands_scope_valid
  CHECK (scope_kind IN ('platform', 'project', 'deployment'));
ALTER TABLE control_command_confirmations DROP CONSTRAINT control_command_confirmations_action_valid;
ALTER TABLE control_command_confirmations ADD CONSTRAINT control_command_confirmations_action_valid
  CHECK (action IN ('project.delete', 'project.deploy', 'project.update', 'deployment.stop', 'platform.agent.register'));
ALTER TABLE control_command_confirmations DROP CONSTRAINT control_command_confirmations_scope_valid;
ALTER TABLE control_command_confirmations ADD CONSTRAINT control_command_confirmations_scope_valid
  CHECK (scope_kind IN ('platform', 'project', 'deployment'));
