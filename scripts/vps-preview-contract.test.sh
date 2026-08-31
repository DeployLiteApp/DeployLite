#!/usr/bin/env bash
set -Eeuo pipefail
root="$(git -C "$(dirname -- "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
script="$root/scripts/vps-preview.sh"
lib="$root/scripts/vps-preview-lib.sh"
work="$(mktemp -d)"; trap 'rm -rf -- "$work"' EXIT
known_hosts="$work/known_hosts"; printf '%s\n' 'preview.example.test ssh-ed25519 AAAAfixture' > "$known_hosts"
ssh-keygen -q -t ed25519 -N '' -f "$work/host-key"
printf 'preview.example.test %s\n' "$(<"$work/host-key.pub")" > "$known_hosts"
fingerprint="$(ssh-keygen -lf "$work/host-key.pub" | awk '{print $2}')"
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
cat >/dev/null
printf 'PASS: fake remote\n'
EOF
chmod +x "$work/bin/ssh" "$work/bin/scp"
base=(env -i PATH="$work/bin:$PATH" VPS_HOST=preview.example.test VPS_KNOWN_HOSTS_FILE="$known_hosts" VPS_HOST_FINGERPRINT="$fingerprint" VPS_SOURCE_URL=https://example.test/deploylite.git)
assert run_blocked "${base[@]}" bash "$script" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id 'bad/id'
assert run_blocked "${base[@]}" bash "$script" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id preview-one --remote-root /opt/deploylite
assert run_blocked "${base[@]}" bash "$script" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id preview-one --host production.example.test
output="$("${base[@]}" bash "$script" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id preview-one)"
[[ "$output" == *'READY:'* && "$output" != *fixture-secret* ]]
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
