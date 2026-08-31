#!/usr/bin/env bash
set -Eeuo pipefail
root="$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
script="$root/scripts/vps-preview-remote.sh"; work="$(mktemp -d)"; trap 'rm -rf -- "$work"' EXIT
source_dir="$work/source"; git clone -q --no-local "$root" "$source_dir"
commit="$(git -C "$source_dir" rev-parse HEAD)"; tree="$(git -C "$source_dir" rev-parse 'HEAD^{tree}')"
preview_id="test-$RANDOM"
run_case() { local name="$1" expected="$2"; shift 2; local output status; set +e; output=$("$@" 2>&1); status=$?; set -e; [[ "$status" -eq "$expected" ]] || { printf '%s: expected %s got %s\n%s\n' "$name" "$expected" "$status" "$output" >&2; exit 1; }; }
envbase=(env -i PATH="$PATH" VPS_REMOTE_ROOT="/var/tmp/deploylite-preview/$preview_id" VPS_SOURCE_URL="$source_dir" VPS_COMMIT="$commit" VPS_TREE="$tree" VPS_MIGRATION_COMMAND='printf "password=secret\n"' VPS_KEEP_PREVIEW=0)
output="$("${envbase[@]}" bash "$script" migration-only "$preview_id")"; [[ "$output" == *'EVIDENCE: migration_rc=0'* && "$output" == *'PASS: migration-only'* ]]
[[ ! -e "/var/tmp/deploylite-preview/$preview_id" ]]
set +e; "${envbase[@]}" VPS_MIGRATION_COMMAND='printf "token=secret\n"; exit 7' bash "$script" migration-only test-two >"$work/fail" 2>&1; status=$?; set -e
[[ "$status" -eq 10 && ! -e "/var/tmp/deploylite-preview/$preview_id" ]]
grep -Fq 'EVIDENCE: migration_rc=7' "$work/fail"
run_case canonical 3 "${envbase[@]}" VPS_REMOTE_ROOT="/var/tmp/deploylite-preview/canonical" bash "$script" migration-only canonical
printf '%s\n' 'VPS remote phase tests passed.'
