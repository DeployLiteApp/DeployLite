#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DEPLOYLITE_BOOTSTRAP_TESTING=1
# shellcheck source=scripts/bootstrap.sh
. "${ROOT_DIR}/scripts/bootstrap.sh"

PASS=0
FAIL=0
stat_mode() { local value; if value="$(stat -c '%a' "$1" 2>/dev/null)" && [[ "$value" =~ ^[0-9]+$ ]]; then printf '%s' "$value"; else stat -f '%Lp' "$1" 2>/dev/null; fi; }
stat_inode() { local value; if value="$(stat -c '%i' "$1" 2>/dev/null)" && [[ "$value" =~ ^[0-9]+$ ]]; then printf '%s' "$value"; else stat -f '%i' "$1" 2>/dev/null; fi; }

assert_contains() {
  local haystack="$1" needle="$2"
  [[ "$haystack" == *"$needle"* ]] || { printf 'expected output to contain %s\nactual: %s\n' "$needle" "$haystack"; return 1; }
}

assert_not_contains() {
  local haystack="$1" needle="$2"
  [[ "$haystack" != *"$needle"* ]] || { printf 'expected output not to contain %s\nactual: %s\n' "$needle" "$haystack"; return 1; }
}

run_test() {
  local name="$1"
  shift
  if "$@"; then
    PASS=$((PASS + 1))
    printf 'ok - %s\n' "$name"
  elif [[ "$?" -eq 77 ]]; then
    printf 'skip - %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    printf 'not ok - %s\n' "$name"
  fi
}

test_tarball_url_uses_immutable_sha() {
  DEPLOYLITE_REPO="DeployLiteApp/DeployLite"
  DEPLOYLITE_VERSION="fbd0ec736c6c76428fde181f34f1a9ede0323e16"
  [[ "$(tarball_url)" == "https://codeload.github.com/DeployLiteApp/DeployLite/tar.gz/${DEPLOYLITE_VERSION}" ]]
}

test_branch_ref_is_rejected() {
  local output status
  DEPLOYLITE_VERSION="main"
  output="$(validate_config 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 2 ]]
  assert_contains "$output" "immutable 40-character commit SHA"
}

test_invalid_repo_fails_actionably() {
  local output status
  DEPLOYLITE_REPO="https://github.com/CoreFoundryTech/DeployLite"
  DEPLOYLITE_VERSION="fbd0ec736c6c76428fde181f34f1a9ede0323e16"
  output="$(validate_config 2>&1)" && status=0 || status=$?
  [[ "$status" -eq 2 ]]
  assert_contains "$output" "Invalid DEPLOYLITE_REPO"
}

test_download_uses_curl_without_printing_secret_values() (
  local tmp output
  tmp="$(mktemp -d)"
  TARBALL_PATH="${tmp}/deploylite.tar.gz"
  command_exists() { [[ "$1" == "curl" ]]; }
  curl() { printf 'fake archive' >"${!#}"; }
  DEPLOYLITE_SECRET_TOKEN="super-secret-value"
  output="$(download_tarball "https://example.invalid/archive.tar.gz" 2>&1)"
  [[ -f "$TARBALL_PATH" ]]
  assert_not_contains "$output" "super-secret-value"
  rm -rf "$tmp"
)

create_valid_source() {
  local root="$1"
  mkdir -p "$root/top/scripts" "$root/top/apps/api" "$root/top/apps/web" "$root/top/infra/vps"
  printf '#!/usr/bin/env bash\n' >"$root/top/scripts/install.sh"
  for file in apps/api/Dockerfile apps/web/Dockerfile package.json pnpm-lock.yaml .node-version infra/vps/compose.yml infra/vps/compose.tls.yml scripts/runtime-handoff.sh; do : >"$root/top/$file"; done
  chmod +x "$root/top/scripts/install.sh" "$root/top/scripts/runtime-handoff.sh"
}

test_extract_finds_installer_in_real_github_style_archive() (
  local tmp
  if ! tar --version 2>/dev/null | grep -q 'GNU tar'; then return 77; fi
  tmp="$(mktemp -d)"
  TMP_ROOT="$tmp"
  TARBALL_PATH="${tmp}/deploylite.tar.gz"
  mkdir -p "$TMP_ROOT/source"
  create_valid_source "$tmp/input"
  TAR_BIN="$(command -v gtar 2>/dev/null || command -v tar)"
  "$TAR_BIN" -czf "$TARBALL_PATH" -C "$tmp/input" top
  chown() { :; }; owner_group() { printf '0:0'; }
   extract_source
  [[ "$SOURCE_DIR" == "$TMP_ROOT/source/top" ]]
  rm -rf "$tmp"
)

test_extract_rejects_unsafe_archive_types_before_unpacking() (
  local tmp output status
  if ! tar --version 2>/dev/null | grep -q 'GNU tar'; then return 77; fi
  tmp="$(mktemp -d)"; TMP_ROOT="$tmp"; TARBALL_PATH="$tmp/archive.tar.gz"; mkdir -p "$tmp/source"
  mkdir -p "$tmp/input/top"; ln -s /tmp/unsafe "$tmp/input/top/link"
  TAR_BIN="$(command -v gtar 2>/dev/null || command -v tar)"
  "$TAR_BIN" -czf "$TARBALL_PATH" -C "$tmp/input" top
  set +e; output="$(extract_source 2>&1)"; status=$?; set -e
  [[ "$status" -ne 0 && ! -e "$tmp/installed-source" ]]
)

test_real_archives_reject_paths_and_entry_types() {
  local kind tmp status output tar_bin
  if command -v gtar >/dev/null 2>&1; then tar_bin="$(command -v gtar)"; elif tar --version 2>/dev/null | grep -q 'GNU tar'; then tar_bin="$(command -v tar)"; elif [[ "$(uname -s)" == Linux ]]; then printf 'GNU tar is required for real archive tests on Linux\n'; return 1; else return 77; fi
  TAR_BIN="$tar_bin"
  for kind in absolute traversal double-slash sibling symlink hardlink fifo device; do
    tmp="$(mktemp -d)"; mkdir -p "$tmp/input/top"; printf payload >"$tmp/input/top/file"
    set +e
    case "$kind" in
      absolute) COPYFILE_DISABLE=1 "$tar_bin" -P -cf "$tmp/raw.tar" -C "$tmp/input" --transform='s#^top/#/absolute/#' top ;;
      traversal) COPYFILE_DISABLE=1 "$tar_bin" -P -cf "$tmp/raw.tar" -C "$tmp/input" --transform='s#^top/#../escape/#' top ;;
      double-slash) COPYFILE_DISABLE=1 "$tar_bin" -cf "$tmp/raw.tar" -C "$tmp/input" --transform='s#^top/#top//#' top ;;
      sibling) mkdir "$tmp/input/other"; printf sibling >"$tmp/input/other/file"; COPYFILE_DISABLE=1 "$tar_bin" -cf "$tmp/raw.tar" -C "$tmp/input" top other ;;
      symlink) ln -s file "$tmp/input/top/link"; COPYFILE_DISABLE=1 "$tar_bin" -cf "$tmp/raw.tar" -C "$tmp/input" top ;;
      hardlink) ln "$tmp/input/top/file" "$tmp/input/top/hard"; COPYFILE_DISABLE=1 "$tar_bin" -cf "$tmp/raw.tar" -C "$tmp/input" top ;;
      fifo) mkfifo "$tmp/input/top/fifo"; COPYFILE_DISABLE=1 "$tar_bin" -cf "$tmp/raw.tar" -C "$tmp/input" top ;;
      device) mknod "$tmp/input/top/device" c 1 3; COPYFILE_DISABLE=1 "$tar_bin" -cf "$tmp/raw.tar" -C "$tmp/input" top ;;
      spaces) printf spaces >"$tmp/input/top/space name"; COPYFILE_DISABLE=1 "$tar_bin" -cf "$tmp/raw.tar" -C "$tmp/input" top ;;
      newline) printf newline >"$tmp/input/top/$'line\nbreak'"; COPYFILE_DISABLE=1 "$tar_bin" -cf "$tmp/raw.tar" -C "$tmp/input" top ;;
    esac
    rc=$?; set -e; [[ "$rc" -eq 0 && -f "$tmp/raw.tar" ]] || { printf 'archive creation failed for %s\n' "$kind"; rm -rf -- "$tmp"; return 1; }; gzip -c "$tmp/raw.tar" >"$tmp/archive.tar.gz"; TMP_ROOT="$tmp/sandbox"; TARBALL_PATH="$tmp/archive.tar.gz"; mkdir "$TMP_ROOT" "$TMP_ROOT/source"
     set +e; output="$(extract_source 2>&1)"; status=$?; set -e
     : "$output"
     [[ "$status" -ne 0 && ! -e "$tmp/installed-source" ]] || { rm -rf -- "$tmp"; return 1; }
    rm -rf -- "$tmp"
  done
}

test_real_archive_accepts_spaces_and_newlines() {
  local tmp kind tar_bin name
  if command -v gtar >/dev/null 2>&1; then tar_bin="$(command -v gtar)"; elif tar --version 2>/dev/null | grep -q 'GNU tar'; then tar_bin="$(command -v tar)"; else return 77; fi
  for kind in spaces newline; do
    tmp="$(mktemp -d)"; create_valid_source "$tmp/input"
    if [[ "$kind" == spaces ]]; then name='space name'; else name=$'line\nbreak'; fi
    printf payload >"$tmp/input/top/$name"; "$tar_bin" -czf "$tmp/archive.tar.gz" -C "$tmp/input" top
    TMP_ROOT="$tmp/sandbox"; TARBALL_PATH="$tmp/archive.tar.gz"; mkdir -p "$TMP_ROOT/source"; TAR_BIN="$tar_bin"; chown() { :; }; owner_group() { printf '0:0'; }
    extract_source || { rm -rf "$tmp"; return 1; }; rm -rf "$tmp"
  done
}

test_run_installer_preserves_deploylite_env_and_args() {
  local tmp captured
  tmp="$(mktemp -d)"
  SOURCE_DIR="$tmp/DeployLite-main"
  INSTALL_DIR="$tmp/install"; SOURCE_INSTALL_DIR="$INSTALL_DIR/source"; mkdir -p "$SOURCE_DIR/scripts" "$SOURCE_DIR/apps/api" "$SOURCE_DIR/apps/web" "$SOURCE_DIR/infra/vps"
  cat >"$SOURCE_DIR/scripts/install.sh" <<'SCRIPT'
#!/usr/bin/env bash
printf 'public_host=%s\n' "${DEPLOYLITE_PUBLIC_HOST:-}"
printf 'secret_present=%s\n' "${DEPLOYLITE_SECRET_TOKEN:+yes}"
printf 'args=%s\n' "$*"
SCRIPT
  chmod +x "$SOURCE_DIR/scripts/install.sh"; TAR_BIN="$(command -v tar)"; owner_group() { printf '0:0'; }
  for file in apps/api/Dockerfile apps/web/Dockerfile package.json pnpm-lock.yaml .node-version infra/vps/compose.yml infra/vps/compose.tls.yml scripts/runtime-handoff.sh; do : >"$SOURCE_DIR/$file"; done
  chmod +x "$SOURCE_DIR/scripts/runtime-handoff.sh"; SOURCE_ARCHIVE_SHA256="$(printf x | (sha256sum 2>/dev/null || shasum -a 256) | awk '{print $1}')"; DEPLOYLITE_REPO='CoreFoundryTech/DeployLite'; DEPLOYLITE_VERSION='fccff176a9cefa4e92ec9ebd23f94d85dc36c431'
  chown() { :; }
  # shellcheck disable=SC2034
  DEPLOYLITE_PUBLIC_HOST="203.0.113.10"
  # shellcheck disable=SC2034
  DEPLOYLITE_SECRET_TOKEN="super-secret-value"
  captured="$(run_installer --dry-run)"
  assert_contains "$captured" "public_host=203.0.113.10" || return 1
  assert_contains "$captured" "secret_present=yes" || return 1
  assert_contains "$captured" "args=--dry-run" || return 1
  assert_not_contains "$captured" "super-secret-value" || return 1
  rm -rf "$tmp"
}

test_noop_revalidates_and_repairs_existing_bundle() {
  local tmp inode_before inode_same inode_repaired
  tmp="$(mktemp -d)"; SOURCE_DIR="$tmp/source-input"; INSTALL_DIR="$tmp/install"; SOURCE_INSTALL_DIR="$INSTALL_DIR/source"; mkdir -p "$SOURCE_DIR/scripts" "$SOURCE_DIR/apps/api" "$SOURCE_DIR/apps/web" "$SOURCE_DIR/infra/vps"
  for file in apps/api/Dockerfile apps/web/Dockerfile package.json pnpm-lock.yaml .node-version infra/vps/compose.yml infra/vps/compose.tls.yml scripts/runtime-handoff.sh scripts/install.sh; do printf '%s\n' "$file" >"$SOURCE_DIR/$file"; done
  chmod 0755 "$SOURCE_DIR/scripts/install.sh" "$SOURCE_DIR/scripts/runtime-handoff.sh"; TAR_BIN="$(command -v gtar 2>/dev/null || command -v tar)"; SOURCE_ARCHIVE_SHA256="$(printf archive | (sha256sum 2>/dev/null || shasum -a 256) | awk '{print $1}')"; DEPLOYLITE_REPO='CoreFoundryTech/DeployLite'; DEPLOYLITE_VERSION='fccff176a9cefa4e92ec9ebd23f94d85dc36c431'
  chown() { :; }; owner_group() { printf '0:0'; }
  install_source_bundle; inode_before="$(stat_inode "$SOURCE_INSTALL_DIR/package.json")"; install_source_bundle; inode_same="$(stat_inode "$SOURCE_INSTALL_DIR/package.json")"; [[ "$inode_before" == "$inode_same" ]] || { rm -rf "$tmp"; return 1; }
  printf corrupted >"$SOURCE_INSTALL_DIR/package.json"; chmod 0644 "$SOURCE_INSTALL_DIR/scripts/install.sh"; install_source_bundle; inode_repaired="$(stat_inode "$SOURCE_INSTALL_DIR/package.json")"; [[ "$inode_repaired" != "$inode_same" && "$(<"$SOURCE_INSTALL_DIR/package.json")" == 'package.json' && "$(stat_mode "$SOURCE_INSTALL_DIR/scripts/install.sh")" == 755 ]] || { rm -rf "$tmp"; return 1; }; rm -rf "$tmp"
}

test_source_bundle_failure_removes_staging_and_preserves_previous_source() (
  local tmp output status
  tmp="$(mktemp -d)"; SOURCE_DIR="$tmp/input"; INSTALL_DIR="$tmp/install"; SOURCE_INSTALL_DIR="$INSTALL_DIR/source"
  mkdir -p "$SOURCE_DIR/scripts" "$INSTALL_DIR" "$SOURCE_INSTALL_DIR"; printf previous >"$SOURCE_INSTALL_DIR/previous"
  printf '#!/usr/bin/env bash\n' >"$SOURCE_DIR/scripts/install.sh"; ln -s /tmp/unsafe "$SOURCE_DIR/scripts/link"
  TAR_BIN="$(command -v gtar 2>/dev/null || command -v tar)"; SOURCE_ARCHIVE_SHA256=archive; DEPLOYLITE_REPO=DeployLiteApp/DeployLite; DEPLOYLITE_VERSION=fccff176a9cefa4e92ec9ebd23f94d85dc36c431
  chown() { :; }; owner_group() { printf '0:0'; }
  set +e; output="$(install_source_bundle 2>&1)"; status=$?; set -e
  [[ "$status" -ne 0 && "$output" == *'Staged source bundle validation failed.'* && "$(<"$SOURCE_INSTALL_DIR/previous")" == previous ]]
  if compgen -G "$INSTALL_DIR/.source.staging.*" >/dev/null; then
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
)

test_normalize_tree_repairs_nested_modes() {
  local tmp
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/root/nested/deep/scripts"
  printf data >"$tmp/root/nested/deep/file"
  printf script >"$tmp/root/nested/deep/scripts/install.sh"
  printf text >"$tmp/root/nested/deep/scripts/notes.sh"
  chmod 0700 "$tmp/root" "$tmp/root/nested" "$tmp/root/nested/deep" "$tmp/root/nested/deep/file" "$tmp/root/nested/deep/scripts" "$tmp/root/nested/deep/scripts/install.sh" "$tmp/root/nested/deep/scripts/notes.sh"
  chown() { :; }
  normalize_tree "$tmp/root"
  if [[ "$(stat_mode "$tmp/root/nested/deep")" == 755 && "$(stat_mode "$tmp/root/nested/deep/file")" == 644 && "$(stat_mode "$tmp/root/nested/deep/scripts/install.sh")" == 755 && "$(stat_mode "$tmp/root/nested/deep/scripts/notes.sh")" == 644 ]]; then
    rm -rf "$tmp"
    return 0
  fi
  rm -rf "$tmp"
  return 1
}

test_stat_helpers_return_file_metadata_cross_platform() {
  local tmp
  tmp="$(mktemp -d)"; chmod 0751 "$tmp"
  [[ "$(stat_mode "$tmp")" == 751 && "$(portable_stat '%a' '%Lp' "$tmp" '^[0-9]+$')" == 751 && "$(stat_inode "$tmp")" =~ ^[0-9]+$ ]] || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}

test_cleanup_removes_temp_root() {
  local tmp
  tmp="$(mktemp -d)"
  TMP_ROOT="$tmp"
  cleanup
  [[ ! -e "$tmp" ]]
}

run_test 'tarball URL uses immutable SHA' test_tarball_url_uses_immutable_sha
run_test 'branch ref is rejected' test_branch_ref_is_rejected
run_test 'invalid repo fails actionably' test_invalid_repo_fails_actionably
run_test 'download uses curl without secret output' test_download_uses_curl_without_printing_secret_values
run_test 'extract finds installer in a real GitHub-style archive' test_extract_finds_installer_in_real_github_style_archive
run_test 'extract rejects unsafe archive types before unpacking' test_extract_rejects_unsafe_archive_types_before_unpacking
run_test 'real archives reject unsafe paths and entry types' test_real_archives_reject_paths_and_entry_types
run_test 'real archives preserve spaces and newlines in names' test_real_archive_accepts_spaces_and_newlines
run_test 'installer receives DEPLOYLITE env and args' test_run_installer_preserves_deploylite_env_and_args
run_test 'matching marker is a validated no-op and corruption is repaired' test_noop_revalidates_and_repairs_existing_bundle
run_test 'source bundle failures remove staging and preserve the previous source' test_source_bundle_failure_removes_staging_and_preserves_previous_source
run_test 'normalize_tree repairs nested modes with an exact executable allowlist' test_normalize_tree_repairs_nested_modes
run_test 'stat helpers return file metadata across GNU and BSD formats' test_stat_helpers_return_file_metadata_cross_platform
run_test 'cleanup removes temp root' test_cleanup_removes_temp_root

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
