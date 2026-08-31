#!/usr/bin/env bash
set -Eeuo pipefail
root="$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
script="$root/scripts/vps-preview-remote.sh"; source_repo="$(mktemp -d)"; trap 'rm -rf -- "$source_repo"' EXIT
git clone -q --no-local "$root" "$source_repo"
commit="$(git -C "$source_repo" rev-parse HEAD)"; tree="$(git -C "$source_repo" rev-parse 'HEAD^{tree}')"; id="full-$RANDOM"
mkdir -p "$source_repo/bin"
cat > "$source_repo/bin/timeout" <<'EOF'
#!/usr/bin/env bash
shift 2
exec "$@"
EOF
chmod +x "$source_repo/bin/timeout"
cat > "$source_repo/bin/docker" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$source_repo/bin/docker"
base=(env -i PATH="$source_repo/bin:$PATH" VPS_DOCKER_BIN="$source_repo/bin/docker" VPS_SOURCE_URL="$source_repo" VPS_COMMIT="$commit" VPS_TREE="$tree" VPS_COMPOSE_COMMAND=true VPS_MIGRATION_COMMAND='printf ready' VPS_HEALTH_COMMAND=true VPS_REMOTE_ROOT="/var/tmp/deploylite-preview/$id")
output="$("${base[@]}" bash "$script" preview "$id")"
[[ "$output" == *'PASS: preview'* && -f "/var/tmp/deploylite-preview/$id/.deploylite-preview-owner" ]]
rm -rf -- "/var/tmp/deploylite-preview/$id"
set +e; "${base[@]}" VPS_HEALTH_COMMAND=false bash "$script" preview "$id" >"$source_repo/failure" 2>&1; status=$?; set -e
[[ "$status" -eq 11 && ! -e "/var/tmp/deploylite-preview/$id" ]]
grep -Fq 'EVIDENCE: migration_rc=0' "$source_repo/failure"
printf '%s\n' 'VPS full preview tests passed.'
