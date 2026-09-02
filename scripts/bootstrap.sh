#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

readonly DEFAULT_REPO="CoreFoundryTech/DeployLite"

DEPLOYLITE_REPO="${DEPLOYLITE_REPO:-$DEFAULT_REPO}"
DEPLOYLITE_VERSION="${DEPLOYLITE_VERSION:-}"

TMP_ROOT=""
TARBALL_PATH=""
SOURCE_DIR=""
SOURCE_ARCHIVE_SHA256=""
TAR_BIN=""
INSTALL_DIR="${DEPLOYLITE_INSTALL_DIR:-/opt/deploylite}"
SOURCE_INSTALL_DIR="${INSTALL_DIR}/source"

log() { printf '[%s] %s\n' "$1" "${2:-}"; }
info() { log INFO "$1"; }
fail() { log ERROR "$1"; exit "${2:-1}"; }

cleanup() {
  if [[ -n "$TMP_ROOT" && -d "$TMP_ROOT" ]]; then
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

on_error() {
  local code=$?
  log ERROR "Bootstrap failed. Temporary files were cleaned up. No secrets were printed."
  exit "$code"
}
trap on_error ERR

command_exists() { command -v "$1" >/dev/null 2>&1; }

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "Root execution is required. Re-run with: curl -fsSL <bootstrap-url> | sudo DEPLOYLITE_VERSION=<immutable-commit-sha> bash" 2
  fi
}

require_dependency() {
  local name="$1"
  command_exists "$name" || fail "Missing required dependency: ${name}. Install it and retry." 2
}

validate_config() {
  [[ "$DEPLOYLITE_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "Invalid DEPLOYLITE_REPO. Expected owner/repo." 2
  [[ "$DEPLOYLITE_VERSION" =~ ^[0-9a-fA-F]{40}$ ]] || fail "DEPLOYLITE_VERSION must be an immutable 40-character commit SHA." 2
}

preflight() {
  require_root
  validate_config
  if ! command_exists curl && ! command_exists wget; then
    fail "Missing required dependency: curl or wget. Install one and retry." 2
  fi
  if command_exists gtar; then TAR_BIN="$(command -v gtar)"; elif command_exists tar && tar --version 2>/dev/null | grep -q 'GNU tar'; then TAR_BIN="$(command -v tar)"; else fail "GNU tar is required on supported Ubuntu/Debian hosts; install tar and retry." 2; fi
  require_dependency mktemp
  command_exists sha256sum || command_exists shasum || fail "Missing required dependency: sha256sum or shasum." 2
}

tarball_url() {
  printf 'https://codeload.github.com/%s/tar.gz/%s' "$DEPLOYLITE_REPO" "$DEPLOYLITE_VERSION"
}

download_tarball() {
  local url="$1"
  if command_exists curl; then
    curl -fL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 1 "$url" -o "$TARBALL_PATH"
  else
    wget -q --timeout=10 --tries=2 -O "$TARBALL_PATH" "$url"
  fi
}

extract_source() {
  local member top=""
  while IFS= read -r -d '' member; do
    [[ -n "$member" && "$member" != /* && "$member" != *$'\r'* ]] || fail "Downloaded archive contains an unsafe path." 1
    [[ "/$member/" != */../* ]] || fail "Downloaded archive contains a traversal path." 1
    if [[ "$member" == */* ]]; then
      if [[ -z "$top" ]]; then top="${member%%/*}"; elif [[ "$top" != "${member%%/*}" ]]; then fail "Downloaded archive must contain exactly one top-level directory." 1; fi
    fi
  done < <("${TAR_BIN:-tar}" --null --list --file "$TARBALL_PATH")
  [[ -n "$top" ]] || fail "Downloaded archive did not contain one source directory." 1
  while IFS= read -r -d '' member; do
    [[ "$member" == "$top" || "$member" == "$top/"* ]] || fail "Downloaded archive contains an unexpected top-level member." 1
  done < <("${TAR_BIN:-tar}" --null --list --file "$TARBALL_PATH")
  if command_exists sha256sum; then SOURCE_ARCHIVE_SHA256="$(sha256sum "$TARBALL_PATH" | awk '{print $1}')"; else SOURCE_ARCHIVE_SHA256="$(shasum -a 256 "$TARBALL_PATH" | awk '{print $1}')"; fi
  "${TAR_BIN:-tar}" --extract --gzip --file "$TARBALL_PATH" --directory "$TMP_ROOT/source" --no-absolute-names --no-same-owner --no-same-permissions --keep-directory-symlink
  SOURCE_DIR="$TMP_ROOT/source/$top"
  [[ -d "$SOURCE_DIR" && ! -L "$SOURCE_DIR" ]] || fail "Downloaded archive did not contain a safe source directory." 1
  normalize_tree "$SOURCE_DIR"
  validate_tree "$SOURCE_DIR" || fail "Downloaded archive contains an unsupported filesystem entry." 1
  validate_required_inputs "$SOURCE_DIR" || fail "Downloaded archive is missing required workspace inputs." 1
  [[ -x "$SOURCE_DIR/scripts/install.sh" || -f "$SOURCE_DIR/scripts/install.sh" ]] || fail "Downloaded archive is missing scripts/install.sh." 1
}

normalize_tree() {
  local root="$1" path mode
  [[ -d "$root" && ! -L "$root" ]] || return 1
  chown 0:0 "$root"; chmod 0755 "$root"
  for path in "$root"/* "$root"/.[!.]* "$root"/..?*; do
    [[ -e "$path" || -L "$path" ]] || continue
    [[ "$path" == "$root/.deploylite-source" ]] && continue
    [[ ! -L "$path" && ( -d "$path" || -f "$path" ) ]] || return 1
    chown 0:0 "$path"
    if [[ -d "$path" ]]; then chmod 0755 "$path"; normalize_tree "$path"; continue; fi
    mode="$(portable_stat '%a' '%Lp' "$path" '^[0-9]+$')"
    if executable_path "$path"; then chmod 0755 "$path"; else chmod 0644 "$path"; fi
  done
}
executable_path() {
  case "$1" in
    */scripts/bootstrap.sh|*/scripts/bootstrap.test.sh|*/scripts/install.sh|*/scripts/install.test.sh|*/scripts/install-tee.test.sh|*/scripts/runtime-contract.test.sh|*/scripts/runtime-handoff.sh|*/scripts/runtime-handoff.test.sh|*/scripts/support-policy.test.sh|*/scripts/vps-preview-contract.test.sh|*/scripts/vps-preview-failure-matrix.test.sh|*/scripts/vps-preview-full.test.sh|*/scripts/vps-preview-lib.sh|*/scripts/vps-preview-remote.sh|*/scripts/vps-preview-remote.test.sh|*/scripts/vps-preview.sh) return 0 ;;
    *) return 1 ;;
  esac
}
portable_stat() {
  local gnu_format="$1" bsd_format="$2" path="$3" pattern="$4" value
  if value="$(stat -c "$gnu_format" "$path" 2>/dev/null)" && [[ "$value" =~ $pattern ]]; then printf '%s' "$value"; return 0; fi
  value="$(stat -f "$bsd_format" "$path" 2>/dev/null)" && [[ "$value" =~ $pattern ]] || return 1
  printf '%s' "$value"
}
owner_group() { portable_stat '%u:%g' '%u:%g' "$1" '^[0-9]+:[0-9]+$'; }
validate_tree() {
  local root="$1" path inode mode; [[ "${2:-}" == keep ]] || TREE_INODES='|'
  [[ "$(owner_group "$root")" == 0:0 && "$(portable_stat '%a' '%Lp' "$root" '^[0-9]+$')" == 755 ]] || return 1
  for path in "$root"/* "$root"/.[!.]* "$root"/..?*; do
    [[ -e "$path" || -L "$path" ]] || continue
    [[ "$path" != *$'\n'* && "$path" != *$'\r'* ]] || return 1
    [[ ! -L "$path" && ( -d "$path" || -f "$path" ) ]] || return 1
    [[ "$(owner_group "$path")" == 0:0 ]] || return 1
    mode=644; [[ -d "$path" ]] && mode=755; executable_path "$path" && mode=755
    [[ "$(portable_stat '%a' '%Lp' "$path" '^[0-9]+$')" == "$mode" ]] || return 1
    if [[ -f "$path" ]]; then
      inode="$(portable_stat '%d:%i' '%d:%i' "$path" '^[0-9]+:[0-9]+$')"
      [[ "$TREE_INODES" != *"|$inode|"* ]] || return 1; TREE_INODES="${TREE_INODES}${inode}|"
    fi
    if [[ -d "$path" && ! -L "$path" ]]; then validate_tree "$path" keep || return 1; fi
  done
}
validate_required_inputs() { local root="$1" file; for file in apps/api/Dockerfile apps/web/Dockerfile package.json pnpm-lock.yaml .node-version infra/vps/compose.yml infra/vps/compose.tls.yml scripts/runtime-handoff.sh; do [[ -f "$root/$file" && ! -L "$root/$file" ]] || return 1; done; }
manifest() {
  local root="$1" base="${2:-$1}" path relative mode type hash
  for path in "$root"/* "$root"/.[!.]* "$root"/..?*; do
    [[ -e "$path" || -L "$path" ]] || continue
    [[ "$path" != "$root/.deploylite-source" ]] || continue
    relative="${path#"$base"/}"
    if [[ -d "$path" ]]; then type='directory'; mode=0755; hash=-
    elif [[ -f "$path" ]]; then type='file'; mode=0644; executable_path "$path" && mode=0755; hash="$(sha256_file_local "$path")"
    else return 1; fi
    printf 'owner=0:0|type=%s|mode=%s|path=%s|sha256=%s\n' "$type" "$mode" "$relative" "$hash"
    [[ -d "$path" && ! -L "$path" ]] && manifest "$path" "$base"
  done | LC_ALL=C sort
}
sha256_file_local() { if command_exists sha256sum; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }
source_manifest_sha() { manifest "$1" | if command_exists sha256sum; then sha256sum | awk '{print $1}'; else shasum -a 256 | awk '{print $1}'; fi; }
install_source_bundle() {
  local stage backup digest marker
  SOURCE_ARCHIVE_SHA256="${SOURCE_ARCHIVE_SHA256:?archive digest is required}"
  mkdir -p "$INSTALL_DIR"; chmod 0700 "$INSTALL_DIR"
  if [[ -f "$SOURCE_INSTALL_DIR/.deploylite-source" ]] && existing_source_valid; then return 0; fi
  stage="$(mktemp -d "$INSTALL_DIR/.source.staging.XXXXXX")"; chmod 0700 "$stage"
  "${TAR_BIN:-tar}" -C "$SOURCE_DIR" -cf - . | "${TAR_BIN:-tar}" -C "$stage" -xf - --no-same-owner --no-same-permissions
  normalize_tree "$stage"; validate_tree "$stage" || fail "Staged source bundle validation failed." 1
  digest="$(source_manifest_sha "$stage")"
  marker="$stage/.deploylite-source"
  printf 'schema=2\nrepository=%s\ncommit=%s\narchive_sha256=%s\nmanifest_sha256=%s\n' "$DEPLOYLITE_REPO" "$DEPLOYLITE_VERSION" "$SOURCE_ARCHIVE_SHA256" "$digest" >"$marker"
  chmod 0644 "$marker"; chown 0:0 "$marker"
  backup="$(mktemp -d "$INSTALL_DIR/.source.previous.XXXXXX")"
  if [[ -L "$SOURCE_INSTALL_DIR" ]]; then rm -rf -- "$stage" "$backup"; fail "Installed source path is a symlink; refusing replacement." 1; fi
  if [[ -e "$SOURCE_INSTALL_DIR" ]]; then mv "$SOURCE_INSTALL_DIR" "$backup/source"; fi
  if ! mv "$stage" "$SOURCE_INSTALL_DIR"; then [[ -e "$backup/source" ]] && mv "$backup/source" "$SOURCE_INSTALL_DIR"; rm -rf -- "$stage"; fail "Source replacement failed; previous source preserved." 1; fi
  rm -rf -- "$backup"
}
existing_source_valid() {
  local marker key value schema='' repository='' commit='' archive='' manifest='' actual
  marker="$SOURCE_INSTALL_DIR/.deploylite-source"
  [[ -d "$SOURCE_INSTALL_DIR" && ! -L "$SOURCE_INSTALL_DIR" && -f "$marker" && ! -L "$marker" ]] || return 1
  [[ "$(owner_group "$marker")" == 0:0 && "$(portable_stat '%a' '%Lp' "$marker" '^[0-9]+$')" == 644 ]] || return 1
  [[ "$(awk 'END {print NR}' "$marker")" == 5 ]] || return 1
  while IFS='=' read -r key value; do case "$key" in schema) schema="$value" ;; repository) repository="$value" ;; commit) commit="$value" ;; archive_sha256) archive="$value" ;; manifest_sha256) manifest="$value" ;; *) return 1 ;; esac; done <"$marker"
  [[ "$schema" == 2 && "$repository" == "$DEPLOYLITE_REPO" && "$commit" == "$DEPLOYLITE_VERSION" && "$archive" == "$SOURCE_ARCHIVE_SHA256" && "$manifest" =~ ^[0-9a-fA-F]{64}$ ]] || return 1
  validate_tree "$SOURCE_INSTALL_DIR" || return 1
  validate_required_inputs "$SOURCE_INSTALL_DIR" || return 1
  actual="$(source_manifest_sha "$SOURCE_INSTALL_DIR")" || return 1
  [[ "$actual" == "$manifest" ]]
}

export_deploylite_environment() {
  local name
  while IFS= read -r name; do
    [[ "$name" =~ ^DEPLOYLITE_[A-Za-z0-9_]*$ ]] || continue
    # shellcheck disable=SC2163
    export "$name"
  done < <(compgen -v DEPLOYLITE_ || true)
}

run_installer() {
  export_deploylite_environment
  install_source_bundle
  bash "$SOURCE_INSTALL_DIR/scripts/install.sh" "$@"
}

main() {
  preflight
  TMP_ROOT="$(mktemp -d)"
  mkdir -p "$TMP_ROOT/source"
  TARBALL_PATH="$TMP_ROOT/deploylite.tar.gz"

  info "Downloading DeployLite source archive."
  download_tarball "$(tarball_url)"
  info "Extracting DeployLite source archive."
  extract_source
  info "Starting DeployLite installer from downloaded source."
  run_installer "$@"
}

if [[ "${DEPLOYLITE_BOOTSTRAP_TESTING:-0}" != "1" ]]; then
  main "$@"
fi
