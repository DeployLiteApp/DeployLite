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
if [[ "${NO_EVIDENCE:-0}" == 1 ]]; then exit "${SSH_STATUS:-0}"; fi
printf '%s\n' 'VPS_EVIDENCE_BEGIN' 'preview_id=quote-check' 'project=deploylite-preview-quote-check' 'commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'tree=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' 'migration_rc=0' 'redacted_sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'output_begin' 'password=secret' 'output_end' 'VPS_EVIDENCE_END'
EOF
chmod +x "$work/bin/ssh"
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
[[ -s "$local_evidence" && "$(stat -f '%Lp' "$local_evidence")" == 600 ]]
grep -Fq 'VPS_EVIDENCE_BEGIN' "$local_evidence"
if grep -Fq 'secret' "$local_evidence"; then exit 1; fi
captured="$(<"$capture")"
[[ "$captured" == *"VPS_MIGRATION_COMMAND=$expected_migration_q"* ]]
[[ "$captured" == *"VPS_COMPOSE_COMMAND=$expected_compose_q"* ]]
[[ "$captured" == *"VPS_HEALTH_COMMAND=$expected_health_q"* ]]
if grep -Fq 'scp' <<<"$captured"; then exit 1; fi
cleanup_output="$("${base[@]}" bash "$script" cleanup --id cleanup-cli)"
[[ "$cleanup_output" == *'READY: mode=cleanup id=cleanup-cli'* ]]
cleanup_captured="$(<"$capture")"
if grep -Fq 'VPS_SOURCE_URL=' <<<"$cleanup_captured" || grep -Fq 'VPS_MIGRATION_COMMAND=' <<<"$cleanup_captured" || grep -Fq 'VPS_HEALTH_COMMAND=' <<<"$cleanup_captured"; then exit 1; fi
set +e
"${base[@]}" NO_EVIDENCE=1 VPS_LOCAL_EVIDENCE_FILE="$work/missing-evidence" VPS_DB_PASSWORD=secret bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id quote-check >"$work/missing-output" 2>&1
missing_status=$?
set -e
[[ "$missing_status" -ne 0 && ! -e "$work/missing-evidence" ]]
printf '%s\n' 'VPS command forwarding test passed.'
