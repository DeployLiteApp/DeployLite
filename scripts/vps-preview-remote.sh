#!/usr/bin/env bash
set -Eeuo pipefail
set +x

mode="${1:-}"; [[ "$mode" == migration-only || "$mode" == preview || "$mode" == cleanup ]] || { printf 'BLOCKED: invalid mode.\n' >&2; exit 3; }; shift
preview_id="${1:-}"; [[ "$preview_id" =~ ^[a-z0-9][a-z0-9-]{2,31}$ ]] || { printf 'BLOCKED: invalid preview ID.\n' >&2; exit 3; }; shift
root="${VPS_REMOTE_ROOT:-/var/tmp/deploylite-preview/$preview_id}"
marker="$root/.deploylite-preview-owner"
project="deploylite-preview-$preview_id"
source_dir="$root/source"
evidence="$root/evidence"
raw_output="$evidence/migration.raw"
raw_rc="$evidence/migration.rc"
git_bin="${VPS_GIT_BIN:-git}"
docker_bin="${VPS_DOCKER_BIN:-docker}"
compose_file="$source_dir/infra/vps/compose.yml"
override_file="$root/preview.override.yml"
env_file="$root/.env"
custom_mode=0
lifecycle_mode='native'
build_status='not-applicable'
readiness_status='not-run'; readiness_attempts=0; readiness_elapsed=0

blocked() { printf 'BLOCKED: %s\n' "$*" >&2; exit 3; }
require_loopback_ports() {
  local ports="$1" entry host port canonical previous
  local -a entries seen
  IFS=',' read -r -a entries <<< "$ports"
  [[ "${#entries[@]}" -eq 3 ]] || blocked 'VPS_LOOPBACK_PORTS must contain exactly three PostgreSQL, web, and API mappings.'
  for entry in "${entries[@]}"; do
    [[ "$entry" =~ ^127\.0\.0\.1:[0-9]{1,5}$ ]] || blocked 'VPS_LOOPBACK_PORTS must use exact 127.0.0.1 decimal mappings.'
    host="${entry%%:*}"; port="${entry#*:}"
    canonical="$port"
    while [[ "${#canonical}" -gt 1 && "${canonical#0}" != "$canonical" ]]; do canonical="${canonical#0}"; done
    [[ "$host" == 127.0.0.1 && "${#canonical}" -le 5 ]] || blocked 'VPS_LOOPBACK_PORTS ports must be decimal values from 1024 through 65535.'
    ((10#$canonical >= 1024 && 10#$canonical <= 65535)) || blocked 'VPS_LOOPBACK_PORTS ports must be decimal values from 1024 through 65535.'
    [[ "$canonical" != 80 && "$canonical" != 443 ]] || blocked 'VPS_LOOPBACK_PORTS must not use ports 80 or 443.'
    for previous in "${seen[@]:-}"; do
      [[ "$canonical" != "$previous" ]] || blocked 'VPS_LOOPBACK_PORTS ports must be numerically unique.'
    done
    seen+=("$canonical")
  done
}
if [[ "$mode" != cleanup ]]; then
  default_loopback_ports='127.0.0.1:55433,127.0.0.1:58080,127.0.0.1:58443'
  if [[ -n "${VPS_LOOPBACK_PORTS+x}" ]]; then
    preview_ports="$VPS_LOOPBACK_PORTS"
  else
    preview_ports="$default_loopback_ports"
  fi
  require_loopback_ports "$preview_ports"
fi
failed() { printf 'FAILED: %s\n' "$*" >&2; return 1; }
validate_native_timeout() {
  local value="$1" label="$2"
  [[ "$value" =~ ^[0-9]+$ && "$value" -gt 0 && "$value" -le 3600 ]] || failed "$label must be an integer from 1 through 3600."
}
compose() { "$docker_bin" compose -f "$compose_file" -f "$override_file" --env-file "$env_file" --project-name "$project" "$@"; }
native_override() {
  local rest
  postgres_port="${preview_ports%%,*}"; rest="${preview_ports#*,}"; web_port="${rest%%,*}"; api_port="${rest#*,}"
  postgres_port="${postgres_port#*:}"; web_port="${web_port#*:}"; api_port="${api_port#*:}"
  cat > "$override_file" <<EOF
services:
  migrate:
    image: deploylite-preview-${preview_id}-migrate:${VPS_COMMIT}
  api:
    image: deploylite-preview-${preview_id}-api:${VPS_COMMIT}
    ports: ["127.0.0.1:${api_port}:3001"]
  web:
    image: deploylite-preview-${preview_id}-web:${VPS_COMMIT}
    ports: ["127.0.0.1:${web_port}:3000"]
  postgres:
    ports: ["127.0.0.1:${postgres_port}:5432"]
EOF
  chmod 600 "$override_file"
}
native_health() {
  local timeout_seconds="${VPS_HEALTH_TIMEOUT:-30}" interval_seconds="${VPS_HEALTH_INTERVAL:-1}"
  local started elapsed remaining sleep_for service container ready
  validate_native_timeout "$timeout_seconds" 'VPS_HEALTH_TIMEOUT' || return 11
  validate_native_timeout "$interval_seconds" 'VPS_HEALTH_INTERVAL' || return 11
  started="$(date +%s)"; health_attempts=0
  while :; do
    elapsed=$(( $(date +%s) - started ))
    if (( elapsed >= timeout_seconds )); then
      readiness_status='timeout'; readiness_attempts="$health_attempts"; readiness_elapsed="$elapsed"
      printf 'READINESS: timeout attempts=%s elapsed=%ss category=timeout\n' "$health_attempts" "$elapsed"
      native_readiness_diagnostics
      return 1
    fi
    health_attempts=$((health_attempts + 1)); ready=1
    for service in postgres api web; do
      container="$(compose ps -q "$service" 2>/dev/null || true)"
      native_service_snapshot "$container"
      [[ "$service_health" == healthy ]] || ready=0
    done
    if (( ready == 1 )) && curl --fail --silent --output /dev/null "http://127.0.0.1:${api_port}/api/v1/health" && curl --fail --silent --output /dev/null "http://127.0.0.1:${web_port}/"; then
      readiness_status='healthy'; readiness_attempts="$health_attempts"; readiness_elapsed="$elapsed"
      printf 'READINESS: success attempts=%s elapsed=%ss category=healthy\n' "$health_attempts" "$elapsed"
      return 0
    fi
    remaining=$((timeout_seconds - elapsed))
    (( remaining > 0 )) || continue
    sleep_for="$interval_seconds"; (( sleep_for > remaining )) && sleep_for="$remaining"
    sleep "$sleep_for"
  done
}
native_service_snapshot() {
  local container="$1" snapshot
  service_state='exited'; service_health='missing'; service_exit_code='unknown'; service_oom='false'; service_restart_count=0
  [[ -n "$container" ]] || return 0
  snapshot="$($docker_bin inspect -f '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.RestartCount}}' "$container" 2>/dev/null || true)"
  IFS='|' read -r service_state service_health service_exit_code service_oom service_restart_count <<< "$snapshot"
  [[ "$service_state" == running || "$service_state" == exited ]] || service_state='exited'
  [[ "$service_health" =~ ^(healthy|unhealthy|starting|none|missing)$ ]] || service_health='unknown'
  [[ "$service_exit_code" =~ ^[0-9]+$ ]] || service_exit_code='unknown'
  [[ "$service_oom" == true ]] || service_oom='false'
  [[ "$service_restart_count" =~ ^[0-9]+$ ]] || service_restart_count=0
}
native_readiness_diagnostics() {
  local service container
  for service in postgres api web; do
    container="$(compose ps -q "$service" 2>/dev/null || true)"
    native_service_snapshot "$container"
    printf 'READINESS: diagnostic service=%s state=%s health=%s exit_code=%s oom=%s restart_count=%s\n' \
      "$service" "$service_state" "$service_health" "$service_exit_code" "$service_oom" "$service_restart_count"
  done
}
native_image_tags() {
  local line service tag count=0 found_migrate='' found_api='' found_web=''
  [[ -s "$override_file" ]] || failed 'native preview override is missing.'
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]+image:[[:space:]]+(deploylite-preview-${preview_id}-(migrate|api|web):[0-9a-f]{40})[[:space:]]*$ ]] || failed 'native preview override contains an unexpected image tag.'
    tag="${BASH_REMATCH[1]}"; service="${BASH_REMATCH[2]}"
    case "$service" in
      migrate) [[ -z "$found_migrate" ]] || failed 'native preview override contains duplicate image tags.'; found_migrate="$tag" ;;
      api) [[ -z "$found_api" ]] || failed 'native preview override contains duplicate image tags.'; found_api="$tag" ;;
      web) [[ -z "$found_web" ]] || failed 'native preview override contains duplicate image tags.'; found_web="$tag" ;;
    esac
    count=$((count + 1))
  done < <(awk '/^[[:space:]]+image:/{print}' "$override_file")
  [[ "$count" -eq 3 && -n "$found_migrate" && -n "$found_api" && -n "$found_web" ]] || failed 'native preview override must define exactly three image tags.'
  native_tags=("$found_migrate" "$found_api" "$found_web")
}
require_safe_resource() {
  [[ "$project" != deploylite && "$project" != *canonical* && "$project" != *production* ]] || blocked 'canonical Compose project is forbidden.'
  [[ "$root" == /var/tmp/deploylite-preview/* ]] || blocked 'remote root is not isolated.'
}
phase_setup() {
  require_safe_resource
  [[ ! -e "$root" ]] || blocked 'preview directory already exists; ownership cannot be proven safely.'
  mkdir -p "$evidence"
  printf 'deploylite-preview-owner\n%s\n%s\n' "$preview_id" "$project" > "$marker"
  chmod 600 "$marker"
  [[ "$(wc -l < "$marker")" -eq 3 ]] || failed 'ownership marker write failed.'
  [[ -n "${VPS_SOURCE_URL:-}" && -n "${VPS_COMMIT:-}" && -n "${VPS_TREE:-}" ]] || failed 'source URL, commit, and tree are required.'
  "$git_bin" init -q "$source_dir"
  "$git_bin" -C "$source_dir" remote add origin "$VPS_SOURCE_URL"
  "$git_bin" -C "$source_dir" fetch --depth=1 origin "$VPS_COMMIT"
  "$git_bin" -C "$source_dir" checkout --detach -q "$VPS_COMMIT"
  [[ -z "$($git_bin -C "$source_dir" status --porcelain)" ]] || failed 'remote checkout is not clean.'
  [[ "$($git_bin -C "$source_dir" rev-parse HEAD 2>/dev/null)" == "$VPS_COMMIT" ]] || failed 'remote commit verification failed.'
  [[ "$($git_bin -C "$source_dir" rev-parse 'HEAD^{tree}' 2>/dev/null)" == "$VPS_TREE" ]] || failed 'remote tree verification failed.'
  if [[ "$mode" == preview || ( "$mode" == migration-only && -z "${VPS_MIGRATION_COMMAND:-}" ) ]]; then
    local command_count=0 variable
    for variable in VPS_MIGRATION_COMMAND VPS_COMPOSE_COMMAND VPS_HEALTH_COMMAND; do
      [[ -n "${!variable:-}" ]] && command_count=$((command_count + 1))
    done
    if [[ "$mode" == preview ]] && (( command_count != 0 && command_count != 3 )); then
      [[ "$command_count" -eq 2 && -x "${VPS_COMPOSE_WRAPPER:-}" ]] || failed 'custom migration, Compose, and health commands must be supplied together.'
    fi
    if (( command_count == 0 )) && [[ ! -x "${VPS_COMPOSE_WRAPPER:-}" ]]; then
      local db_password secret
      command -v openssl >/dev/null 2>&1 || failed 'openssl is required for native preview secrets.'
      command -v curl >/dev/null 2>&1 || failed 'curl is required for native preview health checks.'
      db_password="$(openssl rand -hex 24)"; secret="$(openssl rand -hex 32)"
      printf 'POSTGRES_DB=deploylite\nPOSTGRES_USER=deploylite\nPOSTGRES_PASSWORD=%s\nDEPLOYLITE_SECRET_KEY=%s\nDATABASE_URL=postgres://deploylite:%s@postgres:5432/deploylite\n' \
        "$db_password" "$secret" "$db_password" > "$env_file"
      chmod 600 "$env_file"
      native_override
      printf '%s\n' 'BUILD: explicit images=migrate,api,web source=verified-commit-tree'
      compose build migrate api web
      build_status='explicit-complete'
      printf '%s\n' 'BUILD: complete'
    else
      custom_mode=1
      lifecycle_mode='custom'
    fi
  elif [[ -n "${VPS_MIGRATION_COMMAND:-}" ]]; then
    lifecycle_mode='custom'
  fi
  printf '%s\n' 'PHASE: setup complete'
}
phase_migrate() {
  local rc=0
  printf '%s\n' 'PHASE: migration start'
  : > "$raw_output"; chmod 600 "$raw_output"
  set +e
  if [[ -n "${VPS_MIGRATION_COMMAND:-}" ]]; then
    COMPOSE_PROJECT_NAME="$project" bash -c "$VPS_MIGRATION_COMMAND" </dev/null >"$raw_output" 2>&1
  elif [[ "$custom_mode" -eq 0 ]]; then
    compose up -d postgres >"$raw_output" 2>&1 && compose up migrate >>"$raw_output" 2>&1
  else
    failed 'VPS_MIGRATION_COMMAND is required.' >"$raw_output" 2>&1
  fi
  rc=$?
  set -e
  printf '%s\n' "$rc" > "$raw_rc"; chmod 600 "$raw_rc"
  printf 'PHASE: migration complete status=%s\n' "$rc"
  return "$rc"
}
phase_evidence() {
  local rc raw redacted checksum max_bytes
  printf '%s\n' 'PHASE: evidence start'
  max_bytes="${VPS_MAX_EVIDENCE_BYTES:-65536}"
  [[ "$max_bytes" =~ ^[0-9]+$ ]] || failed 'evidence byte limit is invalid.'
  rc="$(<"$raw_rc")"; raw="$(<"$raw_output")"
  [[ "$rc" =~ ^[0-9]+$ ]] || failed 'migration exit code evidence is invalid.'
  [[ -s "$raw_output" ]] || failed 'migration evidence is missing.'
  [[ -z "${VPS_DB_PASSWORD:-}" ]] || raw="${raw//"$VPS_DB_PASSWORD"/[REDACTED]}"
  [[ -z "${VPS_API_TOKEN:-}" ]] || raw="${raw//"$VPS_API_TOKEN"/[REDACTED]}"
  raw="$(printf '%s' "$raw" | sed -E -e 's/(Authorization:[[:space:]]*(Bearer|Basic)[[:space:]]+)[^[:space:]]+/\1[REDACTED]/Ig' -e 's/((PASSWORD|TOKEN|SECRET|API_KEY|DATABASE_URL)[[:space:]]*=[[:space:]]*)[^[:space:]]+/\1[REDACTED]/Ig' -e 's#(postgres(ql)?://[^:/@]+:)[^@[:space:]]+@#\1[REDACTED]@#Ig')"
  # Drain the pipe after head reaches the limit so printf cannot receive SIGPIPE under pipefail.
  redacted="$(printf '%s' "$raw" | { head -c "$max_bytes"; cat >/dev/null; })"
  checksum="$(printf '%s' "$redacted" | sha256sum | awk '{print $1}')"
  printf '%s\n' \
    'VPS_EVIDENCE_BEGIN' \
    "preview_id=$preview_id" "project=$project" "commit=${VPS_COMMIT:-}" "tree=${VPS_TREE:-}" \
    "mode=$mode" "lifecycle_mode=$lifecycle_mode" "source=verified-commit-tree" "build=$build_status" "migration_rc=$rc" "redacted_sha256=$checksum" 'output_begin' \
    "$redacted" 'output_end' 'VPS_EVIDENCE_END' > "$evidence/summary"
  chmod 600 "$evidence/summary"
  printf '%s\n' 'PHASE: evidence complete'
  printf 'EVIDENCE: migration_rc=%s\n' "$rc"
  cat "$evidence/summary"
}
record_readiness_evidence() {
  printf 'READINESS_EVIDENCE: status=%s attempts=%s elapsed=%ss\n' "$readiness_status" "$readiness_attempts" "$readiness_elapsed" >> "$evidence/summary"
  printf 'READINESS_EVIDENCE: status=%s attempts=%s elapsed=%ss\n' "$readiness_status" "$readiness_attempts" "$readiness_elapsed"
}
phase_cleanup() {
  require_safe_resource
  [[ -f "$marker" ]] || failed 'cleanup marker is missing; refusing rollback.'
  [[ "$(sed -n '1p' "$marker")" == deploylite-preview-owner && "$(sed -n '2p' "$marker")" == "$preview_id" && "$(sed -n '3p' "$marker")" == "$project" ]] || failed 'ownership marker drifted.'
  if ! command -v "$docker_bin" >/dev/null 2>&1; then failed 'validated Docker bin is unavailable.'; return 1; fi
  if [[ "${VPS_CLEANUP_FAIL:-0}" == 1 ]]; then failed 'injected cleanup failure.'; return 1; fi
  if [[ "$custom_mode" -eq 0 && -f "$override_file" && -f "$env_file" ]]; then
    native_image_tags
    local down_rc=0 project_container_ids container_count container_id label
    compose down --volumes --remove-orphans || down_rc=$?
    project_container_ids="$("$docker_bin" container ls -aq --filter "label=com.docker.compose.project=$project")" || { failed 'cannot enumerate project containers.'; return 1; }
    if [[ "$down_rc" -ne 0 || -n "$project_container_ids" ]]; then
      container_count=0
      [[ -z "$project_container_ids" ]] || container_count="$(printf '%s\n' "$project_container_ids" | awk 'NF { n++ } END { print n+0 }')"
      (( container_count <= 32 )) || { failed 'project container cleanup exceeded the bounded recovery limit.'; return 1; }
      while IFS= read -r container_id; do
        [[ -n "$container_id" ]] || continue
        [[ "$container_id" =~ ^[a-f0-9]+$ ]] || { failed 'project container identity is invalid.'; return 1; }
        label="$("$docker_bin" inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$container_id" 2>/dev/null || true)"
        [[ "$label" == "$project" ]] || { failed 'project container ownership verification failed; refusing recovery.'; return 1; }
      done <<< "$project_container_ids"
      while IFS= read -r container_id; do
        [[ -n "$container_id" ]] || continue
        "$docker_bin" container rm --force "$container_id" >/dev/null || { failed 'cannot remove an exactly owned project container.'; return 1; }
      done <<< "$project_container_ids"
      compose down --volumes --remove-orphans || return 1
    fi
  elif [[ -n "${VPS_COMPOSE_COMMAND:-}" ]]; then
    COMPOSE_PROJECT_NAME="$project" bash -c "$VPS_COMPOSE_COMMAND down --volumes --remove-orphans" </dev/null || return 1
  elif [[ -x "${VPS_COMPOSE_WRAPPER:-}" ]]; then
    "$VPS_COMPOSE_WRAPPER" --project-name "$project" down --volumes --remove-orphans </dev/null || return 1
  fi
  if [[ -f "$override_file" && "$custom_mode" -eq 0 ]]; then
    local tag
    for tag in "${native_tags[@]}"; do
      if "$docker_bin" image inspect "$tag" >/dev/null 2>&1; then
        "$docker_bin" image rm --force "$tag" || { failed "cannot remove preview image $tag."; return 1; }
      fi
    done
  fi
  local resource ids id
  for resource in container network volume image; do
    ids="$("$docker_bin" "$resource" ls -q --filter "label=com.docker.compose.project=$project")" || { failed "cannot inspect project $resource resources."; return 1; }
    if [[ -n "$ids" ]]; then
      if [[ "$resource" == image && ! -f "$override_file" ]]; then
        while IFS= read -r id; do
          [[ -n "$id" ]] || continue
          "$docker_bin" image rm --force "$id" >/dev/null || { failed 'cannot remove custom project image.'; return 1; }
        done <<< "$ids"
      else
        failed "project $resource cleanup left resources."; return 1
      fi
    fi
  done
  for resource in container network volume image; do
    ids="$("$docker_bin" "$resource" ls -q --filter "label=com.docker.compose.project=$project")" || { failed "cannot verify project $resource resources."; return 1; }
    [[ -z "$ids" ]] || { failed "project $resource verification found resources: $ids"; return 1; }
  done
  rm -rf -- "$root"
  printf '%s\n' 'CLEANUP: result=success category=owned-project'
}
cleanup_on_exit() {
  local primary=$?
  if [[ "$mode" == migration-only || "$primary" -ne 0 || "${VPS_KEEP_PREVIEW:-0}" != 1 ]]; then
    printf '%s\n' 'PHASE: cleanup start'
    set +e; cleanup_output="$(set -e; phase_cleanup 2>&1)"; cleanup_rc=$?; set -e
    printf 'PHASE: cleanup complete status=%s\n' "$cleanup_rc"
    [[ "$cleanup_rc" -eq 0 ]] || printf 'CLEANUP FAILED: %s\n' "$cleanup_output" >&2
    [[ "$primary" -ne 0 ]] && exit "$primary"
    [[ "${cleanup_rc:-0}" -eq 0 ]] || exit 2
  fi
  exit "$primary"
}
if [[ "$mode" == cleanup ]]; then
  printf '%s\n' 'PHASE: cleanup start'
  set +e; (set -e; phase_cleanup); cleanup_rc=$?; set -e
  printf 'PHASE: cleanup complete status=%s\n' "$cleanup_rc"
  [[ "$cleanup_rc" -eq 0 ]] || exit "$cleanup_rc"
  printf 'PASS: cleanup\n'
  exit 0
fi
trap cleanup_on_exit EXIT
trap 'exit 130' INT
phase_setup
phase_migrate || migration_rc=$?
phase_evidence
if [[ "${migration_rc:-0}" -ne 0 ]]; then exit 10; fi
if [[ "$mode" == preview ]]; then
  if [[ "$custom_mode" -eq 0 ]]; then
    compose up -d api web
  elif [[ -n "${VPS_COMPOSE_COMMAND:-}" ]]; then
    COMPOSE_PROJECT_NAME="$project" bash -c "$VPS_COMPOSE_COMMAND up -d postgres api web" </dev/null
  else
    "$VPS_COMPOSE_WRAPPER" --project-name "$project" up -d postgres api web </dev/null
  fi
  if [[ "$custom_mode" -eq 0 ]]; then
    native_health || { record_readiness_evidence; exit 11; }
    record_readiness_evidence
  else
    [[ -n "${VPS_HEALTH_COMMAND:-}" ]] || failed 'health command is required for preview.'
    timeout "${VPS_HEALTH_TIMEOUT:-30s}" bash -c "$VPS_HEALTH_COMMAND" </dev/null || exit 11
  fi
  VPS_KEEP_PREVIEW=1 export VPS_KEEP_PREVIEW
fi
printf 'PASS: %s\n' "$mode"
