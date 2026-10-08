-- Saved logical intent only; this migration creates no runtime resource.
CREATE TABLE compose_resources (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON UPDATE cascade ON DELETE cascade,
  created_by uuid NOT NULL REFERENCES users(id) ON UPDATE cascade ON DELETE restrict,
  created_at timestamptz NOT NULL,
  CONSTRAINT compose_resources_id_project_unique UNIQUE (id, project_id)
);
CREATE INDEX compose_resources_project_idx ON compose_resources (project_id);
CREATE TABLE compose_revisions (
  id uuid PRIMARY KEY REFERENCES control_commands(id) ON UPDATE cascade ON DELETE restrict,
  compose_id uuid NOT NULL,
  project_id uuid NOT NULL,
  number integer NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id) ON UPDATE cascade ON DELETE restrict,
  created_at timestamptz NOT NULL,
  preview jsonb NOT NULL,
  CONSTRAINT compose_revisions_owner_fk FOREIGN KEY (compose_id, project_id) REFERENCES compose_resources(id, project_id) ON UPDATE cascade ON DELETE cascade,
  CONSTRAINT compose_revisions_number_positive CHECK (number > 0),
  CONSTRAINT compose_revisions_preview_safe CHECK ((jsonb_typeof(preview) = 'object' AND preview->>'projectId' = project_id::text AND preview->'executionAllowed' = 'false'::jsonb) IS TRUE)
);
CREATE UNIQUE INDEX compose_revisions_number_unique ON compose_revisions (compose_id, number);
CREATE INDEX compose_revisions_project_idx ON compose_revisions (project_id);
