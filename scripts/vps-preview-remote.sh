#!/usr/bin/env bash
set -Eeuo pipefail
set +x

mode="${1:-}"; [[ "$mode" == migration-only || "$mode" == preview ]] || { printf 'BLOCKED: invalid mode.\n' >&2; exit 3; }; shift
preview_id="${1:-}"; [[ "$preview_id" =~ ^[a-z0-9][a-z0-9-]{2,31}$ ]] || { printf 'BLOCKED: invalid preview ID.\n' >&2; exit 3; }; shift
root="${VPS_REMOTE_ROOT:-/var/tmp/deploylite-preview/$preview_id}"
marker="$root/.deploylite-preview-owner"
project="deploylite-preview-$preview_id"
source_dir="$root/source"
evidence="$root/evidence"
raw_output="$evidence/migration.raw"
raw_rc="$evidence/migration.rc"
git_bin="${VPS_GIT_BIN:-git}"

blocked() { printf 'BLOCKED: %s\n' "$*" >&2; exit 3; }
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
}
phase_migrate() {
  local rc=0
  : > "$raw_output"; chmod 600 "$raw_output"
  set +e
  if [[ -n "${VPS_MIGRATION_COMMAND:-}" ]]; then
    bash -c "$VPS_MIGRATION_COMMAND" >"$raw_output" 2>&1
  else
    failed 'VPS_MIGRATION_COMMAND is required.' >"$raw_output" 2>&1
  fi
  rc=$?
  set -e
  printf '%s\n' "$rc" > "$raw_rc"; chmod 600 "$raw_rc"
  return "$rc"
}
phase_evidence() {
  local rc raw
  rc="$(<"$raw_rc")"; raw="$(<"$raw_output")"
  [[ "$rc" =~ ^[0-9]+$ ]] || failed 'migration exit code evidence is invalid.'
  [[ -s "$raw_output" ]] || failed 'migration evidence is missing.'
  raw="${raw//"${VPS_DB_PASSWORD:-}"/[REDACTED]}"
  raw="${raw//"${VPS_API_TOKEN:-}"/[REDACTED]}"
  raw="$(printf '%s' "$raw" | sed -E -e 's/(Authorization:[[:space:]]*(Bearer|Basic)[[:space:]]+)[^[:space:]]+/\1[REDACTED]/Ig' -e 's/((PASSWORD|TOKEN|SECRET|API_KEY|DATABASE_URL)[[:space:]]*=[[:space:]]*)[^[:space:]]+/\1[REDACTED]/Ig' -e 's#(postgres(ql)?://[^:/@]+:)[^@[:space:]]+@#\1[REDACTED]@#Ig')"
  raw="$(printf '%s' "$raw" | head -c "${VPS_MAX_EVIDENCE_BYTES:-65536}")"
  printf 'id=%s\nproject=%s\ncommit=%s\ntree=%s\nmode=%s\nmigration_rc=%s\noutput=%s\n' \
    "$preview_id" "$project" "${VPS_COMMIT:-}" "${VPS_TREE:-}" "$mode" "$rc" "$raw" > "$evidence/summary"
  chmod 600 "$evidence/summary"
  printf 'EVIDENCE: migration_rc=%s\n' "$rc"
}
phase_cleanup() {
  [[ -f "$marker" ]] || failed 'cleanup marker is missing; refusing rollback.'
  [[ "$(sed -n '1p' "$marker")" == deploylite-preview-owner && "$(sed -n '2p' "$marker")" == "$preview_id" && "$(sed -n '3p' "$marker")" == "$project" ]] || failed 'ownership marker drifted.'
  if [[ "${VPS_CLEANUP_FAIL:-0}" == 1 ]]; then failed 'injected cleanup failure.'; return 1; fi
  if [[ -n "${VPS_COMPOSE_COMMAND:-}" ]]; then
    COMPOSE_PROJECT_NAME="$project" bash -c "$VPS_COMPOSE_COMMAND down --remove-orphans" || return 1
  elif [[ -x "${VPS_COMPOSE_WRAPPER:-}" ]]; then
    "$VPS_COMPOSE_WRAPPER" --project-name "$project" down --remove-orphans || return 1
  fi
  rm -rf -- "$root"
}
cleanup_on_exit() {
  local primary=$?
  if [[ "$mode" == migration-only || "$primary" -ne 0 || "${VPS_KEEP_PREVIEW:-0}" != 1 ]]; then
    set +e; phase_cleanup; cleanup_rc=$?; set -e
    [[ "$primary" -ne 0 ]] && exit "$primary"
    [[ "${cleanup_rc:-0}" -eq 0 ]] || exit 2
  fi
  exit "$primary"
}
trap cleanup_on_exit EXIT
trap 'exit 130' INT
phase_setup
phase_migrate || migration_rc=$?
phase_evidence
if [[ "${migration_rc:-0}" -ne 0 ]]; then exit 10; fi
if [[ "$mode" == preview ]]; then
  preview_ports="${VPS_LOOPBACK_PORTS:-127.0.0.1:55433,127.0.0.1:58080,127.0.0.1:58443}"
  [[ "$preview_ports" != *:80* && "$preview_ports" != *:443* && "$preview_ports" == 127.0.0.1:* ]] || blocked 'preview services must use loopback high ports.'
  [[ -n "${VPS_COMPOSE_COMMAND:-}" || -x "${VPS_COMPOSE_WRAPPER:-}" ]] || failed 'isolated Compose command is required for preview.'
  if [[ -n "${VPS_COMPOSE_COMMAND:-}" ]]; then
    COMPOSE_PROJECT_NAME="$project" bash -c "$VPS_COMPOSE_COMMAND up -d postgres api web"
  else
    "$VPS_COMPOSE_WRAPPER" --project-name "$project" up -d postgres api web
  fi
  [[ -n "${VPS_HEALTH_COMMAND:-}" ]] || failed 'health command is required for preview.'
  timeout "${VPS_HEALTH_TIMEOUT:-30s}" bash -c "$VPS_HEALTH_COMMAND" || exit 11
  VPS_KEEP_PREVIEW=1 export VPS_KEEP_PREVIEW
fi
printf 'PASS: %s\n' "$mode"
