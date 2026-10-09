CREATE TABLE transport_port_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  protocol text NOT NULL,
  published_port integer NOT NULL,
  deployment_id uuid NOT NULL,
  target_port integer NOT NULL,
  revision_number integer NOT NULL,
  operation text NOT NULL,
  command_id uuid NOT NULL UNIQUE REFERENCES control_commands(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  rollback_revision_id uuid REFERENCES transport_port_revisions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  correlation_id text NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transport_port_revisions_deployment_project_fk FOREIGN KEY (deployment_id, project_id)
    REFERENCES deployments(id, project_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT transport_port_revisions_protocol_valid CHECK (protocol IN ('tcp', 'udp')),
  CONSTRAINT transport_port_revisions_published_port_valid CHECK (published_port BETWEEN 1 AND 65535),
  CONSTRAINT transport_port_revisions_target_port_valid CHECK (target_port BETWEEN 1 AND 65535),
  CONSTRAINT transport_port_revisions_number_positive CHECK (revision_number > 0),
  CONSTRAINT transport_port_revisions_operation_valid CHECK (operation IN ('apply', 'rollback')),
  CONSTRAINT transport_port_revisions_evidence_redacted CHECK (
    (jsonb_typeof(evidence) = 'object' AND evidence->'redacted' = 'true'::jsonb
      AND (evidence - 'state' - 'observedAt' - 'redacted') = '{}'::jsonb) IS TRUE
  ),
  CONSTRAINT transport_port_revisions_operation_binding CHECK (
    (operation = 'apply' AND rollback_revision_id IS NULL)
    OR (operation = 'rollback' AND rollback_revision_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX transport_port_revisions_key_number_unique ON transport_port_revisions (protocol, published_port, revision_number);
CREATE INDEX transport_port_revisions_project_key_idx ON transport_port_revisions (project_id, protocol, published_port, revision_number DESC);

CREATE TABLE transport_port_runtime_states (
  project_id uuid NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  deployment_id uuid NOT NULL,
  container_id text NOT NULL,
  bindings jsonb NOT NULL,
  command_id uuid NOT NULL UNIQUE REFERENCES control_commands(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transport_port_runtime_states_project_deployment_pk PRIMARY KEY (project_id, deployment_id),
  CONSTRAINT transport_port_runtime_states_deployment_project_fk FOREIGN KEY (deployment_id, project_id)
    REFERENCES deployments(id, project_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT transport_port_runtime_states_container_id_valid CHECK (container_id ~ '^[a-f0-9]{64}$'),
  CONSTRAINT transport_port_runtime_states_bindings_array CHECK (jsonb_typeof(bindings) = 'array')
);
CREATE INDEX transport_port_runtime_states_project_updated_idx ON transport_port_runtime_states (project_id, updated_at DESC);

CREATE TABLE transport_port_reservations (
  protocol text NOT NULL,
  published_port integer NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  command_id uuid NOT NULL UNIQUE REFERENCES control_commands(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  route jsonb NOT NULL,
  plan jsonb NOT NULL,
  current_container_id text NOT NULL,
  bindings jsonb NOT NULL,
  previous_bindings jsonb NOT NULL,
  operation text NOT NULL DEFAULT 'apply',
  rollback_revision_id uuid REFERENCES transport_port_revisions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transport_port_reservations_key_pk PRIMARY KEY (protocol, published_port),
  CONSTRAINT transport_port_reservations_protocol_valid CHECK (protocol IN ('tcp', 'udp')),
  CONSTRAINT transport_port_reservations_published_port_valid CHECK (published_port BETWEEN 1 AND 65535),
  CONSTRAINT transport_port_reservations_container_id_valid CHECK (current_container_id ~ '^[a-f0-9]{64}$'),
  CONSTRAINT transport_port_reservations_bindings_array CHECK (jsonb_typeof(bindings) = 'array' AND jsonb_typeof(previous_bindings) = 'array'),
  CONSTRAINT transport_port_reservations_route_scope CHECK (
    (route->>'protocol' = protocol AND (route->>'publishedPort')::integer = published_port
      AND route->>'projectId' = project_id::text AND plan->'route' = route) IS TRUE
  ),
  CONSTRAINT transport_port_reservations_plan_action_valid CHECK (plan->>'action' IN ('create', 'attach', 'no-op', 'retarget')),
  CONSTRAINT transport_port_reservations_operation_valid CHECK (
    (operation = 'apply' AND rollback_revision_id IS NULL)
    OR (operation = 'rollback' AND rollback_revision_id IS NOT NULL)
  )
);
CREATE INDEX transport_port_reservations_project_idx ON transport_port_reservations (project_id);
