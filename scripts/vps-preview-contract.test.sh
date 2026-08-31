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
assert run_blocked "${base[@]}" VPS_HOST_FINGERPRINT=SHA256:mismatch bash "$script" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id preview-one
assert run_blocked "${base[@]}" VPS_SOURCE_URL=file:///tmp/private.git bash "$script" migration-only --source "$work/source" --commit "$commit" --tree "$tree" --id preview-one
grep -Fq 'sshpass -e' "$script"
grep -Fq 'StrictHostKeyChecking=yes' "$script"
grep -Fq 'HEAD^{tree}' "$lib"
grep -Fq 'scp' "$script" && exit 1 || true
grep -Fq 'VPS_ARCHIVE' "$script" && exit 1 || true
printf '%s\n' 'VPS preview contract tests passed.'
