#!/usr/bin/env bash
set -Eeuo pipefail
root="$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
script="$root/scripts/vps-preview.sh"
lib="$root/scripts/vps-preview-lib.sh"
work="$(mktemp -d)"; trap 'rm -rf -- "$work"' EXIT
known_hosts="$work/known_hosts"
for key_type in ed25519 rsa ecdsa; do
  ssh-keygen -q -t "$key_type" -N '' -f "$work/host-key-$key_type"
done
fingerprint="$(ssh-keygen -lf "$work/host-key-rsa.pub" | awk '{print $2}')"
printf 'preview.example.test %s\npreview.example.test %s\npreview.example.test %s\n' \
  "$(<"$work/host-key-ed25519.pub")" "$(<"$work/host-key-rsa.pub")" "$(<"$work/host-key-ecdsa.pub")" > "$known_hosts"
run_blocked() { local out status; set +e; out=$("$@" 2>&1); status=$?; set -e; if [[ $status -eq 3 && "$out" == *BLOCKED:* && "$out" != *fixture-secret* ]]; then return 0; fi; return 1; }
assert() { "$@" || { printf 'assertion failed: %s\n' "$*" >&2; exit 1; }; }
commit="$(git -C "$root" rev-parse HEAD)"; tree="$(git -C "$root" rev-parse 'HEAD^{tree}')"
git clone --quiet --no-local "$root" "$work/source"
mkdir -p "$work/bin"
cat > "$work/bin/scp" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$work/bin/ssh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
cat >/dev/null
printf '%s\n' 'VPS_EVIDENCE_BEGIN' 'preview_id=preview-one' 'project=deploylite-preview-preview-one' 'commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'tree=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' 'mode=migration-only' 'migration_rc=0' 'redacted_sha256=01aa5a615af892efa3b5f87cc556aec5a2a2da15df5123a38ce542d226b25ae2' 'output_begin' 'PASS: fake remote' 'output_end' 'VPS_EVIDENCE_END'
EOF
chmod +x "$work/bin/ssh" "$work/bin/scp"
base=(env -i PATH="$work/bin:$PATH" VPS_HOST=preview.example.test VPS_KNOWN_HOSTS_FILE="$known_hosts" VPS_HOST_FINGERPRINT="$fingerprint" VPS_SOURCE_URL=https://example.test/deploylite.git)
assert run_blocked "${base[@]}" bash "$script" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id 'bad/id'
assert run_blocked "${base[@]}" bash "$script" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id preview-one --remote-root /opt/deploylite
assert run_blocked "${base[@]}" bash "$script" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id preview-one --host production.example.test
output="$("${base[@]}" bash "$script" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id preview-one)"
[[ "$output" == *'READY:'* && "$output" != *fixture-secret* ]]
single_known_hosts="$work/single-known_hosts"
printf 'preview.example.test %s\n' "$(<"$work/host-key-rsa.pub")" > "$single_known_hosts"
single_output="$("${base[@]}" VPS_KNOWN_HOSTS_FILE="$single_known_hosts" bash "$script" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id single-match)"
[[ "$single_output" == *'READY: mode=migration-only id=single-match'* ]]
none_known_hosts="$work/none-known_hosts"
printf 'preview.example.test %s\npreview.example.test %s\n' "$(<"$work/host-key-ed25519.pub")" "$(<"$work/host-key-ecdsa.pub")" > "$none_known_hosts"
assert run_blocked "${base[@]}" VPS_KNOWN_HOSTS_FILE="$none_known_hosts" bash "$script" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id no-match
wrong_host_known_hosts="$work/wrong-host-known_hosts"
printf 'preview.example.test %s\nother.example.test %s\n' "$(<"$work/host-key-ed25519.pub")" "$(<"$work/host-key-rsa.pub")" > "$wrong_host_known_hosts"
assert run_blocked "${base[@]}" VPS_KNOWN_HOSTS_FILE="$wrong_host_known_hosts" bash "$script" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id wrong-host
alias_root="$work/path with spaces/DEPLOYLITE"
mkdir -p "$(dirname -- "$alias_root")" "$work/outside"
ln -s "$root" "$alias_root"
cat > "$work/bin/git" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "${1:-}" == -C && "${3:-}" == rev-parse && "${4:-}" == --show-toplevel ]]; then
  printf '%s\n' "${GIT_ROOT_ALIAS:?}"
else
  exec "${REAL_GIT:?}" "$@"
fi
EOF
chmod +x "$work/bin/git"
symlink_output="$("${base[@]}" PATH="$work/bin:$PATH" REAL_GIT="$(command -v git)" GIT_ROOT_ALIAS="$alias_root" bash "$alias_root/scripts/vps-preview.sh" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id symlink-one)"
[[ "$symlink_output" == *'READY: mode=migration-only id=symlink-one'* ]]
cp -- "$script" "$work/outside/vps-preview.sh"
assert run_blocked "${base[@]}" bash "$work/outside/vps-preview.sh" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id outside-one
assert run_blocked "${base[@]}" VPS_HOST_FINGERPRINT=SHA256:mismatch bash "$script" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id preview-one
assert run_blocked "${base[@]}" VPS_SOURCE_URL=file:///tmp/private.git bash "$script" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id preview-one
grep -Fq 'sshpass -e' "$script"
grep -Fq 'StrictHostKeyChecking=yes' "$script"
grep -Fq 'HEAD^{tree}' "$lib"
if grep -Fq 'scp' "$script"; then exit 1; fi
if grep -Fq 'VPS_ARCHIVE' "$script"; then exit 1; fi
printf '%s\n' 'VPS preview contract tests passed.'
