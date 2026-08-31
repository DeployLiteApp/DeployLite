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
printf '%s\n' "${*: -1}" > "${CAPTURE:?}"
cat >/dev/null
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
printf '%s\n' 'VPS_EVIDENCE_BEGIN' 'preview_id=quote-check' 'project=deploylite-preview-quote-check' 'commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'tree=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' 'mode=migration-only' 'migration_rc=0' 'redacted_sha256=30688345ac750027b3b7ec622e3102df7c83996873701618f21e158690250095' 'output_begin' 'password=secret' 'output_end' 'VPS_EVIDENCE_END'
EOF
chmod +x "$work/bin/ssh"
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
base=(env -i PATH="$work/bin:$PATH" CAPTURE="$capture" VPS_HOST=preview.example.test VPS_KNOWN_HOSTS_FILE="$known_hosts" VPS_HOST_FINGERPRINT="$fingerprint" VPS_SOURCE_URL=https://example.test/deploylite.git)
local_evidence="$work/local-evidence"
output="$("${base[@]}" VPS_DB_PASSWORD=secret VPS_LOCAL_EVIDENCE_FILE="$local_evidence" VPS_MIGRATION_COMMAND="$command_text" VPS_COMPOSE_COMMAND="$compose_text" VPS_HEALTH_COMMAND="$health_text" bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id quote-check)"
[[ "$output" == *'READY:'* ]]
[[ -s "$local_evidence" && "$(file_mode "$local_evidence")" == 600 ]]
grep -Fq 'VPS_EVIDENCE_BEGIN' "$local_evidence"
if grep -Fq 'secret' "$local_evidence"; then exit 1; fi
if command -v sha256sum >/dev/null 2>&1; then
  checksum_command=(sha256sum)
else
  checksum_command=(shasum -a 256)
fi
checksum_file() { "${checksum_command[@]}" "$1" | awk '{print $1}'; }
expected_transcript="$work/expected-transcript"
printf '%s\n' 'VPS_EVIDENCE_BEGIN' 'preview_id=quote-check' 'project=deploylite-preview-quote-check' 'commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'tree=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' 'mode=migration-only' 'migration_rc=0' 'redacted_sha256=30688345ac750027b3b7ec622e3102df7c83996873701618f21e158690250095' 'output_begin' 'password=[REDACTED]' 'output_end' 'VPS_EVIDENCE_END' > "$expected_transcript"
success_checksum="$(checksum_file "$local_evidence")"
[[ "$success_checksum" == "$(checksum_file "$expected_transcript")" ]]
captured="$(<"$capture")"
[[ "$captured" == *"VPS_MIGRATION_COMMAND=$expected_migration_q"* ]]
[[ "$captured" == *"VPS_COMPOSE_COMMAND=$expected_compose_q"* ]]
[[ "$captured" == *"VPS_HEALTH_COMMAND=$expected_health_q"* ]]
if grep -Fq 'scp' <<<"$captured"; then exit 1; fi
cleanup_output="$("${base[@]}" VPS_COMPOSE_COMMAND="$compose_text" bash "$script" cleanup --id cleanup-cli)"
[[ "$cleanup_output" == *'READY: mode=cleanup id=cleanup-cli'* ]]
cleanup_captured="$(<"$capture")"
printf -v expected_cleanup_q '%q' "$compose_text"
[[ "$cleanup_captured" == *"VPS_COMPOSE_COMMAND=$expected_cleanup_q"* ]]
if grep -Fq 'VPS_SOURCE_URL=' <<<"$cleanup_captured" || grep -Fq 'VPS_COMMIT=' <<<"$cleanup_captured" ||
  grep -Fq 'VPS_TREE=' <<<"$cleanup_captured" || grep -Fq 'VPS_MIGRATION_COMMAND=' <<<"$cleanup_captured" ||
  grep -Fq 'VPS_HEALTH_COMMAND=' <<<"$cleanup_captured"; then exit 1; fi
set +e
for envelope_mode in absent empty incomplete; do
  evidence_file="$work/$envelope_mode-evidence"
  "${base[@]}" ENVELOPE_MODE="$envelope_mode" VPS_LOCAL_EVIDENCE_FILE="$evidence_file" VPS_DB_PASSWORD=secret VPS_FAILURE_EXCERPT_BYTES=32 bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id quote-check >"$work/$envelope_mode-output" 2>&1
  mode_status=$?
  set -e
  [[ "$mode_status" -ne 0 && -s "$evidence_file" && "$(file_mode "$evidence_file")" == 600 ]]
  if grep -Fq 'secret' "$evidence_file" || grep -Fq 'secret' "$work/$envelope_mode-output"; then exit 1; fi
  grep -Fq 'EVIDENCE EXCERPT:' "$work/$envelope_mode-output"
  set +e
done
"${base[@]}" ENVELOPE_MODE=absent SSH_STATUS=255 VPS_LOCAL_EVIDENCE_FILE="$work/nonzero-evidence" VPS_DB_PASSWORD=secret bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id quote-check >"$work/nonzero-output" 2>&1
nonzero_status=$?
set -e
[[ "$nonzero_status" -eq 255 && -s "$work/nonzero-evidence" ]]
printf '%s\n' 'VPS command forwarding test passed.'
