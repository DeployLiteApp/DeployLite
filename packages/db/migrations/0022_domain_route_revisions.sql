ALTER TABLE domains
  ADD CONSTRAINT domains_id_project_hostname_unique UNIQUE (id, project_id, hostname);

CREATE TABLE domain_route_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE CASCADE,
  hostname text NOT NULL,
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  revision_number integer NOT NULL,
  operation text NOT NULL,
  command_id uuid REFERENCES control_commands(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  rollback_revision_id uuid REFERENCES domain_route_revisions(id) ON UPDATE CASCADE ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL,
  correlation_id text,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT domain_route_revisions_domain_fk FOREIGN KEY (domain_id, project_id, hostname)
    REFERENCES domains(id, project_id, hostname) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT domain_route_revisions_number_positive CHECK (revision_number > 0),
  CONSTRAINT domain_route_revisions_operation_valid CHECK (operation IN ('baseline', 'apply', 'rollback')),
  CONSTRAINT domain_route_revisions_evidence_redacted CHECK (
    (jsonb_typeof(evidence) = 'object' AND evidence->'redacted' = 'true'::jsonb
      AND (evidence - 'state' - 'contentDigest' - 'observedAt' - 'redacted') = '{}'::jsonb) IS TRUE
  ),
  CONSTRAINT domain_route_revisions_operation_binding CHECK (
    (operation = 'baseline' AND command_id IS NULL AND rollback_revision_id IS NULL)
    OR (operation = 'apply' AND command_id IS NOT NULL AND rollback_revision_id IS NULL)
    OR (operation = 'rollback' AND command_id IS NOT NULL AND rollback_revision_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX domain_route_revisions_domain_number_unique ON domain_route_revisions (domain_id, revision_number);
CREATE UNIQUE INDEX domain_route_revisions_command_unique ON domain_route_revisions (command_id) WHERE command_id IS NOT NULL;
CREATE INDEX domain_route_revisions_project_hostname_idx ON domain_route_revisions (project_id, hostname, revision_number DESC);

INSERT INTO domain_route_revisions (domain_id, project_id, hostname, deployment_id, revision_number, operation, evidence, created_at)
SELECT d.id, d.project_id, d.hostname, d.deployment_id, 1, 'baseline',
  jsonb_build_object('state', 'baseline', 'contentDigest', null, 'observedAt', null, 'redacted', true), d.updated_at
FROM domains AS d
JOIN deployments AS deployment ON deployment.id = d.deployment_id AND deployment.project_id = d.project_id
WHERE d.status = 'active' AND d.deployment_id IS NOT NULL;

ALTER TABLE domain_route_reservations
  ADD COLUMN operation text NOT NULL DEFAULT 'apply',
  ADD COLUMN rollback_revision_id uuid REFERENCES domain_route_revisions(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD CONSTRAINT domain_route_reservations_operation_valid CHECK (
    (operation = 'apply' AND rollback_revision_id IS NULL)
    OR (operation = 'rollback' AND rollback_revision_id IS NOT NULL)
  );
