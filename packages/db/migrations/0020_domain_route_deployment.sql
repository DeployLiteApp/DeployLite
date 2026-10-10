ALTER TABLE domains
  ADD COLUMN deployment_id uuid REFERENCES deployments(id) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX domains_deployment_id_idx ON domains (deployment_id);
