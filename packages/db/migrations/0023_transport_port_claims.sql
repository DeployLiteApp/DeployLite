CREATE UNIQUE INDEX deployments_id_project_id_unique ON deployments (id, project_id);

CREATE TABLE transport_port_claims (
  protocol text NOT NULL,
  published_port integer NOT NULL,
  project_id uuid NOT NULL REFERENCES projects(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  deployment_id uuid,
  target_port integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transport_port_claims_protocol_published_port_pk PRIMARY KEY (protocol, published_port),
  CONSTRAINT transport_port_claims_deployment_project_fk FOREIGN KEY (deployment_id, project_id)
    REFERENCES deployments(id, project_id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT transport_port_claims_protocol_valid CHECK (protocol IN ('tcp', 'udp')),
  CONSTRAINT transport_port_claims_published_port_valid CHECK (published_port BETWEEN 1 AND 65535),
  CONSTRAINT transport_port_claims_target_port_valid CHECK (target_port BETWEEN 1 AND 65535)
);

CREATE INDEX transport_port_claims_project_idx ON transport_port_claims (project_id);
CREATE INDEX transport_port_claims_deployment_project_idx ON transport_port_claims (deployment_id, project_id);
