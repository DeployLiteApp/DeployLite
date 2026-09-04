ALTER TABLE control_commands DROP CONSTRAINT control_commands_action_valid;
ALTER TABLE control_commands ADD CONSTRAINT control_commands_action_valid CHECK (action IN ('project.delete', 'project.deploy', 'project.update', 'deployment.stop', 'deployment.redeploy', 'platform.agent.register'));
ALTER TABLE control_grants DROP CONSTRAINT control_grants_action_valid;
ALTER TABLE control_grants ADD CONSTRAINT control_grants_action_valid CHECK (action IN ('project.delete', 'project.deploy', 'project.update', 'deployment.stop', 'deployment.redeploy', 'platform.agent.register'));
ALTER TABLE control_command_confirmations DROP CONSTRAINT control_command_confirmations_action_valid;
ALTER TABLE control_command_confirmations ADD CONSTRAINT control_command_confirmations_action_valid CHECK (action IN ('project.delete', 'project.deploy', 'project.update', 'deployment.stop', 'deployment.redeploy', 'platform.agent.register'));
