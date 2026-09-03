#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_env="$(mktemp)"
trap 'rm -f "$runtime_env"' EXIT
printf 'POSTGRES_PASSWORD=%s\nDATABASE_URL=%s\nDEPLOYLITE_SECRET_KEY=%s\nDEPLOYLITE_ACME_EMAIL=%s\n' \
  'placeholder' \
  'postgres://deploylite:base%2Bplus%2Fslash@postgres:5432/deploylite' \
  'placeholder' \
  'operator@acme.co' >"$runtime_env"
base_rendered="$(docker compose -f "$ROOT_DIR/infra/vps/compose.yml" config --no-interpolate)"
rendered="$(docker compose -f "$ROOT_DIR/infra/vps/compose.yml" -f "$ROOT_DIR/infra/vps/compose.tls.yml" config --no-interpolate)"
merged_rendered="$(docker compose --env-file "$runtime_env" -f "$ROOT_DIR/infra/vps/compose.yml" -f "$ROOT_DIR/infra/vps/compose.tls.yml" --profile bootstrap config)"
migrate_environment="$(printf '%s\n' "$merged_rendered" | awk '/^  migrate:$/,/^  api:$/')"
api_environment="$(printf '%s\n' "$merged_rendered" | awk '/^  api:$/,/^  web:$/')"

contains() { [[ "$rendered" == *"$1"* ]] || { printf 'missing: %s\n' "$1"; return 1; }; }
[[ "$base_rendered" == *'traefik:v3.6.7'* ]] || { printf 'base Compose must pin Traefik v3.6.7 for Docker API compatibility\n'; exit 1; }
contains "DEPLOYLITE_CORS_ORIGIN: https://\${DEPLOYLITE_PUBLIC_HOST:-deploylite.invalid}"
contains 'profiles:'
contains 'bootstrap'
contains "DEPLOYLITE_SECRET_KEY: \${DEPLOYLITE_SECRET_KEY:?DEPLOYLITE_SECRET_KEY is required}"
contains -- '--providers.docker=true'
contains -- '--providers.docker.exposedbydefault=false'
contains "--certificatesresolvers.le.acme.email=\${DEPLOYLITE_ACME_EMAIL}"
contains 'source: /var/run/docker.sock'
contains 'target: /var/run/docker.sock'
contains 'read_only: true'
contains -- '--entrypoints.web.http.redirections.entrypoint.scheme=https'
contains 'source: traefik-acme'
contains 'target: /acme'
contains "Host(\`\${DEPLOYLITE_PUBLIC_HOST:-deploylite.com}\`)"
contains 'traefik.http.routers.deploylite-api.rule='
contains 'traefik.http.routers.deploylite-web.rule='
contains 'X-DeployLite-Bootstrap=ready'
contains 'deploylite-bootstrap-marker'
contains 'DEPLOYLITE_SESSION_COOKIE_SECURE: "true"'
[[ "$migrate_environment" == *'DATABASE_URL: postgres://deploylite:base%2Bplus%2Fslash@postgres:5432/deploylite'* ]] || {
  printf 'migrate must receive the generated URL-safe DATABASE_URL\n'
  exit 1
}
[[ "$migrate_environment" == *$'target: migration'* ]] || {
  printf 'migrate must build the dedicated migration target\n'
  exit 1
}
[[ "$api_environment" == *$'target: runtime'* ]] || {
  printf 'api must build the runtime target\n'
  exit 1
}
[[ "$migrate_environment" == *'image: deploylite-migration:local'* ]] || {
  printf 'migrate must use a dedicated image tag\n'
  exit 1
}
[[ "$migrate_environment" == *'entrypoint:'*'node'*'scripts/migrate.mjs'* ]] || {
  printf 'migrate must use the package-correct migration entrypoint\n'
  exit 1
}
if [[ "$rendered" == *'"3001:3001"'* || "$rendered" == *'"80:3000"'* ]]; then
  printf 'API or web must not publish host ports\n'
  exit 1
fi
if [[ "$rendered" != *'DEPLOYLITE_ACME_EMAIL'* || "$rendered" == *'--certificatesresolvers.le.acme.email=operator@acme.co'* ]]; then
  printf 'ACME email must be required by reference and not rendered from the fixture in no-interpolate output\n'
  exit 1
fi
printf 'compose TLS contract passed\n'
