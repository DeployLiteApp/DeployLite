#!/usr/bin/env bash
set -Eeuo pipefail
root="$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
script="$root/scripts/vps-preview.sh"; work="$(mktemp -d)"; trap 'rm -rf -- "$work"' EXIT
source_repo="$work/source"; git clone -q --no-local "$root" "$source_repo"
commit="$(git -C "$source_repo" rev-parse HEAD)"; tree="$(git -C "$source_repo" rev-parse 'HEAD^{tree}')"
ssh_keygen_out="$work/host-key"; ssh-keygen -q -t ed25519 -N '' -f "$ssh_keygen_out"
known_hosts="$work/known_hosts"; printf 'preview.example.test %s\n' "$(<"$ssh_keygen_out.pub")" > "$known_hosts"
fingerprint="$(ssh-keygen -lf "$ssh_keygen_out.pub" | awk '{print $2}')"; capture="$work/ssh-command"
mkdir -p "$work/bin"
cat > "$work/bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$@" > "${ARGV_CAPTURE:?}"
printf '%s\n' "${*: -1}" > "${CAPTURE:?}"
cat >/dev/null
[[ -z "${VPS_SSH_IDENTITY_FILE:-}" ]] || printf 'identity=%s\n' "$VPS_SSH_IDENTITY_FILE"
if [[ "${ENVELOPE_MODE:-valid}" == absent ]]; then
  printf '%s\n' 'password=secret' 'Authorization: Bearer secret'
  exit "${SSH_STATUS:-0}"
elif [[ "${ENVELOPE_MODE:-valid}" == empty ]]; then
  printf '%s\n' 'VPS_EVIDENCE_BEGIN' 'VPS_EVIDENCE_END'
  exit "${SSH_STATUS:-0}"
elif [[ "${ENVELOPE_MODE:-valid}" == incomplete ]]; then
  printf '%s\n' 'VPS_EVIDENCE_BEGIN' 'preview_id=quote-check' 'output_begin' 'password=secret' 'output_end' 'VPS_EVIDENCE_END'
  exit "${SSH_STATUS:-0}"
fi
printf '%s\n' 'PHASE: setup complete' 'PHASE: migration start' 'PHASE: migration complete status=0' 'PHASE: evidence start' 'PHASE: evidence complete' 'VPS_EVIDENCE_BEGIN' 'preview_id=quote-check' 'project=deploylite-preview-quote-check' 'commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'tree=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' 'mode=migration-only' "migration_rc=${MIGRATION_RC:-0}" 'redacted_sha256=30688345ac750027b3b7ec622e3102df7c83996873701618f21e158690250095' 'output_begin' 'password=secret' 'output_end' 'VPS_EVIDENCE_END' 'PHASE: cleanup start' 'PHASE: cleanup complete status=0'
exit "${SSH_STATUS:-0}"
EOF
chmod +x "$work/bin/ssh"
cat > "$work/bin/sshpass" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == -e ]] || exit 2
shift
exec ssh "$@"
EOF
chmod +x "$work/bin/sshpass"
file_mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}
command_text='printf "migration value with spaces and \"quotes\"\\n"'
compose_text='printf "compose value with spaces and \"quotes\"\\n"'
health_text='printf "health value with spaces and \"quotes\"\\n"'
printf -v expected_migration_q '%q' "$command_text"
printf -v expected_compose_q '%q' "$compose_text"
printf -v expected_health_q '%q' "$health_text"
argv_capture="$work/ssh-argv"
base=(env -i PATH="$work/bin:$PATH" CAPTURE="$capture" ARGV_CAPTURE="$argv_capture" VPS_HOST=preview.example.test VPS_KNOWN_HOSTS_FILE="$known_hosts" VPS_HOST_FINGERPRINT="$fingerprint" VPS_SOURCE_URL=https://example.test/deploylite.git)
local_evidence="$work/local-evidence"
output="$("${base[@]}" VPS_DB_PASSWORD=secret VPS_LOCAL_EVIDENCE_FILE="$local_evidence" VPS_MIGRATION_COMMAND="$command_text" VPS_COMPOSE_COMMAND="$compose_text" VPS_HEALTH_COMMAND="$health_text" bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id quote-check)"
[[ "$output" == *'READY:'* ]]
[[ -s "$local_evidence" && "$(file_mode "$local_evidence")" == 600 ]]
grep -Fq 'VPS_EVIDENCE_BEGIN' "$local_evidence"
if grep -Fq 'secret' "$local_evidence"; then exit 1; fi
expected_transcript="$work/expected-transcript"
printf '%s\n' 'PHASE: setup complete' 'PHASE: migration start' 'PHASE: migration complete status=0' 'PHASE: evidence start' 'PHASE: evidence complete' 'VPS_EVIDENCE_BEGIN' 'preview_id=quote-check' 'project=deploylite-preview-quote-check' 'commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'tree=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' 'mode=migration-only' 'migration_rc=0' 'redacted_sha256=30688345ac750027b3b7ec622e3102df7c83996873701618f21e158690250095' 'output_begin' 'password=[REDACTED]' 'output_end' 'VPS_EVIDENCE_END' 'PHASE: cleanup start' 'PHASE: cleanup complete status=0' > "$expected_transcript"
cmp -s "$local_evidence" "$expected_transcript"
captured="$(<"$capture")"
[[ "$captured" == *"VPS_MIGRATION_COMMAND=$expected_migration_q"* ]]
[[ "$captured" == *"VPS_COMPOSE_COMMAND=$expected_compose_q"* ]]
[[ "$captured" == *"VPS_HEALTH_COMMAND=$expected_health_q"* ]]
if grep -Eq 'VPS_HEALTH_(TIMEOUT|INTERVAL)=' <<<"$captured"; then exit 1; fi
if grep -Fq 'scp' <<<"$captured"; then exit 1; fi
health_timeout=180
health_interval=5
explicit_output="$("${base[@]}" VPS_HEALTH_TIMEOUT="$health_timeout" VPS_HEALTH_INTERVAL="$health_interval" bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id explicit-health)"
[[ "$explicit_output" == *'READY:'* ]]
captured="$(<"$capture")"
printf -v expected_health_timeout_q '%q' "$health_timeout"
printf -v expected_health_interval_q '%q' "$health_interval"
[[ "$captured" == *"VPS_HEALTH_TIMEOUT=$expected_health_timeout_q"* ]]
[[ "$captured" == *"VPS_HEALTH_INTERVAL=$expected_health_interval_q"* ]]
assert_ssh_options() {
  local batch_mode="$1"
  local other_batch_mode=yes
  [[ "$batch_mode" == yes ]] && other_batch_mode=no
  count_arg() { awk -v expected="$1" '$0 == expected { count++ } END { print count + 0 }' "$argv_capture"; }
  [[ "$(count_arg '-o')" -eq 6 ]]
  [[ "$(count_arg 'ConnectTimeout=10')" -eq 1 ]]
  [[ "$(count_arg 'ServerAliveInterval=15')" -eq 1 ]]
  [[ "$(count_arg 'ServerAliveCountMax=4')" -eq 1 ]]
  [[ "$(count_arg 'StrictHostKeyChecking=yes')" -eq 1 ]]
  [[ "$(count_arg "UserKnownHostsFile=$known_hosts")" -eq 1 ]]
  [[ "$(count_arg "BatchMode=$batch_mode")" -eq 1 ]]
  ! grep -Eq "StrictHostKeyChecking=(no|accept-new)|UserKnownHostsFile=/dev/null|ServerAliveInterval=0|BatchMode=$other_batch_mode" "$argv_capture"
}
assert_ssh_options yes
identity_file="$work/id_ed25519"
ssh-keygen -q -t ed25519 -N '' -f "$identity_file"
chmod 600 "$identity_file"
identity_output="$("${base[@]}" VPS_SSH_IDENTITY_FILE="$identity_file" VPS_LOCAL_EVIDENCE_FILE="$work/identity-evidence" bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id identity-check 2>"$work/identity-error")"
[[ "$identity_output" == *'SSH options: '*'-i [IDENTITY_FILE] -o IdentitiesOnly=yes'* ]]
if grep -Fq "$identity_file" "$work/identity-error" || grep -Fq "$identity_file" <<<"$identity_output"; then exit 1; fi
if grep -Fq "$identity_file" "$work/identity-evidence"; then exit 1; fi
grep -Fxq -- '-i' "$argv_capture"
grep -Fxq -- "$identity_file" "$argv_capture"
grep -Fxq -- 'IdentitiesOnly=yes' "$argv_capture"
if grep -Fq "$identity_file" "$capture"; then exit 1; fi
EXPECTED_SSH_OPTION_COUNT=7 assert_ssh_options yes
relative_identity='relative-id'
printf '%s\n' 'not-a-key' > "$work/$relative_identity"
chmod 600 "$work/$relative_identity"
set +e
"${base[@]}" VPS_SSH_IDENTITY_FILE="$relative_identity" bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id relative-id >"$work/relative-output" 2>&1
identity_status=$?
set -e
[[ "$identity_status" -eq 3 ]] && ! grep -Fq "$relative_identity" "$work/relative-output"
ln -s "$identity_file" "$work/id-symlink"
set +e
"${base[@]}" VPS_SSH_IDENTITY_FILE="$work/id-symlink" bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id symlink-id >"$work/symlink-output" 2>&1
identity_status=$?
set -e
[[ "$identity_status" -eq 3 ]] && ! grep -Fq "$work/id-symlink" "$work/symlink-output"
chmod 640 "$identity_file"
set +e
"${base[@]}" VPS_SSH_IDENTITY_FILE="$identity_file" bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id unsafe-id >"$work/unsafe-output" 2>&1
identity_status=$?
set -e
[[ "$identity_status" -eq 3 ]] && ! grep -Fq "$identity_file" "$work/unsafe-output"
chmod 600 "$identity_file"
set +e
"${base[@]}" SSHPASS=secret VPS_SSH_IDENTITY_FILE="$identity_file" bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id password-identity >"$work/conflict-output" 2>&1
identity_status=$?
set -e
[[ "$identity_status" -eq 3 ]] && ! grep -Fq "$identity_file" "$work/conflict-output"
newline_identity="$work/id"$'\n''ed25519'
printf '%s\n' 'not-a-key' > "$newline_identity"
chmod 600 "$newline_identity"
set +e
"${base[@]}" VPS_SSH_IDENTITY_FILE="$newline_identity" bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id newline-id >"$work/newline-output" 2>&1
identity_status=$?
set -e
[[ "$identity_status" -eq 3 ]] && ! grep -Fq 'ed25519' "$work/newline-output"
password_output="$("${base[@]}" SSHPASS=secret VPS_LOCAL_EVIDENCE_FILE="$work/password-evidence" bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id password-check)"
[[ "$password_output" == *'READY:'* ]]
assert_ssh_options no
cleanup_output="$("${base[@]}" VPS_COMPOSE_COMMAND="$compose_text" bash "$script" cleanup --id cleanup-cli)"
[[ "$cleanup_output" == *'READY: mode=cleanup id=cleanup-cli'* ]]
cleanup_captured="$(<"$capture")"
printf -v expected_cleanup_q '%q' "$compose_text"
[[ "$cleanup_captured" == *"VPS_COMPOSE_COMMAND=$expected_cleanup_q"* ]]
if grep -Fq 'VPS_SOURCE_URL=' <<<"$cleanup_captured" || grep -Fq 'VPS_COMMIT=' <<<"$cleanup_captured" ||
  grep -Fq 'VPS_TREE=' <<<"$cleanup_captured" || grep -Fq 'VPS_MIGRATION_COMMAND=' <<<"$cleanup_captured" ||
  grep -Fq 'VPS_HEALTH_COMMAND=' <<<"$cleanup_captured" || grep -Fq 'VPS_HEALTH_TIMEOUT=' <<<"$cleanup_captured" ||
  grep -Fq 'VPS_HEALTH_INTERVAL=' <<<"$cleanup_captured"; then exit 1; fi
set +e
for envelope_mode in absent empty incomplete; do
  evidence_file="$work/$envelope_mode-evidence"
  "${base[@]}" ENVELOPE_MODE="$envelope_mode" VPS_LOCAL_EVIDENCE_FILE="$evidence_file" VPS_DB_PASSWORD=secret VPS_FAILURE_EXCERPT_BYTES=32 bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id quote-check >"$work/$envelope_mode-output" 2>&1
  mode_status=$?
  set -e
  [[ "$mode_status" -ne 0 && -s "$evidence_file" && "$(file_mode "$evidence_file")" == 600 ]]
  if grep -Fq 'READY:' "$work/$envelope_mode-output"; then exit 1; fi
  if grep -Fq 'secret' "$evidence_file" || grep -Fq 'secret' "$work/$envelope_mode-output"; then exit 1; fi
  grep -Fq 'EVIDENCE EXCERPT:' "$work/$envelope_mode-output"
  set +e
done
"${base[@]}" ENVELOPE_MODE=absent SSH_STATUS=255 VPS_LOCAL_EVIDENCE_FILE="$work/nonzero-evidence" VPS_DB_PASSWORD=secret bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id quote-check >"$work/nonzero-output" 2>&1
nonzero_status=$?
set -e
[[ "$nonzero_status" -eq 255 && -s "$work/nonzero-evidence" ]]
if grep -Fq 'READY:' "$work/nonzero-output"; then exit 1; fi
valid_failure_evidence="$work/valid-failure-evidence"
set +e
"${base[@]}" ENVELOPE_MODE=valid SSH_STATUS=10 MIGRATION_RC=7 VPS_LOCAL_EVIDENCE_FILE="$valid_failure_evidence" VPS_DB_PASSWORD=secret bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id quote-check >"$work/valid-failure-output" 2>&1
valid_failure_status=$?
set -e
[[ "$valid_failure_status" -eq 10 && -s "$valid_failure_evidence" && "$(file_mode "$valid_failure_evidence")" == 600 ]]
grep -Fq 'VPS_EVIDENCE_BEGIN' "$valid_failure_evidence"
grep -Fq 'migration_rc=7' "$valid_failure_evidence"
if grep -Fq 'READY:' "$work/valid-failure-output"; then exit 1; fi
printf '%s\n' 'VPS command forwarding test passed.'
