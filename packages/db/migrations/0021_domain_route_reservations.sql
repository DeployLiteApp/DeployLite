CREATE TABLE domain_route_reservations (
  hostname text PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  command_id uuid NOT NULL UNIQUE REFERENCES control_commands(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  route jsonb NOT NULL,
  plan jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domain_route_reservations_route_scope CHECK (
    (route->>'domain' = hostname AND route->>'projectId' = project_id::text AND plan->'route' = route) IS TRUE
  ),
  CONSTRAINT domain_route_reservations_plan_action_valid CHECK (
    (plan->>'action' IN ('create', 'attach', 'retarget', 'no-op')) IS TRUE
  )
);

CREATE INDEX domain_route_reservations_project_idx ON domain_route_reservations (project_id);
