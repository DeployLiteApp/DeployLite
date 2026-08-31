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
cat > "$work/consuming-compose" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
cat >/dev/null
printf '%s\n' "$*" >> "${COMPOSE_LOG:?}"
EOF
chmod +x "$work/consuming-compose"
cat > "$work/timeout" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
shift
exec "$@"
EOF
chmod +x "$work/timeout"
run_case() { local name="$1" expected="$2"; shift 2; local output status; set +e; output=$("$@" 2>&1); status=$?; set -e; [[ "$status" -eq "$expected" ]] || { printf '%s: expected %s got %s\n%s\n' "$name" "$expected" "$status" "$output" >&2; exit 1; }; }
assert_order() {
  local file="$1" previous=0 needle line
  shift
  for needle in "$@"; do
    line="$(awk -v needle="$needle" -v after="$previous" 'NR > after && $0 == needle { print NR; exit }' "$file")"
    [[ -n "$line" ]] || { printf 'missing or out-of-order phase breadcrumb: %s\n' "$needle" >&2; exit 1; }
    previous="$line"
  done
}
image_removed="$work/image-removed"; rm_log="$work/docker-rm.log"; compose_log="$work/compose.log"; project_scope_log="$work/project-scope.log"
# shellcheck disable=SC2016
envbase=(env -i PATH="$work:$PATH" REAL_GIT="$(command -v git)" LOCAL_REMOTE="$source_repo" VPS_GIT_BIN="$work/fake-git" VPS_DOCKER_BIN="$work/fake-docker" DOCKER_IMAGE_REMOVED="$image_removed" DOCKER_RM_LOG="$rm_log" COMPOSE_LOG="$compose_log" PROJECT_SCOPE_LOG="$project_scope_log" VPS_COMPOSE_WRAPPER="$work/fake-compose" VPS_REMOTE_ROOT="/var/tmp/deploylite-preview/$preview_id" VPS_SOURCE_URL=https://example.test/deploylite.git VPS_COMMIT="$commit" VPS_TREE="$tree" VPS_MIGRATION_COMMAND='printf "%s\n" "$COMPOSE_PROJECT_NAME" > "$PROJECT_SCOPE_LOG"; printf "migration output\n"' VPS_KEEP_PREVIEW=0)
invalid_ports_id="invalid-ports-$RANDOM"; invalid_ports_root="/var/tmp/deploylite-preview/$invalid_ports_id"
run_case remote-invalid-ports 3 "${envbase[@]}" VPS_REMOTE_ROOT="$invalid_ports_root" VPS_LOOPBACK_PORTS='0.0.0.0:15432,127.0.0.1:18080,127.0.0.1:18443' bash "$script" migration-only "$invalid_ports_id"
[[ ! -e "$invalid_ports_root" ]]
pass_through_id="pass-through-$RANDOM"; pass_through_root="/var/tmp/deploylite-preview/$pass_through_id"; pass_through_log="$work/pass-through.log"
# shellcheck disable=SC2016
"${envbase[@]}" VPS_REMOTE_ROOT="$pass_through_root" VPS_LOOPBACK_PORTS='127.0.0.1:015432,127.0.0.1:18080,127.0.0.1:18443' VPS_MIGRATION_COMMAND='printf "%s\n" "$VPS_LOOPBACK_PORTS" > "$PASS_THROUGH_LOG"' PASS_THROUGH_LOG="$pass_through_log" bash "$script" migration-only "$pass_through_id" >"$work/pass-through-output" 2>&1
[[ "$(<"$pass_through_log")" == '127.0.0.1:015432,127.0.0.1:18080,127.0.0.1:18443' && ! -e "$pass_through_root" ]]
output="$("${envbase[@]}" bash "$script" migration-only "$preview_id")"; [[ "$output" == *'EVIDENCE: migration_rc=0'* && "$output" == *'PASS: migration-only'* ]]
printf '%s\n' "$output" > "$work/success"
[[ -f "$project_scope_log" ]] || { printf 'migration project scope was not recorded\n' >&2; exit 1; }
scope="$(<"$project_scope_log")"; [[ "$scope" == "deploylite-preview-$preview_id" ]] || { printf 'expected isolated migration project, got %s\n' "$scope" >&2; exit 1; }
[[ "$scope" != deploylite && "$scope" != canonical* ]] || exit 1
assert_order "$work/success" 'PHASE: setup complete' 'PHASE: migration start' 'PHASE: migration complete status=0' 'PHASE: evidence start' 'PHASE: evidence complete' 'PHASE: cleanup start' 'PHASE: cleanup complete status=0'
grep -Fq -- 'down --volumes --remove-orphans' "$compose_log"
grep -Fq -- 'owned-image' "$rm_log"
if grep -Fq -- 'shared-image' "$rm_log"; then exit 1; fi
[[ ! -e "/var/tmp/deploylite-preview/$preview_id" ]]
streamed_id="streamed-$RANDOM"; streamed_output="$work/streamed-output"
set +e; "${envbase[@]}" VPS_REMOTE_ROOT="/var/tmp/deploylite-preview/$streamed_id" \
  VPS_MIGRATION_COMMAND='cat >/dev/null; printf "streamed migration\n"' \
  bash -s migration-only "$streamed_id" <"$script" >"$streamed_output" 2>&1; status=$?; set -e
[[ "$status" -eq 0 && ! -e "/var/tmp/deploylite-preview/$streamed_id" ]]
[[ "$(grep -c '^VPS_EVIDENCE_BEGIN$' "$streamed_output")" -eq 1 ]]
[[ "$(grep -c '^VPS_EVIDENCE_END$' "$streamed_output")" -eq 1 ]]
grep -Fq 'EVIDENCE: migration_rc=0' "$streamed_output"
grep -Fq 'migration_rc=0' "$streamed_output"
grep -Fq 'PASS: migration-only' "$streamed_output"
assert_order "$streamed_output" 'PHASE: setup complete' 'PHASE: migration start' 'PHASE: migration complete status=0' 'PHASE: evidence start' 'PHASE: evidence complete' 'PHASE: cleanup start' 'PHASE: cleanup complete status=0'
preview_streamed_id="preview-streamed-$RANDOM"; preview_streamed_output="$work/preview-streamed-output"; preview_streamed_log="$work/preview-streamed-compose.log"; preview_health_log="$work/preview-streamed-health.log"
# shellcheck disable=SC2016
preview_health_command='cat >/dev/null; printf "health\n" >> "$HEALTH_LOG"; printf "healthy\n"'
set +e; "${envbase[@]}" VPS_REMOTE_ROOT="/var/tmp/deploylite-preview/$preview_streamed_id" \
  VPS_COMPOSE_WRAPPER="$work/consuming-compose" COMPOSE_LOG="$preview_streamed_log" HEALTH_LOG="$preview_health_log" \
  VPS_MIGRATION_COMMAND='printf "preview migration\n"' \
  VPS_HEALTH_COMMAND="$preview_health_command" \
  bash -s preview "$preview_streamed_id" <"$script" >"$preview_streamed_output" 2>&1; status=$?; set -e
[[ "$status" -eq 0 && -e "/var/tmp/deploylite-preview/$preview_streamed_id/.deploylite-preview-owner" ]] || { cat "$preview_streamed_output" >&2; exit 1; }
grep -Fq -- '--project-name deploylite-preview-'"$preview_streamed_id"' up -d postgres api web' "$preview_streamed_log"
grep -Fxq 'health' "$preview_health_log"
grep -Fq 'healthy' "$preview_streamed_output"
grep -Fq 'PASS: preview' "$preview_streamed_output"
assert_order "$preview_streamed_output" 'PHASE: evidence complete' 'healthy' 'PASS: preview'
[[ -d "/var/tmp/deploylite-preview/$preview_streamed_id/source" && -d "/var/tmp/deploylite-preview/$preview_streamed_id/evidence" ]]
rm -rf -- "/var/tmp/deploylite-preview/$preview_streamed_id"
command_streamed_id="command-streamed-$RANDOM"; command_streamed_output="$work/command-streamed-output"; command_streamed_log="$work/command-streamed.log"
set +e; "${envbase[@]}" VPS_REMOTE_ROOT="/var/tmp/deploylite-preview/$command_streamed_id" \
  VPS_COMPOSE_COMMAND='cat >/dev/null; printf "compose command\n"' COMPOSE_LOG="$command_streamed_log" \
  VPS_MIGRATION_COMMAND='printf "command migration\n"' VPS_HEALTH_COMMAND='cat >/dev/null; printf "command health\n"' \
  bash -s preview "$command_streamed_id" <"$script" >"$command_streamed_output" 2>&1; status=$?; set -e
[[ "$status" -eq 0 && -e "/var/tmp/deploylite-preview/$command_streamed_id/.deploylite-preview-owner" ]]
grep -Fq 'compose command' "$command_streamed_output"
grep -Fq 'command health' "$command_streamed_output"
grep -Fq 'PASS: preview' "$command_streamed_output"
rm -rf -- "/var/tmp/deploylite-preview/$command_streamed_id"
cleanup_streamed_id="cleanup-streamed-$RANDOM"; cleanup_streamed_root="/var/tmp/deploylite-preview/$cleanup_streamed_id"
mkdir -p "$cleanup_streamed_root"
printf 'deploylite-preview-owner\n%s\ndeploylite-preview-%s\n' "$cleanup_streamed_id" "$cleanup_streamed_id" > "$cleanup_streamed_root/.deploylite-preview-owner"
cleanup_streamed_output="$work/cleanup-streamed-output"
"${envbase[@]}" VPS_REMOTE_ROOT="$cleanup_streamed_root" VPS_COMPOSE_WRAPPER="$work/consuming-compose" COMPOSE_LOG="$preview_streamed_log" \
  bash -s cleanup "$cleanup_streamed_id" <"$script" >"$cleanup_streamed_output" 2>&1
grep -Fq 'PASS: cleanup' "$cleanup_streamed_output"
grep -Fq -- '--project-name deploylite-preview-'"$cleanup_streamed_id"' down --volumes --remove-orphans' "$preview_streamed_log"
[[ ! -e "$cleanup_streamed_root" ]]
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
# shellcheck disable=SC2016
failed_migration_command='printf "%s\n" "$COMPOSE_PROJECT_NAME" > "$PROJECT_SCOPE_LOG"; printf "migration failure\n"; exit 7'
set +e; "${envbase[@]}" VPS_REMOTE_ROOT="/var/tmp/deploylite-preview/test-two" VPS_MIGRATION_COMMAND="$failed_migration_command" bash "$script" migration-only test-two >"$work/fail" 2>&1; status=$?; set -e
[[ "$status" -eq 10 && ! -e "/var/tmp/deploylite-preview/$preview_id" ]]
[[ -f "$project_scope_log" ]] || { printf 'failed migration project scope was not recorded\n' >&2; exit 1; }
scope="$(<"$project_scope_log")"; [[ "$scope" == deploylite-preview-test-two ]] || { printf 'expected isolated failed migration project, got %s\n' "$scope" >&2; exit 1; }
[[ "$scope" != deploylite && "$scope" != canonical* ]] || exit 1
grep -Fq 'EVIDENCE: migration_rc=7' "$work/fail"
assert_order "$work/fail" 'PHASE: setup complete' 'PHASE: migration start' 'PHASE: migration complete status=7' 'PHASE: evidence start' 'PHASE: evidence complete' 'PHASE: cleanup start' 'PHASE: cleanup complete status=0'
evidence_failure_id="evidence-failure-$RANDOM"; evidence_failure_output="$work/evidence-failure"
set +e; "${envbase[@]}" VPS_REMOTE_ROOT="/var/tmp/deploylite-preview/$evidence_failure_id" VPS_MAX_EVIDENCE_BYTES=invalid bash "$script" migration-only "$evidence_failure_id" >"$evidence_failure_output" 2>&1; status=$?; set -e
[[ "$status" -eq 1 && ! -e "/var/tmp/deploylite-preview/$evidence_failure_id" ]]
if grep -Fq 'VPS_EVIDENCE_BEGIN' "$evidence_failure_output"; then exit 1; fi
assert_order "$evidence_failure_output" 'PHASE: setup complete' 'PHASE: migration start' 'PHASE: migration complete status=0' 'PHASE: evidence start' 'PHASE: cleanup start' 'PHASE: cleanup complete status=0'
set +e; "${envbase[@]}" VPS_REMOTE_ROOT=/var/tmp/deploylite-preview/cleanup-failure VPS_CLEANUP_FAIL=1 VPS_MIGRATION_COMMAND='exit 7' bash "$script" migration-only cleanup-failure >"$work/cleanup-fail" 2>&1; rc=$?; set -e
[[ "$rc" -eq 10 ]] && grep -Fq 'EVIDENCE: migration_rc=7' "$work/cleanup-fail" && grep -Fq 'CLEANUP FAILED:' "$work/cleanup-fail"
grep -Fq 'PHASE: cleanup complete status=1' "$work/cleanup-fail"
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
