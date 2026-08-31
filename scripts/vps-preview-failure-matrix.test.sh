#!/usr/bin/env bash
set -Eeuo pipefail
root="$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"; script="$root/scripts/vps-preview-remote.sh"
source_repo="$(mktemp -d)"; trap 'rm -rf -- "$source_repo"' EXIT; git clone -q --no-local "$root" "$source_repo"
commit="$(git -C "$source_repo" rev-parse HEAD)"; tree="$(git -C "$source_repo" rev-parse 'HEAD^{tree}')"; id="matrix-$RANDOM"; root_dir="/var/tmp/deploylite-preview/$id"
base=(env -i PATH="$PATH" VPS_SOURCE_URL="$source_repo" VPS_COMMIT="$commit" VPS_TREE="$tree" VPS_MIGRATION_COMMAND='printf "DATABASE_URL=postgres://u:secret@db/x\nAuthorization: Bearer token\n"' VPS_REMOTE_ROOT="$root_dir")
expect() { local wanted="$1"; shift; set +e; "$@" >/dev/null 2>&1; local got=$?; set -e; [[ "$got" -eq "$wanted" ]] || { printf 'expected %s got %s\n' "$wanted" "$got" >&2; exit 1; }; }
expect 0 "${base[@]}" VPS_MIGRATION_COMMAND='printf evidence' bash "$script" migration-only "$id"
expect 10 "${base[@]}" VPS_MIGRATION_COMMAND='printf "bad=1\n"; exit 9' bash "$script" migration-only "$id"
expect 1 "${base[@]}" VPS_MIGRATION_COMMAND='true' bash "$script" migration-only "$id"
mkdir -p "$root_dir"; expect 3 "${base[@]}" bash "$script" migration-only "$id"; rm -rf -- "$root_dir"
expect 3 "${base[@]}" VPS_REMOTE_ROOT=/var/tmp/deploylite-preview/canonical bash "$script" migration-only canonical
expect 3 "${base[@]}" VPS_LOOPBACK_PORTS=127.0.0.1:80 VPS_COMPOSE_COMMAND=true VPS_HEALTH_COMMAND=true bash "$script" preview "$id"
expect 2 "${base[@]}" VPS_CLEANUP_FAIL=1 bash "$script" migration-only "$id"
printf '%s\n' 'VPS preview failure matrix passed.'
