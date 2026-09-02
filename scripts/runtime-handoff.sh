#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly INSTALL_DIR="${DEPLOYLITE_INSTALL_DIR:-/opt/deploylite}"
readonly COMPOSE_FILE="${INSTALL_DIR}/compose.yml"
readonly TLS_COMPOSE_FILE="${INSTALL_DIR}/compose.tls.yml"
readonly KEYS='DEPLOYLITE_PUBLIC_HOST POSTGRES_PASSWORD DATABASE_URL DEPLOYLITE_SECRET_KEY'
ENV_FILE=''; SNAPSHOT_FILE=''; WORK=''; NORMALIZED=''; PUBLIC_HOST=''
SNAPSHOT_VALID=0; ROLLBACK_ATTEMPTED=0

# Never allow xtrace to observe argument handling, file contents, or Compose calls.
case "$-" in *x*) set +x ;; esac
fail() { printf 'runtime handoff failed: %s\n' "$1" >&2; exit "${2:-1}"; }
cleanup() { [[ -z "$WORK" ]] || rm -rf -- "$WORK"; }
trap cleanup EXIT
usage() { printf 'Usage: %s --env-file /absolute/path\n' "$0"; }

parse_args() {
  [[ $# -eq 2 && "$1" == --env-file && -n "$2" ]] || { usage >&2; fail 'exactly one --env-file is required' 2; }
  ENV_FILE=$2
  [[ "$ENV_FILE" == /* && "$ENV_FILE" != *$'\n'* && "$ENV_FILE" != *$'\r'* ]] || fail 'env-file path must be absolute and single-line' 2
}
is_root() { [[ "${EUID}" -eq 0 ]]; }
stat_value() { stat -c "$1" "$3" 2>/dev/null || stat -f "$2" "$3" 2>/dev/null; }
canonical_path() { local dir; dir=$(cd -P "$(dirname "$1")" 2>/dev/null && pwd -P) || return 1; printf '%s/%s\n' "$dir" "$(basename "$1")"; }

snapshot_env_file() {
  local canonical before after snapshot_dir
  is_root || fail 'root execution is required; re-run with sudo' 2
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail 'env-file must be a regular non-symlink file' 2
  canonical=$(canonical_path "$ENV_FILE") || fail 'env-file parent is not accessible' 2
  [[ "$canonical" == "$ENV_FILE" ]] || fail 'env-file path must be canonical (no symlinked parent)' 2
  [[ "$(stat_value '%u' '%u' "$ENV_FILE")" == 0 ]] || fail 'env-file must be owned by root' 2
  [[ "$(stat_value '%a' '%Lp' "$ENV_FILE")" == 600 ]] || fail 'env-file mode must be exactly 0600' 2
  before=$(stat_value '%d:%i:%s:%Y:%a:%u' '%d:%i:%z:%m:%Lp:%u' "$ENV_FILE") || fail 'cannot inspect env-file identity' 2
  snapshot_dir=$(mktemp -d "${TMPDIR:-/tmp}/deploylite-runtime.XXXXXX") || fail 'cannot create private runtime snapshot directory' 2
  chmod 700 "$snapshot_dir"
  WORK="$snapshot_dir"; SNAPSHOT_FILE="${snapshot_dir}/env"
  cp -P "$ENV_FILE" "$SNAPSHOT_FILE" || fail 'cannot snapshot env-file safely' 2
  chmod 600 "$SNAPSHOT_FILE"
  [[ -f "$SNAPSHOT_FILE" && ! -L "$SNAPSHOT_FILE" ]] || fail 'runtime snapshot is not a regular file' 2
  [[ "$(stat_value '%u' '%u' "$SNAPSHOT_FILE")" == 0 ]] || fail 'runtime snapshot owner is unsafe' 2
  [[ "$(stat_value '%a' '%Lp' "$SNAPSHOT_FILE")" == 600 ]] || fail 'runtime snapshot mode is unsafe' 2
  after=$(stat_value '%d:%i:%s:%Y:%a:%u' '%d:%i:%z:%m:%Lp:%u' "$ENV_FILE") || fail 'cannot recheck env-file identity' 2
  [[ "$before" == "$after" ]] || fail 'env-file changed while creating the runtime snapshot' 2
}

scan_keys() {
  local line key count=0 trimmed
  [[ "$(LC_ALL=C od -An -tx1 "$SNAPSHOT_FILE")" != *' 00 '* ]] || fail 'env-file contains NUL bytes' 2
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" != *$'\r'* ]] || fail 'CRLF is not accepted; use LF line endings' 2
    trimmed="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$trimmed" || "${trimmed:0:1}" == '#' ]] && continue
    if [[ "$trimmed" == export[[:space:]]* ]]; then trimmed="${trimmed#export}"; trimmed="${trimmed#"${trimmed%%[![:space:]]*}"}"; fi
    [[ "$trimmed" =~ ^([A-Z][A-Z0-9_]*)[[:space:]]*= ]] || fail 'env-file contains a malformed assignment' 2
    key=${BASH_REMATCH[1]}
    case " $KEYS " in *" $key "*) ;; *) fail 'env-file contains an unknown key' 2 ;; esac
    case "$key" in
      DEPLOYLITE_PUBLIC_HOST) [[ "${PUBLIC_HOST_SEEN:-}" != 1 ]] || fail 'env-file contains a duplicate key' 2; PUBLIC_HOST_SEEN=1 ;;
      POSTGRES_PASSWORD) [[ "${PASSWORD_SEEN:-}" != 1 ]] || fail 'env-file contains a duplicate key' 2; PASSWORD_SEEN=1 ;;
      DATABASE_URL) [[ "${DATABASE_URL_SEEN:-}" != 1 ]] || fail 'env-file contains a duplicate key' 2; DATABASE_URL_SEEN=1 ;;
      DEPLOYLITE_SECRET_KEY) [[ "${SECRET_SEEN:-}" != 1 ]] || fail 'env-file contains a duplicate key' 2; SECRET_SEEN=1 ;;
    esac
    count=$((count + 1))
  done <"$SNAPSHOT_FILE"
  [[ "$count" -eq 4 && "${PUBLIC_HOST_SEEN:-}" == 1 && "${PASSWORD_SEEN:-}" == 1 && "${DATABASE_URL_SEEN:-}" == 1 && "${SECRET_SEEN:-}" == 1 ]] || fail 'env-file must contain exactly the four required keys' 2
}

compose() { docker compose --env-file "$SNAPSHOT_FILE" -f "$COMPOSE_FILE" -f "$TLS_COMPOSE_FILE" "$@"; }
safe_compose() {
  local output status; output=$(mktemp "$WORK/docker.XXXXXX")
  if compose "$@" >"$output" 2>&1; then rm -f "$output"; return 0; else status=$?; fi
  rm -f "$output"; printf 'runtime handoff failed: Compose operation failed (%s); existing resources were preserved\n' "${1:-unknown}" >&2; return "$status"
}
run_compose_or_rollback() { local status; safe_compose "$@"; status=$?; if [[ "$status" -ne 0 ]]; then rollback; return "$status"; fi; }
normalize_compose_environment() {
  NORMALIZED=$(mktemp "$WORK/environment.XXXXXX")
  if ! compose config --environment >"$NORMALIZED" 2>/dev/null; then rm -f "$NORMALIZED"; fail 'Compose env-file normalization failed' 2; fi
  PUBLIC_HOST=$(awk -F= '$1 == "DEPLOYLITE_PUBLIC_HOST" { print substr($0, index($0, "=") + 1); found=1 } END { exit(found ? 0 : 1) }' "$NORMALIZED") || fail 'normalized public host is missing' 2
  [[ "$PUBLIC_HOST" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] || fail 'normalized public host is not a valid hostname' 2
  awk -F= 'BEGIN { bad=0 } $1 == "POSTGRES_PASSWORD" || $1 == "DATABASE_URL" || $1 == "DEPLOYLITE_SECRET_KEY" { value=substr($0,index($0,"=")+1); if (value == "" || tolower(value) ~ /^(placeholder|changeme|replace_me|example)$/) bad=1 } END { exit bad }' "$NORMALIZED" || fail 'normalized runtime values are missing or placeholders' 2
  awk -F= '$1 == "DATABASE_URL" { v=substr($0,index($0,"=")+1); ok=(v ~ /^postgres(ql)?:\/\/[^\/@:]+(:[^\/@]*)?@[^\/[:space:]]+\/.+$/) } END { exit(ok ? 0 : 1) }' "$NORMALIZED" || fail 'normalized DATABASE_URL is invalid' 2
  awk -F= '$1 == "DEPLOYLITE_SECRET_KEY" { v=substr($0,index($0,"=")+1); ok=(length(v) >= 16 && v ~ /^[A-Za-z0-9+\/=._-]+$/) } END { exit(ok ? 0 : 1) }' "$NORMALIZED" || fail 'normalized secret key is invalid' 2
}
ids() { docker "$@" 2>/dev/null; }
was_present() { local old; while IFS= read -r old; do [[ "$old" == "$2" ]] && return 0; done <"$1"; return 1; }
snapshot_resources() {
  local containers="$WORK/containers.before" networks="$WORK/networks.before" volumes="$WORK/volumes.before"
  SNAPSHOT_VALID=0
  if ! ids ps -aq --filter label=com.docker.compose.project=deploylite >"$containers"; then fail 'initial resource snapshot failed' 2; fi
  if ! ids network ls -q --filter label=com.docker.compose.project=deploylite >"$networks"; then fail 'initial resource snapshot failed' 2; fi
  if ! ids volume ls -q --filter label=com.docker.compose.project=deploylite >"$volumes"; then fail 'initial resource snapshot failed' 2; fi
  SNAPSHOT_VALID=1
}
rollback() {
  local id label containers_after networks_after containers_remove networks_remove
  [[ "$SNAPSHOT_VALID" -eq 1 && "$ROLLBACK_ATTEMPTED" -eq 0 ]] || return 0
  ROLLBACK_ATTEMPTED=1
  containers_after="$WORK/containers.after"; networks_after="$WORK/networks.after"
  containers_remove="$WORK/containers.remove"; networks_remove="$WORK/networks.remove"
  if ! ids ps -aq --filter label=com.docker.compose.project=deploylite >"$containers_after"; then printf 'runtime handoff failed; resource discovery was incomplete; existing resources were preserved\n' >&2; return 0; fi
  if ! ids network ls -q --filter label=com.docker.compose.project=deploylite >"$networks_after"; then printf 'runtime handoff failed; resource discovery was incomplete; existing resources were preserved\n' >&2; return 0; fi
  : >"$containers_remove"; : >"$networks_remove"
  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    if ! was_present "$WORK/containers.before" "$id"; then
      if ! label=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$id" 2>/dev/null); then printf 'runtime handoff failed; resource discovery was incomplete; existing resources were preserved\n' >&2; return 0; fi
      [[ "$label" == deploylite ]] && printf '%s\n' "$id" >>"$containers_remove"
    fi
  done <"$containers_after"
  while IFS= read -r id; do
    [[ -z "$id" ]] && continue
    if ! was_present "$WORK/networks.before" "$id"; then
      if ! label=$(docker network inspect --format '{{index .Labels "com.docker.compose.project"}}' "$id" 2>/dev/null); then printf 'runtime handoff failed; resource discovery was incomplete; existing resources were preserved\n' >&2; return 0; fi
      [[ "$label" == deploylite ]] && printf '%s\n' "$id" >>"$networks_remove"
    fi
  done <"$networks_after"
  while IFS= read -r id; do [[ -z "$id" ]] || docker rm -f "$id" >/dev/null 2>&1 || printf 'runtime handoff failed; cleanup was incomplete; existing resources were preserved\n' >&2; done <"$containers_remove"
  while IFS= read -r id; do [[ -z "$id" ]] || docker network rm "$id" >/dev/null 2>&1 || printf 'runtime handoff failed; cleanup was incomplete; existing resources were preserved\n' >&2; done <"$networks_remove"
}
on_error() { local status=$?; rollback; printf 'runtime handoff failed; no volumes or pre-existing resources were removed\n' >&2; exit "$status"; }
on_exit() { local status=$?; trap - EXIT; rollback; cleanup; exit "$status"; }
on_signal() { local status=$1; rollback; exit "$status"; }
trap on_error ERR; trap on_exit EXIT; trap 'on_signal 130' INT; trap 'on_signal 143' TERM

main() {
  parse_args "$@"; snapshot_env_file; scan_keys
  [[ -f "$COMPOSE_FILE" && -f "$TLS_COMPOSE_FILE" ]] || fail 'installed Compose files are missing' 2
  command -v docker >/dev/null 2>&1 || fail 'docker is required' 2
  snapshot_resources; run_compose_or_rollback config --no-interpolate || return $?
  normalize_compose_environment || return $?
  run_compose_or_rollback --profile bootstrap up -d --wait --wait-timeout 180 traefik postgres || return $?
  run_compose_or_rollback --profile bootstrap run --rm --no-deps migrate || return $?
  run_compose_or_rollback --profile bootstrap up -d --wait --wait-timeout 180 api web || return $?
  printf 'Runtime handoff completed for %s. Tentative URL: https://%s/\n' "$PUBLIC_HOST" "$PUBLIC_HOST"
  printf 'Verify DNS, ACME issuance, and end-to-end HTTPS externally; this command does not assert public availability.\n'
}
if [[ "${BASH_SOURCE[0]:-}" == "$0" ]]; then main "$@"; fi
