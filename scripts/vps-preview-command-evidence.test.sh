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
EOF
chmod +x "$work/bin/ssh"
command_text='printf "migration value with spaces and \"quotes\"\\n"'
compose_text='printf "compose value with spaces and \"quotes\"\\n"'
health_text='printf "health value with spaces and \"quotes\"\\n"'
base=(env -i PATH="$work/bin:$PATH" CAPTURE="$capture" VPS_HOST=preview.example.test VPS_KNOWN_HOSTS_FILE="$known_hosts" VPS_HOST_FINGERPRINT="$fingerprint" VPS_SOURCE_URL=https://example.test/deploylite.git)
output="$("${base[@]}" VPS_MIGRATION_COMMAND="$command_text" VPS_COMPOSE_COMMAND="$compose_text" VPS_HEALTH_COMMAND="$health_text" bash "$script" migration-only --source "$source_repo" --commit "$commit" --tree "$tree" --id quote-check)"
[[ "$output" == *'READY:'* ]]
captured="$(<"$capture")"
[[ "$captured" == *'VPS_MIGRATION_COMMAND=printf\ "migration\ value\ with\ spaces\ and\ \\"quotes\\"\\\\n"'* ]]
[[ "$captured" == *'VPS_COMPOSE_COMMAND=printf\ "compose\ value\ with\ spaces\ and\ \\"quotes\\"\\\\n"'* ]]
[[ "$captured" == *'VPS_HEALTH_COMMAND=printf\ "health\ value\ with\ spaces\ and\ \\"quotes\\"\\\\n"'* ]]
if grep -Fq 'scp' <<<"$captured"; then exit 1; fi
printf '%s\n' 'VPS command forwarding test passed.'
