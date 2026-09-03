#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly INSTALL_DIR="${DEPLOYLITE_INSTALL_DIR:-/opt/deploylite}"
readonly COMPOSE_FILE="${INSTALL_DIR}/compose.yml"
readonly TLS_COMPOSE_FILE="${INSTALL_DIR}/compose.tls.yml"
readonly KEYS='DEPLOYLITE_PUBLIC_HOST POSTGRES_PASSWORD DATABASE_URL DEPLOYLITE_SECRET_KEY'
SOURCE_DIR="${INSTALL_DIR}/source"
readonly SOURCES_DIR="${INSTALL_DIR}/.sources"
SOURCE_MARKER="${SOURCE_DIR}/.deploylite-source"
ENV_FILE=''; SNAPSHOT_FILE=''; WORK=''; NORMALIZED=''; PUBLIC_HOST=''
SNAPSHOT_VALID=0; ROLLBACK_SAFE=0; ROLLBACK_ARMED=0; COMMITTED=0; ROLLBACK_ATTEMPTED=0

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
stat_value() { [[ $# -eq 4 ]] || return 1; local gnu_format="$1" bsd_format="$2" path="$3" pattern="$4" value; if value="$(stat -c "$gnu_format" "$path" 2>/dev/null)" && [[ "$value" =~ $pattern ]]; then printf '%s' "$value"; return 0; fi; if value="$(stat -f "$bsd_format" "$path" 2>/dev/null)" && [[ "$value" =~ $pattern ]]; then printf '%s' "$value"; return 0; fi; return 1; }
stat_owner_group() { stat_value '%u:%g' '%u:%g' "$1" '^[0-9]+:[0-9]+$'; }
stat_device_inode() { stat_value '%d:%i' '%d:%i' "$1" '^[0-9]+:[0-9]+$'; }
stat_identity_runtime() { stat_value '%d:%i:%s:%Y:%a:%u' '%d:%i:%z:%m:%Lp:%u' "$1" '^[0-9]+(:[0-9]+){5}$'; }
stat_owner() { stat_value '%u' '%u' "$1" '^[0-9]+$'; }
stat_mode() { stat_value '%a' '%Lp' "$1" '^[0-9]+$'; }
canonical_path() { local dir; dir=$(cd -P "$(dirname "$1")" 2>/dev/null && pwd -P) || return 1; printf '%s/%s\n' "$dir" "$(basename "$1")"; }
sha256_text_runtime() { if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'; else shasum -a 256 | awk '{print $1}'; fi; }
sha256_file_runtime() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
executable_source_path_runtime() { case "$1" in */scripts/bootstrap.sh|*/scripts/bootstrap.test.sh|*/scripts/install.sh|*/scripts/install.test.sh|*/scripts/install-tee.test.sh|*/scripts/runtime-contract.test.sh|*/scripts/runtime-handoff.sh|*/scripts/runtime-handoff.test.sh|*/scripts/support-policy.test.sh|*/scripts/vps-preview-contract.test.sh|*/scripts/vps-preview-failure-matrix.test.sh|*/scripts/vps-preview-full.test.sh|*/scripts/vps-preview-lib.sh|*/scripts/vps-preview-remote.sh|*/scripts/vps-preview-remote.test.sh|*/scripts/vps-preview.sh) return 0 ;; *) return 1 ;; esac; }
source_manifest_runtime() { local root="$1" base="${2:-$1}" path relative mode hash; for path in "$root"/* "$root"/.[!.]* "$root"/..?*; do [[ -e "$path" || -L "$path" ]] || continue; [[ "$path" != "$base/.deploylite-source" ]] || continue; relative="${path#"$base"/}"; if [[ -d "$path" ]]; then printf 'owner=0:0|type=directory|mode=0755|path=%s|sha256=-\n' "$relative"; elif [[ -f "$path" ]]; then mode=0644; executable_source_path_runtime "$path" && mode=0755; hash="$(sha256_file_runtime "$path")"; printf 'owner=0:0|type=file|mode=%s|path=%s|sha256=%s\n' "$mode" "$relative" "$hash"; else return 1; fi; [[ -d "$path" && ! -L "$path" ]] && source_manifest_runtime "$path" "$base"; done | LC_ALL=C sort; }
sha256_tree() { source_manifest_runtime "$1" | sha256_text_runtime; }
is_dotenv_basename_runtime() { case "${1##*/}" in .env|.env.*) return 0 ;; *) return 1 ;; esac; }
is_runtime_forbidden_basename_runtime() { case "${1##*/}" in .git|node_modules) return 0 ;; *) return 1 ;; esac; }
validate_source_tree_runtime() { local root="$1" path inode mode; [[ "$(stat_owner_group "$root")" == 0:0 && "$(stat_mode "$root")" == 755 ]] || return 1; for path in "$root"/* "$root"/.[!.]* "$root"/..?*; do [[ -e "$path" || -L "$path" ]] || continue; [[ ! -L "$path" && ( -d "$path" || -f "$path" ) ]] || return 1; is_dotenv_basename_runtime "$path" && return 1; is_runtime_forbidden_basename_runtime "$path" && return 1; [[ "$(stat_owner_group "$path")" == 0:0 ]] || return 1; if [[ -d "$path" ]]; then mode=755; else mode=644; executable_source_path_runtime "$path" && mode=755; inode="$(stat_device_inode "$path")"; [[ "$SOURCE_INODES" != *"|$inode|"* ]] || return 1; SOURCE_INODES="${SOURCE_INODES}${inode}|"; fi; [[ "$(stat_mode "$path")" == "$mode" ]] || return 1; if [[ -d "$path" ]]; then validate_source_tree_runtime "$path" || return 1; fi; done; }
validate_source() {
  local schema repository commit archive_sha manifest key value marker_digest
  local target target_path target_root sources_root
  [[ -L "$SOURCE_DIR" && -f "$SOURCE_MARKER" && ! -L "$SOURCE_MARKER" && -d "$SOURCES_DIR" && ! -L "$SOURCES_DIR" ]] || fail 'installed source pointer is missing or unsafe' 2
  [[ "$(stat_owner_group "$SOURCES_DIR")" == 0:0 && "$(stat_mode "$SOURCES_DIR")" == 700 ]] || fail 'installed source versions directory ownership or mode is unsafe' 2
  sources_root=$(cd -P "$SOURCES_DIR" 2>/dev/null && pwd -P) || fail 'installed source versions directory is inaccessible' 2
  target=$(readlink "$SOURCE_DIR") || fail 'installed source pointer cannot be read' 2
  [[ "$target" =~ ^\.sources/[0-9A-Fa-f]{64}(\.[0-9A-Fa-f]{64}\.[0-9]+\.[0-9]+)?$ ]] || fail 'installed source pointer format is unsafe' 2
  target_path="$(dirname "$SOURCE_DIR")/$target"
  [[ -d "$target_path" && ! -L "$target_path" ]] || fail 'installed source pointer target is unsafe' 2
  target_root=$(cd -P "$target_path" 2>/dev/null && pwd -P) || fail 'installed source pointer target is inaccessible' 2
  [[ "$target_root" == "$sources_root"/* && "$target_root" != "$sources_root" ]] || fail 'installed source pointer target is outside .sources' 2
  SOURCE_DIR="$target_root"; SOURCE_MARKER="$SOURCE_DIR/.deploylite-source"
  [[ "$(stat_owner "$SOURCE_MARKER")" == 0 && "$(stat_mode "$SOURCE_MARKER")" == 644 ]] || fail 'installed source marker ownership or mode is unsafe' 2
  [[ "$(awk 'END {print NR}' "$SOURCE_MARKER")" == 5 ]] || fail 'source marker must contain exactly five fields' 2
  while IFS='=' read -r key value; do
    case "$key" in schema) schema="$value" ;; repository) repository="$value" ;; commit) commit="$value" ;; archive_sha256) archive_sha="$value" ;; manifest_sha256) manifest="$value" ;; *) fail 'source marker contains an unexpected field' 2 ;; esac
  done <"$SOURCE_MARKER"
  [[ "$schema" == 2 && "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$commit" =~ ^[0-9a-fA-F]{40}$ && "$archive_sha" =~ ^[0-9a-fA-F]{64}$ && "$manifest" =~ ^[0-9a-fA-F]{64}$ ]] || fail 'source marker identity is invalid' 2
  [[ "$(basename "$SOURCE_DIR")" == "$manifest" || "$(basename "$SOURCE_DIR")" == "$manifest."* ]] || fail 'source pointer version does not match its manifest' 2
  SOURCE_INODES='|'; validate_source_tree_runtime "$SOURCE_DIR" || fail 'installed source bundle failed integrity validation' 2
  for key in apps/api/Dockerfile apps/web/Dockerfile package.json pnpm-lock.yaml .node-version; do [[ -f "$SOURCE_DIR/$key" && ! -L "$SOURCE_DIR/$key" ]] || fail 'installed source bundle is incomplete' 2; done
  marker_digest="$(sha256_tree "$SOURCE_DIR")"; [[ "$marker_digest" == "$manifest" ]] || fail 'installed source bundle integrity check failed' 2
}

snapshot_env_file() {
  local canonical before after snapshot_dir
  is_root || fail 'root execution is required; re-run with sudo' 2
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail 'env-file must be a regular non-symlink file' 2
  canonical=$(canonical_path "$ENV_FILE") || fail 'env-file parent is not accessible' 2
  [[ "$canonical" == "$ENV_FILE" ]] || fail 'env-file path must be canonical (no symlinked parent)' 2
  [[ "$(stat_owner "$ENV_FILE")" == 0 ]] || fail 'env-file must be owned by root' 2
  [[ "$(stat_mode "$ENV_FILE")" == 600 ]] || fail 'env-file mode must be exactly 0600' 2
  before=$(stat_identity_runtime "$ENV_FILE") || fail 'cannot inspect env-file identity' 2
  snapshot_dir=$(mktemp -d "${TMPDIR:-/tmp}/deploylite-runtime.XXXXXX") || fail 'cannot create private runtime snapshot directory' 2
  chmod 700 "$snapshot_dir"
  WORK="$snapshot_dir"; SNAPSHOT_FILE="${snapshot_dir}/env"
  cp -P "$ENV_FILE" "$SNAPSHOT_FILE" || fail 'cannot snapshot env-file safely' 2
  chmod 600 "$SNAPSHOT_FILE"
  [[ -f "$SNAPSHOT_FILE" && ! -L "$SNAPSHOT_FILE" ]] || fail 'runtime snapshot is not a regular file' 2
  [[ "$(stat_owner "$SNAPSHOT_FILE")" == 0 ]] || fail 'runtime snapshot owner is unsafe' 2
  [[ "$(stat_mode "$SNAPSHOT_FILE")" == 600 ]] || fail 'runtime snapshot mode is unsafe' 2
  after=$(stat_identity_runtime "$ENV_FILE") || fail 'cannot recheck env-file identity' 2
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
  [[ ! -s "$containers" && ! -s "$networks" ]] && ROLLBACK_SAFE=1
  SNAPSHOT_VALID=1
}
arm_rollback() {
  [[ "$SNAPSHOT_VALID" -eq 1 && "$ROLLBACK_SAFE" -eq 1 ]] || return 0
  ROLLBACK_ARMED=1
}
commit_transaction() {
  COMMITTED=1
  ROLLBACK_ARMED=0
}
rollback() {
  local id label containers_after networks_after containers_remove networks_remove
  [[ "$SNAPSHOT_VALID" -eq 1 && "$ROLLBACK_SAFE" -eq 1 && "$ROLLBACK_ARMED" -eq 1 && "$COMMITTED" -eq 0 && "$ROLLBACK_ATTEMPTED" -eq 0 ]] || { [[ "$SNAPSHOT_VALID" -eq 1 && "$ROLLBACK_SAFE" -eq 0 ]] && printf 'runtime handoff failed; pre-existing containers or networks detected, destructive rollback disabled\n' >&2; return 0; }
  ROLLBACK_ATTEMPTED=1
  ROLLBACK_ARMED=0
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
on_exit() { local status=$?; trap - EXIT; if [[ "$status" -ne 0 || ( "$ROLLBACK_ARMED" -eq 1 && "$COMMITTED" -eq 0 ) ]]; then rollback; [[ "$status" -ne 0 ]] || status=1; fi; cleanup; exit "$status"; }
on_signal() { local status=$1; rollback; exit "$status"; }
trap on_error ERR; trap on_exit EXIT; trap 'on_signal 130' INT; trap 'on_signal 143' TERM

main() {
  parse_args "$@"; validate_source; snapshot_env_file; scan_keys
  [[ -f "$COMPOSE_FILE" && -f "$TLS_COMPOSE_FILE" ]] || fail 'installed Compose files are missing' 2
  command -v docker >/dev/null 2>&1 || fail 'docker is required' 2
  snapshot_resources; run_compose_or_rollback config --no-interpolate || return $?
  normalize_compose_environment || return $?
  arm_rollback
  run_compose_or_rollback --profile bootstrap up -d --wait --wait-timeout 180 traefik postgres || return $?
  run_compose_or_rollback --profile bootstrap run --rm --no-deps migrate || return $?
  run_compose_or_rollback --profile bootstrap up -d --wait --wait-timeout 180 api web || return $?
  commit_transaction
  printf '%s\n' 'runtime handoff transaction committed'
  printf 'Runtime handoff completed for %s. Tentative URL: https://%s/\n' "$PUBLIC_HOST" "$PUBLIC_HOST"
  printf 'Verify DNS, ACME issuance, and end-to-end HTTPS externally; this command does not assert public availability.\n'
}
if [[ "${BASH_SOURCE[0]:-}" == "$0" ]]; then main "$@"; fi
