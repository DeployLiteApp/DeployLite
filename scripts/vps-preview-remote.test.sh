#!/usr/bin/env bash
set -Eeuo pipefail
root="$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
script="$root/scripts/vps-preview-remote.sh"; work="$(mktemp -d)"; trap 'rm -rf -- "$work"' EXIT
source_repo="$work/source-repo"; git clone -q --no-local "$root" "$source_repo"
commit="$(git -C "$source_repo" rev-parse HEAD)"; tree="$(git -C "$source_repo" rev-parse 'HEAD^{tree}')"; preview_id="test-$RANDOM"
cat > "$work/fake-git" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == -C && "${3:-}" == fetch ]]; then
  "${REAL_GIT:?}" -C "$2" remote set-url origin "${LOCAL_REMOTE:?}"
fi
exec "${REAL_GIT:?}" "$@"
EOF
chmod +x "$work/fake-git"
cat > "$work/fake-docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1:-}" in
  container|network|volume) exit 0 ;;
  image)
    if [[ "${2:-}" == ls && ! -e "${DOCKER_IMAGE_REMOVED:?}" ]]; then
      printf 'owned-image\n'
    elif [[ "${2:-}" == rm ]]; then
      : > "$DOCKER_IMAGE_REMOVED"
      printf '%s\n' "${*:3}" >> "$DOCKER_RM_LOG"
    fi
    exit 0
    ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$work/fake-docker"
cat > "$work/fake-compose" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "${COMPOSE_LOG:?}"
EOF
chmod +x "$work/fake-compose"
run_case() { local name="$1" expected="$2"; shift 2; local output status; set +e; output=$("$@" 2>&1); status=$?; set -e; [[ "$status" -eq "$expected" ]] || { printf '%s: expected %s got %s\n%s\n' "$name" "$expected" "$status" "$output" >&2; exit 1; }; }
image_removed="$work/image-removed"; rm_log="$work/docker-rm.log"; compose_log="$work/compose.log"
envbase=(env -i PATH="$work:$PATH" REAL_GIT="$(command -v git)" LOCAL_REMOTE="$source_repo" VPS_GIT_BIN="$work/fake-git" VPS_DOCKER_BIN="$work/fake-docker" DOCKER_IMAGE_REMOVED="$image_removed" DOCKER_RM_LOG="$rm_log" COMPOSE_LOG="$compose_log" VPS_COMPOSE_WRAPPER="$work/fake-compose" VPS_REMOTE_ROOT="/var/tmp/deploylite-preview/$preview_id" VPS_SOURCE_URL=https://example.test/deploylite.git VPS_COMMIT="$commit" VPS_TREE="$tree" VPS_MIGRATION_COMMAND='printf "password=secret\n"' VPS_KEEP_PREVIEW=0)
output="$("${envbase[@]}" bash "$script" migration-only "$preview_id")"; [[ "$output" == *'EVIDENCE: migration_rc=0'* && "$output" == *'PASS: migration-only'* ]]
grep -Fq -- 'down --volumes --remove-orphans' "$compose_log"
grep -Fq -- 'owned-image' "$rm_log"
if grep -Fq -- 'shared-image' "$rm_log"; then exit 1; fi
[[ ! -e "/var/tmp/deploylite-preview/$preview_id" ]]
known_id="known-$RANDOM"; known_output="$work/known-secret"
"${envbase[@]}" VPS_REMOTE_ROOT="/var/tmp/deploylite-preview/$known_id" VPS_DB_PASSWORD=known-db-password \
  VPS_MIGRATION_COMMAND='printf "value=known-db-password\n"' bash "$script" migration-only "$known_id" >"$known_output" 2>&1
grep -Fq 'value=[REDACTED]' "$known_output"
grep -Fq 'known-db-password' "$known_output" && exit 1
[[ ! -e "/var/tmp/deploylite-preview/$known_id" ]]
large_id="large-$RANDOM"; large_output="$work/large-output"
# The migration command is intentionally evaluated by the remote bash process.
# shellcheck disable=SC2016
"${envbase[@]}" VPS_REMOTE_ROOT="/var/tmp/deploylite-preview/$large_id" VPS_MAX_EVIDENCE_BYTES=65536 \
  VPS_MIGRATION_COMMAND='i=0; while [[ "$i" -lt 70000 ]]; do printf x; i=$((i + 1)); done' \
  bash "$script" migration-only "$large_id" >"$large_output" 2>&1
[[ "$(grep -c '^VPS_EVIDENCE_BEGIN$' "$large_output")" -eq 1 ]]
[[ "$(grep -c '^VPS_EVIDENCE_END$' "$large_output")" -eq 1 ]]
grep -Fq 'migration_rc=0' "$large_output"
large_redacted="$(awk '/^output_begin$/{capture=1; next} /^output_end$/{capture=0} capture' "$large_output")"
[[ "$(printf '%s' "$large_redacted" | wc -c)" -eq 65536 ]]
large_checksum="$(printf '%s' "$large_redacted" | sha256sum | awk '{print $1}')"
[[ "$large_checksum" == 1f8745f0d2d1387ec1af2211a3cf417b2e9e885e853472649c1d979d0e9370e3 ]]
grep -Fq '[REDACTED]' "$large_output" && exit 1
grep -Fq "redacted_sha256=$large_checksum" "$large_output"
grep -Fq 'PASS: migration-only' "$large_output"
[[ ! -e "/var/tmp/deploylite-preview/$large_id" ]]
set +e; "${envbase[@]}" VPS_MIGRATION_COMMAND='printf "token=secret\n"; exit 7' bash "$script" migration-only test-two >"$work/fail" 2>&1; status=$?; set -e
[[ "$status" -eq 10 && ! -e "/var/tmp/deploylite-preview/$preview_id" ]]
grep -Fq 'EVIDENCE: migration_rc=7' "$work/fail"
set +e; "${envbase[@]}" VPS_REMOTE_ROOT=/var/tmp/deploylite-preview/cleanup-failure VPS_CLEANUP_FAIL=1 VPS_MIGRATION_COMMAND='exit 7' bash "$script" migration-only cleanup-failure >"$work/cleanup-fail" 2>&1; rc=$?; set -e
[[ "$rc" -eq 10 ]] && grep -Fq 'EVIDENCE: migration_rc=7' "$work/cleanup-fail" && grep -Fq 'CLEANUP FAILED:' "$work/cleanup-fail"
rm -rf -- "/var/tmp/deploylite-preview/cleanup-failure"
cleanup_id="cleanup-$RANDOM"; cleanup_root="/var/tmp/deploylite-preview/$cleanup_id"
mkdir -p "$cleanup_root"
printf 'deploylite-preview-owner\n%s\ndeploylite-preview-%s\n' "$cleanup_id" "$cleanup_id" > "$cleanup_root/.deploylite-preview-owner"
cleanup_output="$("${envbase[@]}" VPS_REMOTE_ROOT="$cleanup_root" VPS_COMPOSE_COMMAND="$work/fake-compose" bash "$script" cleanup "$cleanup_id")"
[[ "$cleanup_output" == *'PASS: cleanup'* && ! -e "$cleanup_root" ]]
grep -Fq -- 'down --volumes --remove-orphans' "$compose_log"
run_case missing-marker 1 "${envbase[@]}" VPS_REMOTE_ROOT="/var/tmp/deploylite-preview/missing-$RANDOM" bash "$script" cleanup "missing-$RANDOM"
drift_id="drift-$RANDOM"; drift_root="/var/tmp/deploylite-preview/$drift_id"; mkdir -p "$drift_root"
printf 'deploylite-preview-owner\nwrong-id\ndeploylite-preview-%s\n' "$drift_id" > "$drift_root/.deploylite-preview-owner"
run_case drifted-marker 1 "${envbase[@]}" VPS_REMOTE_ROOT="$drift_root" bash "$script" cleanup "$drift_id"
rm -rf -- "$drift_root"
run_case tree-mismatch 1 "${envbase[@]}" VPS_TREE=0000000000000000000000000000000000000000 bash "$script" migration-only tree-mismatch
run_case canonical 3 "${envbase[@]}" VPS_REMOTE_ROOT="/var/tmp/deploylite-preview/canonical" bash "$script" migration-only canonical
printf '%s\n' 'VPS remote phase tests passed.'
