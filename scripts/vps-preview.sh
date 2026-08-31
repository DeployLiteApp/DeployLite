#!/usr/bin/env bash
set -Eeuo pipefail
set +x

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
git_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || { printf 'BLOCKED: run from a checkout.\n' >&2; exit 3; }
git_root="$(cd -- "$git_root" && pwd -P)" || { printf 'BLOCKED: run from a checkout.\n' >&2; exit 3; }
[[ "$script_dir/vps-preview.sh" == "$git_root/scripts/vps-preview.sh" ]] || { printf 'BLOCKED: script must remain in scripts/.\n' >&2; exit 3; }
# shellcheck source=scripts/vps-preview-lib.sh
source "$script_dir/vps-preview-lib.sh"

usage() { printf '%s\n' 'Usage: vps-preview.sh migration-only|preview --source CHECKOUT --commit SHA --tree TREE --id ID | cleanup --id ID'; }
blocked() { printf 'BLOCKED: %s\n' "$*" >&2; exit 3; }
fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }

mode="${1:-}"; [[ "$mode" == migration-only || "$mode" == preview || "$mode" == cleanup ]] || { usage >&2; exit 3; }; shift
source_dir=""; expected_commit=""; expected_tree=""; preview_id=""
remote_host="${VPS_HOST:-}"; remote_user="${VPS_USER:-deploylite}"; remote_root="${VPS_REMOTE_ROOT:-}"
while (($#)); do
  case "$1" in
    --source) source_dir="${2:-}"; shift 2 ;;
    --commit) expected_commit="${2:-}"; shift 2 ;;
    --tree) expected_tree="${2:-}"; shift 2 ;;
    --id) preview_id="${2:-}"; shift 2 ;;
    --host) remote_host="${2:-}"; shift 2 ;;
    --user) remote_user="${2:-}"; shift 2 ;;
    --remote-root) remote_root="${2:-}"; shift 2 ;;
    *) blocked "unknown argument: $1" ;;
  esac
done
[[ -n "$preview_id" ]] || blocked 'preview ID is required.'
if [[ "$mode" != cleanup ]]; then
  [[ -n "$source_dir" && -n "$expected_commit" && -n "$expected_tree" ]] || blocked 'source, commit, tree, and ID are required.'
  [[ "$expected_commit" =~ ^[0-9a-f]{40}$ && "$expected_tree" =~ ^[0-9a-f]{40}$ ]] || blocked 'commit and tree must be full hexadecimal object IDs.'
fi
vps_require_safe_id "$preview_id"
remote_root="${remote_root:-/var/tmp/deploylite-preview/$preview_id}"
[[ "$remote_root" =~ ^/var/tmp/deploylite-preview/[a-z0-9][a-z0-9-]{2,31}$ ]] || blocked 'remote root must be an isolated var/tmp preview directory.'
[[ "$remote_root" != */canonical* && "$remote_root" != */production* ]] || blocked 'canonical and production paths are forbidden.'
[[ -n "$remote_host" ]] || blocked 'VPS_HOST or --host is required.'
[[ "$remote_host" != *:* && "$remote_host" != */* ]] || blocked 'host must be a hostname, not a URL or path.'
[[ "$remote_host" != production* && "$remote_host" != canonical* && "$remote_host" != deploylite* ]] || blocked 'canonical and production hosts are forbidden.'
[[ "$remote_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || blocked 'invalid remote user.'
if [[ "$mode" != cleanup ]]; then
  vps_source_provenance "$source_dir" "$expected_commit" "$expected_tree" >/dev/null || exit $?
  source_url="${VPS_SOURCE_URL:-$(git -C "$source_dir" remote get-url origin)}"
fi
vps_require_isolated_resources "project=$preview_id" "root=$remote_root" 'ports=127.0.0.1:55433,127.0.0.1:58080,127.0.0.1:58443'

[[ -n "${VPS_KNOWN_HOSTS_FILE:-}" && -r "$VPS_KNOWN_HOSTS_FILE" ]] || blocked 'VPS_KNOWN_HOSTS_FILE is required for strict host verification.'
[[ -s "$VPS_KNOWN_HOSTS_FILE" ]] || blocked 'VPS_KNOWN_HOSTS_FILE must not be empty.'
if [[ -n "${SSHPASS:-}" ]]; then
  command -v sshpass >/dev/null 2>&1 || blocked 'SSHPASS requires sshpass.'
  ssh_cmd=(sshpass -e ssh)
else
  ssh_cmd=(ssh)
fi
command -v "${ssh_cmd[0]}" >/dev/null 2>&1 || blocked 'SSH client is required.'
[[ "${VPS_HOST_FINGERPRINT:-}" =~ ^SHA256:[A-Za-z0-9+/=]+$ ]] || blocked 'VPS_HOST_FINGERPRINT must be a SHA256 fingerprint.'
command -v ssh-keygen >/dev/null 2>&1 || blocked 'ssh-keygen is required.'
[[ "${VPS_HOST_FINGERPRINT:-}" =~ ^SHA256:[A-Za-z0-9+/=]+$ ]] || blocked 'VPS_HOST_FINGERPRINT must be a SHA256 fingerprint.'
host_keys="$(ssh-keygen -F "$remote_host" -f "$VPS_KNOWN_HOSTS_FILE" 2>/dev/null | awk -v host="$remote_host" '$1 == host { print $2 " " $3 }')"
[[ -n "$host_keys" ]] || blocked 'known_hosts has no exact entry for VPS_HOST.'
while IFS= read -r host_key; do
  fingerprint="$(printf '%s\n' "$host_key" | ssh-keygen -lf - 2>/dev/null | awk '{print $2}')"
  [[ "$fingerprint" == "$VPS_HOST_FINGERPRINT" ]] || blocked 'VPS_HOST_FINGERPRINT does not match the exact VPS_HOST entry.'
done <<< "$host_keys"
ssh_opts=(-o ConnectTimeout=10 -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$VPS_KNOWN_HOSTS_FILE")
if [[ -n "${SSHPASS:-}" ]]; then
  ssh_opts+=(-o BatchMode=no)
else
  ssh_opts+=(-o BatchMode=yes)
fi

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/vps-preview.XXXXXX")"
cleanup() { rm -rf -- "$tmpdir"; }
trap cleanup EXIT
status=0
trap 'status=$?; printf "FAILED: interrupted (status %s)\n" "$status" >&2; exit "$status"' INT TERM

printf -v root_q '%q' "$remote_root"
remote_command="VPS_REMOTE_ROOT=$root_q"
if [[ "$mode" != cleanup ]]; then
  printf -v source_q '%q' "$source_url"
  printf -v commit_q '%q' "$expected_commit"
  printf -v tree_q '%q' "$expected_tree"
  remote_command+=" VPS_SOURCE_URL=$source_q VPS_COMMIT=$commit_q VPS_TREE=$tree_q VPS_LOOPBACK_PORTS=127.0.0.1:55433,127.0.0.1:58080,127.0.0.1:58443"
  for variable in VPS_MIGRATION_COMMAND VPS_COMPOSE_COMMAND VPS_HEALTH_COMMAND; do
    printf -v value_q '%q' "${!variable:-}"
    remote_command+=" $variable=$value_q"
  done
else
  printf -v compose_q '%q' "${VPS_COMPOSE_COMMAND:-}"
  remote_command+=" VPS_COMPOSE_COMMAND=$compose_q"
fi
printf -v mode_q '%q' "$mode"
printf -v id_q '%q' "$preview_id"
remote_command+=" bash -s $mode_q $id_q"
captured="$tmpdir/redacted-evidence"
set +e
"${ssh_cmd[@]}" "${ssh_opts[@]}" "$remote_user@$remote_host" "$remote_command" < "$script_dir/vps-preview-remote.sh" 2>&1 |
  vps_redact | tee "$captured" >/dev/null
pipeline_status=("${PIPESTATUS[@]}")
set -e
ssh_status="${pipeline_status[0]}"
if [[ "$mode" != cleanup ]]; then
  [[ -s "$captured" ]] || fail 'SSH returned no redacted output.'
  evidence_payload="$tmpdir/evidence-payload"
  awk '/^VPS_EVIDENCE_BEGIN$/{inside=1; next} /^VPS_EVIDENCE_END$/{inside=0; found=1; next} inside {print} END {if (!found) exit 1}' \
    "$captured" > "$evidence_payload" || fail 'expected VPS evidence envelope is absent.'
  [[ -s "$evidence_payload" ]] || fail 'expected VPS evidence envelope is empty.'
  grep -Fq 'preview_id=' "$evidence_payload" || fail 'VPS evidence envelope is incomplete.'
  grep -Fq 'redacted_sha256=' "$evidence_payload" || fail 'VPS evidence checksum is missing.'
fi
if [[ "$mode" != cleanup && -n "${VPS_LOCAL_EVIDENCE_FILE:-}" ]]; then
  local_evidence_file="$VPS_LOCAL_EVIDENCE_FILE"
  [[ "$local_evidence_file" == /* && "$local_evidence_file" != */ && "$local_evidence_file" != *$'\n'* ]] ||
    blocked 'VPS_LOCAL_EVIDENCE_FILE must be an absolute file path.'
  local_evidence_dir="${local_evidence_file%/*}"; [[ -d "$local_evidence_dir" ]] || blocked 'VPS_LOCAL_EVIDENCE_FILE directory must exist.'
  local_evidence_tmp="$(mktemp "$local_evidence_dir/.vps-evidence.XXXXXX")"
  chmod 600 "$local_evidence_tmp"
  if ! cp -- "$captured" "$local_evidence_tmp" || ! mv -f -- "$local_evidence_tmp" "$local_evidence_file"; then
    rm -f -- "$local_evidence_tmp"
    fail 'cannot persist local VPS evidence.'
  fi
  chmod 600 "$local_evidence_file"
fi
[[ "$ssh_status" -eq 0 || "$ssh_status" -eq 10 ]] || exit "$ssh_status"

printf 'READY: mode=%s id=%s commit=%s tree=%s\n' "$mode" "$preview_id" "$expected_commit" "$expected_tree"
printf 'SSH: strict host verification enabled; fingerprint supplied out-of-band.\n'
printf 'SSH options: %s\n' "${ssh_opts[*]}"
printf 'EXECUTION: remote phases are delegated to scripts/vps-preview-remote.sh; no credentials are printed.\n'
