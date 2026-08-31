#!/usr/bin/env bash
set -Eeuo pipefail
set +x

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root_dir="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || { printf 'BLOCKED: run from a checkout.\n' >&2; exit 3; }
[[ "$script_dir/vps-preview.sh" == "$root_dir/scripts/vps-preview.sh" ]] || { printf 'BLOCKED: script must remain in scripts/.\n' >&2; exit 3; }
# shellcheck source=scripts/vps-preview-lib.sh
source "$script_dir/vps-preview-lib.sh"

usage() { printf '%s\n' 'Usage: vps-preview.sh migration-only|preview --source CHECKOUT --commit SHA --tree TREE --id ID'; }
blocked() { printf 'BLOCKED: %s\n' "$*" >&2; exit 3; }
fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }

mode="${1:-}"; [[ "$mode" == migration-only || "$mode" == preview ]] || { usage >&2; exit 3; }; shift
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
[[ -n "$source_dir" && -n "$expected_commit" && -n "$expected_tree" && -n "$preview_id" ]] || blocked 'source, commit, tree, and ID are required.'
[[ "$expected_commit" =~ ^[0-9a-f]{40}$ && "$expected_tree" =~ ^[0-9a-f]{40}$ ]] || blocked 'commit and tree must be full hexadecimal object IDs.'
vps_require_safe_id "$preview_id"
remote_root="${remote_root:-/var/tmp/deploylite-preview/$preview_id}"
[[ "$remote_root" =~ ^/var/tmp/deploylite-preview/[a-z0-9][a-z0-9-]{2,31}$ ]] || blocked 'remote root must be an isolated var/tmp preview directory.'
[[ "$remote_root" != */canonical* && "$remote_root" != */production* ]] || blocked 'canonical and production paths are forbidden.'
[[ -n "$remote_host" ]] || blocked 'VPS_HOST or --host is required.'
[[ "$remote_host" != *:* && "$remote_host" != */* ]] || blocked 'host must be a hostname, not a URL or path.'
[[ "$remote_host" != production* && "$remote_host" != canonical* && "$remote_host" != deploylite* ]] || blocked 'canonical and production hosts are forbidden.'
[[ "$remote_user" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || blocked 'invalid remote user.'
vps_source_provenance "$source_dir" "$expected_commit" "$expected_tree" >/dev/null || exit $?
vps_require_isolated_resources "project=$preview_id" "root=$remote_root" 'ports=127.0.0.1:55433,127.0.0.1:58080,127.0.0.1:58443'

[[ -n "${VPS_KNOWN_HOSTS_FILE:-}" && -r "$VPS_KNOWN_HOSTS_FILE" ]] || blocked 'VPS_KNOWN_HOSTS_FILE is required for strict host verification.'
if [[ -n "${SSHPASS:-}" ]]; then
  command -v sshpass >/dev/null 2>&1 || blocked 'SSHPASS requires sshpass.'
  ssh_cmd=(sshpass -e ssh)
  scp_cmd=(sshpass -e scp)
else
  ssh_cmd=(ssh)
  scp_cmd=(scp)
fi
command -v "${ssh_cmd[0]}" >/dev/null 2>&1 || blocked 'SSH client is required.'
command -v "${scp_cmd[0]}" >/dev/null 2>&1 || blocked 'SCP client is required.'
[[ -n "${VPS_HOST_FINGERPRINT:-}" ]] || blocked 'VPS_HOST_FINGERPRINT is required.'
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$VPS_KNOWN_HOSTS_FILE")

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/vps-preview.XXXXXX")"
cleanup() { rm -rf -- "$tmpdir"; }
trap cleanup EXIT
status=0
trap 'status=$?; printf "FAILED: interrupted (status %s)\n" "$status" >&2; exit "$status"' INT TERM

printf 'READY: mode=%s id=%s commit=%s tree=%s\n' "$mode" "$preview_id" "$expected_commit" "$expected_tree"
printf 'SSH: strict host verification enabled; fingerprint supplied out-of-band.\n'
printf 'SSH options: %s\n' "${ssh_opts[*]}"
printf 'EXECUTION: remote phases are delegated to scripts/vps-preview-remote.sh; no credentials are printed.\n'
