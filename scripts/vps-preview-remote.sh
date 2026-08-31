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

blocked() { printf 'BLOCKED: %s\n' "$*" >&2; exit 3; }
require_loopback_ports() {
  local ports="$1" entry host port canonical previous
  local -a entries seen
  IFS=',' read -r -a entries <<< "$ports"
  [[ "${#entries[@]}" -eq 3 ]] || blocked 'VPS_LOOPBACK_PORTS must contain exactly three PostgreSQL, web, and API mappings.'
  for entry in "${entries[@]}"; do
    [[ "$entry" =~ ^127\.0\.0\.1:[0-9]+$ ]] || blocked 'VPS_LOOPBACK_PORTS must use exact 127.0.0.1 decimal mappings.'
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
  printf '%s\n' 'PHASE: setup complete'
}
phase_migrate() {
  local rc=0
  printf '%s\n' 'PHASE: migration start'
  : > "$raw_output"; chmod 600 "$raw_output"
  set +e
  if [[ -n "${VPS_MIGRATION_COMMAND:-}" ]]; then
    COMPOSE_PROJECT_NAME="$project" bash -c "$VPS_MIGRATION_COMMAND" </dev/null >"$raw_output" 2>&1
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
    "mode=$mode" "migration_rc=$rc" "redacted_sha256=$checksum" 'output_begin' \
    "$redacted" 'output_end' 'VPS_EVIDENCE_END' > "$evidence/summary"
  chmod 600 "$evidence/summary"
  printf '%s\n' 'PHASE: evidence complete'
  printf 'EVIDENCE: migration_rc=%s\n' "$rc"
  cat "$evidence/summary"
}
phase_cleanup() {
  require_safe_resource
  [[ -f "$marker" ]] || failed 'cleanup marker is missing; refusing rollback.'
  [[ "$(sed -n '1p' "$marker")" == deploylite-preview-owner && "$(sed -n '2p' "$marker")" == "$preview_id" && "$(sed -n '3p' "$marker")" == "$project" ]] || failed 'ownership marker drifted.'
  if ! command -v "$docker_bin" >/dev/null 2>&1; then failed 'validated Docker bin is unavailable.'; return 1; fi
  if [[ "${VPS_CLEANUP_FAIL:-0}" == 1 ]]; then failed 'injected cleanup failure.'; return 1; fi
  if [[ -n "${VPS_COMPOSE_COMMAND:-}" ]]; then
    COMPOSE_PROJECT_NAME="$project" bash -c "$VPS_COMPOSE_COMMAND down --volumes --remove-orphans" </dev/null || return 1
  elif [[ -x "${VPS_COMPOSE_WRAPPER:-}" ]]; then
    "$VPS_COMPOSE_WRAPPER" --project-name "$project" down --volumes --remove-orphans </dev/null || return 1
  fi
  local resource ids id
  for resource in container network volume image; do
    ids="$("$docker_bin" "$resource" ls -q --filter "label=com.docker.compose.project=$project")" || { failed "cannot inspect project $resource resources."; return 1; }
    if [[ -n "$ids" ]]; then
      if [[ "$resource" == image ]]; then
        while IFS= read -r id; do
          [[ -n "$id" ]] || continue
          "$docker_bin" image rm --force "$id" || { failed "cannot remove project image $id."; return 1; }
        done <<< "$ids"
      else
        failed "project $resource cleanup left resources: $ids"; return 1
      fi
    fi
  done
  for resource in container network volume image; do
    ids="$("$docker_bin" "$resource" ls -q --filter "label=com.docker.compose.project=$project")" || { failed "cannot verify project $resource resources."; return 1; }
    [[ -z "$ids" ]] || { failed "project $resource verification found resources: $ids"; return 1; }
  done
  rm -rf -- "$root"
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
  [[ -n "${VPS_COMPOSE_COMMAND:-}" || -x "${VPS_COMPOSE_WRAPPER:-}" ]] || failed 'isolated Compose command is required for preview.'
  if [[ -n "${VPS_COMPOSE_COMMAND:-}" ]]; then
    COMPOSE_PROJECT_NAME="$project" bash -c "$VPS_COMPOSE_COMMAND up -d postgres api web" </dev/null
  else
    "$VPS_COMPOSE_WRAPPER" --project-name "$project" up -d postgres api web </dev/null
  fi
  [[ -n "${VPS_HEALTH_COMMAND:-}" ]] || failed 'health command is required for preview.'
  timeout "${VPS_HEALTH_TIMEOUT:-30s}" bash -c "$VPS_HEALTH_COMMAND" </dev/null || exit 11
  VPS_KEEP_PREVIEW=1 export VPS_KEEP_PREVIEW
fi
printf 'PASS: %s\n' "$mode"
