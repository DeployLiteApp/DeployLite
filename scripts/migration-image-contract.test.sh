#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
MIGRATION_IMAGE_TAG="deploylite-migration-contract:${$}"
RUNTIME_IMAGE_TAG="deploylite-runtime-contract:${$}"

cleanup() {
  docker image rm --force "$MIGRATION_IMAGE_TAG" "$RUNTIME_IMAGE_TAG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v docker >/dev/null 2>&1 || {
  printf 'migration image contract requires Docker\n' >&2
  exit 2
}

docker build --target runtime --tag "$RUNTIME_IMAGE_TAG" --file "$ROOT_DIR/apps/api/Dockerfile" "$ROOT_DIR"
cmd="$(docker image inspect --format '{{json .Config.Cmd}}' "$RUNTIME_IMAGE_TAG")"
[[ "$cmd" == '["node","dist/index.js"]' ]] || {
  printf 'unexpected runtime command: %s\n' "$cmd" >&2
  exit 1
}
docker build --target migration --tag "$MIGRATION_IMAGE_TAG" --file "$ROOT_DIR/apps/api/Dockerfile" "$ROOT_DIR"
entrypoint="$(docker image inspect --format '{{json .Config.Entrypoint}}' "$MIGRATION_IMAGE_TAG")"
[[ "$entrypoint" == '["node","scripts/migrate.mjs"]' ]] || {
  printf 'unexpected migration entrypoint: %s\n' "$entrypoint" >&2
  exit 1
}
docker run --rm --entrypoint node "$MIGRATION_IMAGE_TAG" -e '
  import { access } from "node:fs/promises";
  await access("scripts/migrate.mjs");
  if (process.cwd() !== "/app/packages/db") throw new Error(`unexpected workdir: ${process.cwd()}`);
  if (process.getuid?.() === 0) throw new Error("migration container must not run as root");
  await import("pg");
  console.log("migration image contract passed");
'
