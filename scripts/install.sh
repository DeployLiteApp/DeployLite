#!/usr/bin/env bash
set -Eeuo pipefail

INSTALL_DIR="${DEPLOYLITE_INSTALL_DIR:-/opt/deploylite}"
SOURCES_DIR="${INSTALL_DIR}/.sources"
REPO_ROOT="${DEPLOYLITE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE_FILE="${INSTALL_DIR}/compose.yml"
TLS_COMPOSE_FILE="${INSTALL_DIR}/compose.tls.yml"
STATE_DIR="${INSTALL_DIR}/.state"
DEFAULT_LOG_FILE="/var/log/deploylite/install.log"
INSTALL_LOG="${DEPLOYLITE_INSTALL_LOG:-$DEFAULT_LOG_FILE}"
INSTALL_LOG_DIR="${DEPLOYLITE_INSTALL_LOG_DIR:-$(dirname "$INSTALL_LOG")}"
APT_TIMEOUT_SECONDS="${DEPLOYLITE_APT_TIMEOUT_SECONDS:-180}"
STATE_SCHEMA_VERSION=1
STATE_FILE="${STATE_DIR}/install-state"
LOCK_DIR="${STATE_DIR}/install.lock"
LOCK_HELD=0
STATE_CONTEXT_FINGERPRINT=""
COMPLETED_STEPS=()
ACTIVE_STEP=""
INTERACTIVE=1
NOOP=0
CHECK=0
CHANGED_STEPS=()
PROGRESS_TOTAL=6
PROGRESS_INDEX=0
PROGRESS_LABEL=""
STEP_RESULT=pass

log() { printf '[%s] %s\n' "$1" "$(redact "${2:-}")"; }
info() { log INFO "$1"; }
# warn/fail write to stderr so command substitutions like
# `host="$(detect_public_host)"` cannot accidentally capture the error
# message and treat it as a successful value. info stays on stdout
# because it is the normal "this worked" channel and the installer's
# `exec > >(tee ...)` redirect is the one that copies it to the log.
warn() { printf '[%s] %s\n' "$1" "$(redact "${2:-}")" >&2; }
fail() {
  if [[ -n "$PROGRESS_LABEL" && "$PROGRESS_INDEX" -gt 0 ]]; then
    ACTIVE_STEP="$PROGRESS_LABEL"
    progress_result fail "${1:-installation error}"
    warn "Install failed during ${ACTIVE_STEP}."
    warn "Resume: re-run this installer; durable progress is stored at ${STATE_FILE}."
  fi
  printf '[%s] %s\n' "$1" "$(redact "${2:-}")" >&2
  exit "${2:-1}"
}

redact() {
  local value="${1:-}"
  value="$(printf '%s' "$value" | sed -E 's#(postgres://[^:]+:)[^@]+@#\1[REDACTED]@#g')"
  value="$(printf '%s' "$value" | sed -E 's#((PASSWORD|SECRET|TOKEN|COOKIE|DATABASE_URL)[A-Z_]*=)[^[:space:]]+#\1[REDACTED]#Ig')"
  printf '%s' "$value"
}

# Stream-level redaction. Reads bytes from stdin and writes redacted bytes
# to stdout. Used as a coproc filter so that EVERY line — including raw
# command stdout/stderr that never touches log() — is rewritten before it
# reaches the tee that writes the install log. Keep the patterns here in
# sync with the value-based redact() above; the log() call sites apply the
# same rewrites a second time, which is idempotent.
redact_stream() {
  sed -u -E \
    -e 's#(postgres://[^:]+:)[^@]+@#\1[REDACTED]@#g' \
    -e 's#((PASSWORD|SECRET|TOKEN|COOKIE|DATABASE_URL)[A-Z_]*=)[^[:space:]]+#\1[REDACTED]#Ig'
}

on_error() {
  _report_error "$?"
}

_report_error() {
  local code="$1"
  warn "Install failed during ${ACTIVE_STEP:-admission checks}. Changed steps: ${CHANGED_STEPS[*]:-none}. Preserving installed prerequisites and Compose templates."
  warn "Resume: re-run this installer; durable progress is stored at ${STATE_FILE}."
  exit "$code"
}
trap on_error ERR

on_signal() {
  local code="$1"
  if [[ -n "$ACTIVE_STEP" && "$PROGRESS_INDEX" -gt 0 ]]; then
    progress_result fail "interrupted"
  fi
  warn "Install interrupted during ${ACTIVE_STEP:-admission checks}. Completed steps are preserved; the active step was not recorded."
  warn "Resume: re-run this installer; durable progress is stored at ${STATE_FILE}."
  exit "$code"
}
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

record_change() { CHANGED_STEPS+=("$1"); }
command_exists() { command -v "$1" >/dev/null 2>&1; }
run() { "$@"; }

sha256_text() {
  if command_exists sha256sum; then
    sha256sum | awk '{print $1}'
  elif command_exists shasum; then
    shasum -a 256 | awk '{print $1}'
  else
    fail "sha256sum or shasum is required for installer state." 2
  fi
}

sha256_file() {
  local path="$1"
  [[ -f "$path" ]] || fail "Installer source contract is missing: ${path}." 2
  if command_exists sha256sum; then
    sha256sum "$path" | awk '{print $1}'
  elif command_exists shasum; then
    shasum -a 256 "$path" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required for installer state." 2
  fi
}

executable_source_path() { case "$1" in */scripts/bootstrap.sh|*/scripts/bootstrap.test.sh|*/scripts/install.sh|*/scripts/install.test.sh|*/scripts/install-tee.test.sh|*/scripts/runtime-contract.test.sh|*/scripts/runtime-handoff.sh|*/scripts/runtime-handoff.test.sh|*/scripts/support-policy.test.sh|*/scripts/vps-preview-contract.test.sh|*/scripts/vps-preview-failure-matrix.test.sh|*/scripts/vps-preview-full.test.sh|*/scripts/vps-preview-lib.sh|*/scripts/vps-preview-remote.sh|*/scripts/vps-preview-remote.test.sh|*/scripts/vps-preview.sh) return 0 ;; *) return 1 ;; esac; }
portable_stat() { local gnu_format="$1" bsd_format="$2" path="$3" pattern="$4" value; if value="$(stat -c "$gnu_format" "$path" 2>/dev/null)" && [[ "$value" =~ $pattern ]]; then printf '%s' "$value"; return 0; fi; value="$(stat -f "$bsd_format" "$path" 2>/dev/null)" && [[ "$value" =~ $pattern ]] || return 1; printf '%s' "$value"; }
is_dotenv_basename() { case "${1##*/}" in .env|.env.*) return 0 ;; *) return 1 ;; esac; }
is_runtime_forbidden_basename() { case "${1##*/}" in .git|node_modules) return 0 ;; *) return 1 ;; esac; }
validate_installed_tree() { local root="$1" path mode inode; [[ "$(portable_stat '%u:%g' '%u:%g' "$root" '^[0-9]+:[0-9]+$')" == 0:0 && "$(portable_stat '%a' '%Lp' "$root" '^[0-9]+$')" == 755 ]] || return 1; for path in "$root"/* "$root"/.[!.]* "$root"/..?*; do [[ -e "$path" || -L "$path" ]] || continue; [[ ! -L "$path" && ( -d "$path" || -f "$path" ) ]] || return 1; is_dotenv_basename "$path" && return 1; is_runtime_forbidden_basename "$path" && return 1; [[ "$(portable_stat '%u:%g' '%u:%g' "$path" '^[0-9]+:[0-9]+$')" == 0:0 ]] || return 1; if [[ -d "$path" ]]; then mode=755; else mode=644; executable_source_path "$path" && mode=755; inode="$(portable_stat '%d:%i' '%d:%i' "$path" '^[0-9]+:[0-9]+$')"; [[ "${SOURCE_INODES:-|}" != *"|$inode|"* ]] || return 1; SOURCE_INODES="${SOURCE_INODES:-|}${inode}|"; fi; [[ "$(portable_stat '%a' '%Lp' "$path" '^[0-9]+$')" == "$mode" ]] || return 1; if [[ -d "$path" && ! -L "$path" ]]; then validate_installed_tree "$path" || return 1; fi; done; }
source_is_valid() {
  local root marker key value schema repository commit archive manifest path mode actual target target_root sources_root
  root="${INSTALL_DIR}/source"; marker="$root/.deploylite-source"
  [[ -L "$root" && -f "$marker" && ! -L "$marker" && -d "$SOURCES_DIR" && ! -L "$SOURCES_DIR" ]] || return 1
  [[ "$(portable_stat '%u:%g' '%u:%g' "$SOURCES_DIR" '^[0-9]+:[0-9]+$')" == 0:0 && "$(portable_stat '%a' '%Lp' "$SOURCES_DIR" '^[0-9]+$')" == 700 ]] || return 1
  sources_root="$(cd -P "$SOURCES_DIR" 2>/dev/null && pwd -P)" || return 1
  target="$(readlink "$root")" || return 1
  [[ "$target" =~ ^\.sources/[0-9A-Fa-f]{64}(\.[0-9A-Fa-f]{64}\.[0-9]+\.[0-9]+)?$ ]] || return 1
  target_root="$(cd -P "$(dirname "$root")/$target" 2>/dev/null && pwd -P)" || return 1
  [[ "$target_root" == "$sources_root"/* && "$target_root" != "$sources_root" ]] || return 1
  [[ -d "$target_root" && ! -L "$target_root" ]] || return 1
  root="$target_root"; marker="$root/.deploylite-source"
  [[ "$(portable_stat '%u' '%u' "$marker" '^[0-9]+$')" == 0 && "$(portable_stat '%a' '%Lp' "$marker" '^[0-9]+$')" == 644 ]] || return 1
  [[ "$(awk 'END {print NR}' "$marker")" == 5 ]] || return 1
  while IFS='=' read -r key value; do case "$key" in schema) schema="$value" ;; repository) repository="$value" ;; commit) commit="$value" ;; archive_sha256) archive="$value" ;; manifest_sha256) manifest="$value" ;; *) return 1 ;; esac; done <"$marker"
  [[ "$schema" == 2 && "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ && "$commit" =~ ^[0-9a-fA-F]{40}$ && "$archive" =~ ^[0-9a-fA-F]{64}$ && "$manifest" =~ ^[0-9a-fA-F]{64}$ ]] || return 1
  [[ "$(basename "$root")" == "$manifest" || "$(basename "$root")" == "$manifest."* ]] || return 1
  SOURCE_INODES='|'; validate_installed_tree "$root" || return 1
  for path in apps/api/Dockerfile apps/web/Dockerfile package.json pnpm-lock.yaml .node-version infra/vps/compose.yml infra/vps/compose.tls.yml scripts/runtime-handoff.sh; do [[ -f "$root/$path" && ! -L "$root/$path" ]] || return 1; done
  actual="$(source_manifest "$root")" || return 1; [[ "$(printf '%s' "$actual" | sha256_text)" == "$manifest" ]]
}

canonical_install_dir() {
  ( cd -P "$INSTALL_DIR" && pwd -P )
}

installer_context_fingerprint() {
  local os_file="${DEPLOYLITE_OS_RELEASE_FILE:-/etc/os-release}" os_id="" os_version="" key value
  [[ -r "$os_file" ]] || fail "Cannot fingerprint installer context: ${os_file} is unreadable." 2
  while IFS='=' read -r key value; do
    case "$key" in
      ID) os_id="${value%\"}"; os_id="${os_id#\"}" ;;
      VERSION_ID) os_version="${value%\"}"; os_version="${os_version#\"}" ;;
    esac
  done <"$os_file"
  {
    printf 'schema=%s\n' "$STATE_SCHEMA_VERSION"
    printf 'os=%s:%s\n' "$os_id" "$os_version"
    printf 'architecture=%s\n' "$(uname_machine)"
    printf 'install_dir=%s\n' "$(canonical_install_dir)"
    printf 'public_host=%s\n' "${DEPLOYLITE_PUBLIC_HOST:-deploylite.com}"
    printf 'skip_docker=%s\n' "${DEPLOYLITE_SKIP_DOCKER_INSTALL:-0}"
    printf 'repo_root=%s\n' "$(cd -P "$REPO_ROOT" && pwd -P)"
    printf 'compose=%s\n' "$(sha256_file "${REPO_ROOT}/infra/vps/compose.yml")"
    printf 'compose_tls=%s\n' "$(sha256_file "${REPO_ROOT}/infra/vps/compose.tls.yml")"
    printf 'installer=%s\n' "$(sha256_file "${REPO_ROOT}/scripts/install.sh")"
  } | sha256_text
}

state_owner_is_safe() {
  local path="$1" owner=""
  owner="$(as_root portable_stat '%u' '%u' "$path" '^[0-9]+$')" || return 1
  [[ "$owner" == "0" || "$owner" == "${EUID}" ]]
}

state_mode_is_safe() {
  local path="$1" mode=""
  mode="$(as_root portable_stat '%a' '%Lp' "$path" '^[0-9]+$')" || return 1
  [[ "$mode" == "600" ]]
}

acquire_state_lock() {
  [[ "$LOCK_HELD" -eq 0 ]] || return 0
  if ! as_root mkdir "$LOCK_DIR" 2>/dev/null; then
    warn "Another DeployLite installer is using ${STATE_DIR}; refusing to steal the lock. Remove ${LOCK_DIR} only after confirming no installer is running."
    return 1
  fi
  LOCK_HELD=1
  trap release_state_lock EXIT
  as_root chmod 700 "$LOCK_DIR"
}

release_state_lock() {
  if [[ "$LOCK_HELD" -eq 1 ]]; then
    as_root rmdir "$LOCK_DIR" 2>/dev/null || true
    LOCK_HELD=0
  fi
}

recover_malformed_state() {
  local reason="$1" archive_dir
  archive_dir="$(as_root mktemp -d "${STATE_DIR}/.install-state.invalid.XXXXXX")" || fail "Cannot create a collision-safe installer state archive." 2
  if ! as_root mv "$STATE_FILE" "${archive_dir}/state"; then
    as_root rmdir "$archive_dir" 2>/dev/null || true
    fail "Cannot archive malformed installer state safely (${reason})." 2
  fi
  warn "Recovered malformed installer state (${reason}); archived under ${archive_dir}."
  COMPLETED_STEPS=()
  state_write
}

state_prepare_dir() {
  if [[ -L "$INSTALL_DIR" || -L "$STATE_DIR" || ( -e "$STATE_DIR" && ! -d "$STATE_DIR" ) ]]; then
    fail "Installer state path is unsafe: ${STATE_DIR}." 2
  fi
  as_root mkdir -p "$STATE_DIR"
  as_root chmod 700 "$STATE_DIR"
}

state_load() {
  local schema fingerprint steps line_count=0
  local line1 line2 line3
  [[ "$LOCK_HELD" -eq 1 ]] || fail "Installer state lock is not held." 2
  COMPLETED_STEPS=()
  STATE_CONTEXT_FINGERPRINT="$(installer_context_fingerprint)"
  [[ -e "$STATE_FILE" || -L "$STATE_FILE" ]] || return 0
  if [[ -L "$STATE_FILE" || ! -f "$STATE_FILE" ]] || ! state_owner_is_safe "$STATE_FILE" || ! state_mode_is_safe "$STATE_FILE"; then
    warn "Installer state is unsafe (path, ownership, or mode): ${STATE_FILE}."
    warn "Manual recovery: remove or replace ${STATE_FILE} only after confirming its ownership and target are safe."
    return 2
  fi
  line_count="$(as_root awk 'END {print NR}' "$STATE_FILE")" || { recover_malformed_state "unreadable state"; return 0; }
  if [[ "$line_count" -ne 3 ]]; then recover_malformed_state "invalid line count"; return 0; fi
  line1="$(as_root sed -n '1p' "$STATE_FILE")"
  line2="$(as_root sed -n '2p' "$STATE_FILE")"
  line3="$(as_root sed -n '3p' "$STATE_FILE")"
  if [[ ! "$line1" =~ ^schema_version=([0-9]+)$ ]]; then recover_malformed_state "invalid schema line"; return 0; fi
  schema="${BASH_REMATCH[1]}"
  if [[ ! "$line2" =~ ^context_fingerprint=([0-9a-f]{64})$ ]]; then recover_malformed_state "invalid context fingerprint line"; return 0; fi
  fingerprint="${BASH_REMATCH[1]}"
  if [[ ! "$line3" =~ ^completed_steps=(.*)$ ]]; then recover_malformed_state "invalid completion line"; return 0; fi
  steps="${BASH_REMATCH[1]}"
  if [[ "$schema" != "$STATE_SCHEMA_VERSION" ]]; then recover_malformed_state "unsupported schema"; return 0; fi
  case "$steps" in
    "") ;;
    install-curl) COMPLETED_STEPS=(install-curl) ;;
    install-curl,install-docker) COMPLETED_STEPS=(install-curl install-docker) ;;
    install-curl,install-docker,prepare-install-dir) COMPLETED_STEPS=(install-curl install-docker prepare-install-dir) ;;
    *) recover_malformed_state "invalid completion prefix"; return 0 ;;
  esac
  if [[ "$fingerprint" != "$STATE_CONTEXT_FINGERPRINT" ]]; then
    COMPLETED_STEPS=()
    state_write
    return 0
  fi
}

state_write() {
  local tmp
  local steps=""
  [[ "$LOCK_HELD" -eq 1 ]] || fail "Installer state lock is not held." 2
  if ((${#COMPLETED_STEPS[@]} > 0)); then
    steps="$(IFS=,; printf '%s' "${COMPLETED_STEPS[*]}")"
  fi
  tmp="$(as_root mktemp "${STATE_DIR}/.install-state.XXXXXX")" || fail "Cannot create durable installer state temporary file." 2
  if ! printf 'schema_version=%s\ncontext_fingerprint=%s\ncompleted_steps=%s\n' "$STATE_SCHEMA_VERSION" "$STATE_CONTEXT_FINGERPRINT" "$steps" | as_root tee "$tmp" >/dev/null; then
    as_root rm -f "$tmp" || true
    fail "Cannot write durable installer state." 2
  fi
  as_root chmod 600 "$tmp"
  as_root sync -f "$tmp" || { as_root rm -f "$tmp" || true; fail "Cannot sync durable installer state." 2; }
  as_root mv "$tmp" "$STATE_FILE" || { as_root rm -f "$tmp" || true; fail "Cannot atomically install durable installer state." 2; }
  as_root sync -f "$STATE_DIR" || fail "Cannot sync installer state directory." 2
}

state_has_step() {
  local step="$1" completed
  for completed in ${COMPLETED_STEPS[@]+"${COMPLETED_STEPS[@]}"}; do
    [[ "$completed" == "$step" ]] && return 0
  done
  return 1
}

run_durable_step() {
  local step="$1" runner="$2" status
  case "$step" in
    install-curl|install-docker|prepare-install-dir) ;;
    *) warn "Unknown installer step: ${step}."; return 2 ;;
  esac
  if state_has_step "$step"; then
    STEP_RESULT=skip
    info "Skipping completed installer step: ${step}."
    return 0
  fi
  ACTIVE_STEP="$step"
  info "Running installer step: ${step}."
  status=0
  "$runner" || status=$?
  if [[ "$status" -ne 0 ]]; then
    ACTIVE_STEP=""
    return "$status"
  fi
  COMPLETED_STEPS+=("$step")
  state_write
  ACTIVE_STEP=""
  return 0
}

progress_start() {
  PROGRESS_INDEX="$1"
  ACTIVE_STEP="$2"
  PROGRESS_LABEL="$2"
  info "[${PROGRESS_INDEX}/${PROGRESS_TOTAL}] ${ACTIVE_STEP}: RUNNING"
}

progress_result() {
  local status="$1" detail="${2:-}"
  case "$status" in
    pass) status=PASS ;;
    skip) status=SKIP ;;
    fail) status=FAIL ;;
    *) ;;
  esac
  info "[${PROGRESS_INDEX}/${PROGRESS_TOTAL}] ${ACTIVE_STEP}: ${status}${detail:+ — ${detail}}"
}

run_progress_step() {
  local index="$1" label="$2" runner="$3" status=0
  progress_start "$index" "$label"
  STEP_RESULT=pass
  if "$runner"; then
    ACTIVE_STEP="$label"
    progress_result "$STEP_RESULT"
    ACTIVE_STEP=""
    PROGRESS_LABEL=""
    return 0
  else
    status=$?
  fi
  ACTIVE_STEP="$label"
  progress_result fail
  return "$status"
}

print_usage() {
  cat <<'USAGE'
Usage: install.sh [options]

Options:
  --interactive, -i       Show the prerequisite confirmation TUI (default).
  --non-interactive   Skip the prerequisite confirmation TUI.
  --check             Run a read-only prerequisite audit and exit.
  --noop              Skip preflight and installation (not a prerequisite audit).
  --help, -h          Show this help and exit.

Environment:
  DEPLOYLITE_PUBLIC_HOST=<hostname>    Installation host (default: deploylite.com).
  DEPLOYLITE_EXPECTED_PUBLIC_IP=<IPv4>  Override the detected local public IP for DNS verification.
  DEPLOYLITE_APT_TIMEOUT_SECONDS=<n>    Bound apt operations (default: 180).
  DEPLOYLITE_INSTALL_DIR=<path>        Install directory (default: /opt/deploylite).
  DEPLOYLITE_INSTALL_LOG=<path>        Install log file (default: /var/log/deploylite/install.log).
  DEPLOYLITE_INSTALL_LOG_DIR=<path>    Install log directory (default: parent of DEPLOYLITE_INSTALL_LOG).

Logs:
  The installer tees stdout and stderr to the install log with redaction applied
  to every line, including database URLs, password assignments, and secret tokens.
  Default path: /var/log/deploylite/install.log
USAGE
}

parse_args() {
  while (( $# > 0 )); do
    case "$1" in
       --interactive|-i) INTERACTIVE=1; shift ;;
       --non-interactive) INTERACTIVE=0; shift ;;
      --check) CHECK=1; shift ;;
      --noop) NOOP=1; shift ;;
      --help|-h) print_usage; exit 0 ;;
      --)
        shift
        while (( $# > 0 )); do
        fail "Unknown argument: $1. Use --non-interactive or --help." 2
        done
        ;;
      *) fail "Unknown argument: $1. Use --non-interactive or --help." 2 ;;
    esac
  done
}

# Create the install log directory and file, then redirect stdout and stderr
# through `tee` so the terminal and the log file see the same redacted stream.
# Idempotent: re-running appends to the existing log instead of truncating.
# Repairs unsafe permissions on a pre-existing log file (e.g., mode 0666 left
# behind by an earlier installer version) by downgrading to the safe 0640
# target whenever the current user has permission to do so.
install_log_setup() {
  local log_file="${INSTALL_LOG}"
  local log_dir="${INSTALL_LOG_DIR}"
  if [[ ! -d "$log_dir" ]]; then
    if ! as_root mkdir -p "$log_dir" 2>/dev/null; then
      warn "Could not create log directory ${log_dir}. Continuing without file log."
      return 0
    fi
  fi
  info "log directory ready at ${log_dir}"
  if ! ( umask 027; as_root touch "$log_file" ) 2>/dev/null; then
    warn "Could not create log file ${log_file}. Continuing without file log."
    return 0
  fi
  if ! as_root test -w "$log_file"; then
    warn "Log file ${log_file} is not writable. Continuing without file log."
    return 0
  fi
  # Repair unsafe permissions on a pre-existing log file. The umask only
  # affects newly created files, so an older install log with mode 0666 or
  # anything world-readable would otherwise stay world-readable forever.
  # The warning is written to BOTH the log file (for post-mortem review)
  # and stderr (for the operator's terminal). We can't just call warn()
  # because the tee that copies stdout to the log file has not been
  # started yet at this point in the function.
  if [[ -f "$log_file" ]]; then
    local current_mode=""
    current_mode="$(portable_stat '%a' '%Lp' "$log_file" '^[0-9]+$' 2>/dev/null || echo "")"
    case "$current_mode" in
      600|640) ;;
      "")
        printf '[%s] %s\n' "WARN" "Could not stat ${log_file} to verify mode; leaving permissions untouched." | as_root tee -a "$log_file" >&2
        ;;
      *)
        if as_root chmod 0640 "$log_file" 2>/dev/null; then
          printf '[%s] %s\n' "WARN" "Repaired unsafe log file mode ${current_mode} -> 0640 on ${log_file}." | as_root tee -a "$log_file" >&2
        else
          printf '[%s] %s\n' "WARN" "Could not repair unsafe log file mode ${current_mode} on ${log_file}; leaving permissions untouched." | as_root tee -a "$log_file" >&2
        fi
        ;;
    esac
  fi
  if [[ "${DEPLOYLITE_INSTALL_TESTING:-0}" == "1" && "${DEPLOYLITE_INSTALL_SKIP_TEE:-0}" == "1" ]]; then
    info "Install log: ${log_file} (tee disabled in test mode)"
    return 0
  fi
  # `exec` replaces the shell's stdout and stderr so the redirect survives
  # every subsequent function call. The byte stream passes through
  # redact_stream() — a sed-based filter that rewrites postgres URLs and
  # KEY=VALUE secret patterns on every line — before tee writes them to
  # the log file. The terminal also sees the redacted stream, which is
  # the safe default for an installer. log() redacts again at the value
  # level, which is idempotent. `trap '' PIPE` keeps the sed filter from
  # dying with SIGPIPE when the downstream tee closes, which would
  # otherwise trip `set -o pipefail`.
  if exec > >(
    trap '' PIPE
    redact_stream | as_root tee -a "$log_file"
  ) 2>&1; then
    info "Install log: ${log_file}"
  else
    warn "Could not redirect stdout to tee for ${log_file}."
  fi
  return 0
}

# Render an interactive prompt. Prefers whiptail when available; otherwise
# falls back to plain read so `--interactive` works on minimal VPS images
# and on systems without a tty (where read reads from a pipe).
prompt_value() {
  local label="$1" default_value="${2:-}" response=""
  if [[ "${INTERACTIVE}" != "1" ]]; then
    printf '%s' "$default_value"
    return 0
  fi
  if command_exists whiptail && [[ -t 0 ]]; then
    response="$(whiptail --inputbox "$label" 8 60 "$default_value" --title "DeployLite install" 3>&1 1>&2 2>&3 || true)"
    if [[ -n "$response" ]]; then
      printf '%s' "$response"
      return 0
    fi
  fi
  if [[ -t 0 ]]; then
    local ans
    read -r -p "${label} [${default_value}]: " ans || true
    printf '%s' "${ans:-$default_value}"
  else
    # Non-tty stdin: read whatever line was piped in. This keeps
    # `printf 'value\n' | bash install.sh --interactive` working in tests
    # and in piped automation that still wants a confirmation.
    local ans
    IFS= read -r ans || true
    printf '%s' "${ans:-$default_value}"
  fi
}

as_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    run "$@"
  elif command_exists sudo; then
    run sudo "$@"
  else
    fail "Root or sudo is required. Re-run as root or install sudo." 2
  fi
}

detect_os() {
  [[ -r /etc/os-release ]] || fail "Unsupported host: /etc/os-release is missing." 2
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:20.04|ubuntu:22.04|ubuntu:24.04|debian:11|debian:12) ;;
    *) fail "Unsupported host: expected Ubuntu 20.04/22.04/24.04 or Debian 11/12." 2 ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64|aarch64|arm64) ;;
    *) fail "Unsupported CPU architecture: $(uname -m). Expected x86_64 or arm64." 2 ;;
  esac
}

uname_machine() { run uname -m; }

bounded_diagnostic() {
  local value="${1:-}"
  value="${value//$'\n'/ }"
  value="${value//$'\r'/ }"
  value="${value:0:160}"
  redact "$value"
}

check_result() {
  local name="$1" status="$2" detail="${3:-}"
  if [[ "$status" == "pass" ]]; then
    printf '%s\n' "[PASS] ${name}${detail:+ — $(bounded_diagnostic "$detail")}";
  else
    printf '[FAIL] %s%s\n' "$name" "${detail:+ — $(bounded_diagnostic "$detail")}" >&2
  fi
}

check_platform() {
  local os_file="${DEPLOYLITE_OS_RELEASE_FILE:-/etc/os-release}" machine="" os_id="" os_version="" key value
  if [[ -r "$os_file" ]]; then
    while IFS='=' read -r key value; do
      case "$key" in
        ID) os_id="${value%\"}"; os_id="${os_id#\"}" ;;
        VERSION_ID) os_version="${value%\"}"; os_version="${os_version#\"}" ;;
      esac
    done <"$os_file"
  fi
  if [[ "$os_id:$os_version" == "ubuntu:20.04" ||
    "$os_id:$os_version" == "ubuntu:22.04" ||
    "$os_id:$os_version" == "ubuntu:24.04" ||
    "$os_id:$os_version" == "debian:11" ||
    "$os_id:$os_version" == "debian:12" ]]; then
    check_result "supported OS (${os_id} ${os_version})" pass
  else
    check_result "supported OS" fail "expected Ubuntu 20.04/22.04/24.04 or Debian 11/12"
    return 1
  fi
  machine="$(uname_machine 2>/dev/null || true)"
  case "$machine" in
    x86_64|amd64|aarch64|arm64) check_result "supported architecture ($machine)" pass ;;
    *) check_result "supported architecture" fail "received ${machine:-unknown}; expected x86_64 or arm64"; return 1 ;;
  esac
}

check_command() {
  local command_name="$1"
  if command_exists "$command_name"; then
    check_result "required command: ${command_name}" pass
    return 0
  fi
  check_result "required command: ${command_name}" fail "not found on PATH"
  return 1
}

check_docker() {
  local output=""
  if ! command_exists docker; then
    check_result "Docker Engine CLI" fail "docker is not installed"
    check_result "Docker Compose plugin" fail "cannot probe Compose without docker"
    return 1
  fi
  if ! command_exists timeout; then
    check_result "Docker Engine CLI" fail "timeout is required to bound the Docker probe"
    check_result "Docker Compose plugin" fail "timeout is required to bound the Compose probe"
    return 1
  fi
  if output="$(run timeout 5 docker --version 2>&1)"; then
    check_result "Docker Engine CLI" pass "$(bounded_diagnostic "$output")"
  else
    check_result "Docker Engine CLI" fail "docker --version failed: $output"
    return 1
  fi
  if output="$(run timeout 5 docker compose version 2>&1)"; then
    check_result "Docker Compose plugin" pass "$(bounded_diagnostic "$output")"
    return 0
  fi
  check_result "Docker Compose plugin" fail "docker compose version failed: $output"
  return 1
}

check_port() {
  local port="$1"
  if ! command_exists ss && ! command_exists lsof; then
    check_result "port ${port}/tcp readiness" fail "no non-mutating port probe is available"
    return 1
  fi
  if port_available "$port"; then
    check_result "port ${port}/tcp readiness" pass
    return 0
  fi
  check_result "port ${port}/tcp readiness" fail "port is occupied or could not be verified"
  return 1
}

check_prerequisites() {
  local failures=0
  printf 'DeployLite prerequisite check (read-only)\n'
  check_platform || failures=$((failures + 1))
  check_command docker || failures=$((failures + 1))
  check_command timeout || failures=$((failures + 1))
  if command_exists ss || command_exists lsof; then
    check_result "port probe command (ss or lsof)" pass
  else
    check_result "port probe command (ss or lsof)" fail "neither command is installed"
    failures=$((failures + 1))
  fi
  check_docker || failures=$((failures + 1))
  check_port 80 || failures=$((failures + 1))
  check_port 443 || failures=$((failures + 1))
  if (( failures == 0 )); then
    printf 'Prerequisite check passed. No installer actions were performed.\n'
    return 0
  fi
  printf 'Prerequisite check failed: %d check(s) failed. No installer actions were performed.\n' "$failures" >&2
  return 2
}

port_available() {
  local port="$1"
  if command_exists ss; then
    local listeners
    listeners="$(run ss -ltn "sport = :${port}")"
    if [[ "$listeners" == *":${port}"* ]]; then
      return 1
    fi
    return 0
  fi
  if command_exists lsof; then
    if run lsof -iTCP:"${port}" -sTCP:LISTEN -Pn >/dev/null 2>&1; then
      return 1
    fi
    return 0
  fi
  warn "Cannot verify port ${port}; ss/lsof not installed."
  return 0
}

deploylite_traefik_owns_port() {
  local port="$1" container_ids container_id metadata binding count=0
  command_exists docker || return 1
  container_ids="$(as_root docker ps --quiet \
    --filter 'label=com.docker.compose.project=deploylite' \
    --filter 'label=com.docker.compose.service=traefik')" || return 1

  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    count=$((count + 1))
  done <<<"$container_ids"
  [[ "$count" -eq 1 ]] || return 1

  container_id="$container_ids"
  metadata="$(as_root docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container_id")" || return 1
  [[ "$metadata" == "deploylite|traefik|${INSTALL_DIR}" ]] || return 1

  while IFS= read -r binding; do
    [[ "$binding" == *":${port}" ]] && return 0
  done < <(as_root docker port "$container_id" "${port}/tcp" 2>/dev/null)
  return 1
}

port_available_or_owned_by_deploylite_traefik() {
  local port="$1"
  port_available "$port" || deploylite_traefik_owns_port "$port"
}

preflight() {
  info "Running preflight checks."
  detect_os
  detect_arch
  if [[ "${EUID}" -ne 0 ]] && ! command_exists sudo; then
    fail "Root or sudo is required. Re-run as root or install sudo." 2
  fi
  command_exists timeout || fail "timeout is required to bound apt operations." 2
  port_available_or_owned_by_deploylite_traefik 80 || fail "Port 80 is already in use by a service other than this install's DeployLite Traefik container. Stop the conflicting service before installing." 2
  port_available_or_owned_by_deploylite_traefik 443 || fail "Port 443 is already in use by a service other than this install's DeployLite Traefik container. Stop the conflicting service before installing." 2
}

install_docker() {
  if [[ "${DEPLOYLITE_SKIP_DOCKER_INSTALL:-0}" == "1" ]]; then
    STEP_RESULT=skip
    info "Skipping Docker install (DEPLOYLITE_SKIP_DOCKER_INSTALL=1)."
    return 0
  fi
  if command_exists docker && as_root docker compose version >/dev/null 2>&1; then
    STEP_RESULT=skip
    info "Docker Engine and Compose plugin already installed; skipping apt install."
    return
  fi
  command_exists apt-get || fail "Docker is missing and automatic install requires apt-get." 2
  info "Installing Docker Engine and Compose plugin through Docker's official apt repository."
  install_docker_apt_repository
  apt_bounded update
  apt_bounded install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  command_exists docker || fail "Docker installation did not provide docker CLI." 2
  as_root docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is unavailable after install." 2
  record_change "docker-installed-or-updated"
}

install_curl() {
  if command_exists curl; then
    STEP_RESULT=skip
    info "curl is available for local reachability checks."
    return 0
  fi
  command_exists apt-get || fail "curl is required and automatic install requires apt-get." 2
  info "Installing curl for local reachability checks."
  apt_bounded update
  apt_bounded install -y ca-certificates curl
  command_exists curl || fail "curl installation did not provide curl." 2
  record_change "curl-installed"
}

install_docker_apt_repository() {
  local codename arch signed_by repo_file
  command_exists curl || fail "curl is required before configuring the Docker apt repository." 2
  command_exists gpg || { apt_bounded install -y gnupg; command_exists gpg || fail "gnupg installation did not provide gpg." 2; }
  # shellcheck disable=SC1091
  . /etc/os-release
  codename="${VERSION_CODENAME:-}"
  [[ -n "$codename" ]] || fail "Could not detect distro codename for Docker apt repository." 2
  case "$(dpkg --print-architecture)" in
    amd64|arm64) arch="$(dpkg --print-architecture)" ;;
    *) fail "Unsupported apt architecture for Docker repository: $(dpkg --print-architecture)." 2 ;;
  esac
  signed_by="/etc/apt/keyrings/docker.asc"
  repo_file="/etc/apt/sources.list.d/docker.list"
  as_root install -m 0755 -d /etc/apt/keyrings
  if [[ ! -s "$signed_by" ]]; then
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | as_root tee "$signed_by" >/dev/null
    as_root chmod a+r "$signed_by"
  fi
  printf 'deb [arch=%s signed-by=%s] https://download.docker.com/linux/%s %s stable\n' "$arch" "$signed_by" "${ID}" "$codename" \
    | as_root tee "$repo_file" >/dev/null
}

prepare_install_dir() {
  if [[ -d "$INSTALL_DIR" && -f "$COMPOSE_FILE" && -f "$TLS_COMPOSE_FILE" ]]; then
    info "Existing install at ${INSTALL_DIR} detected; preserving state."
  fi
  info "Preparing ${INSTALL_DIR}."
  as_root mkdir -p "$INSTALL_DIR" "$STATE_DIR"
  as_root chmod 700 "$INSTALL_DIR"
  install_compose_file
  record_change "compose-files-installed"
}

install_compose_file() {
  local tmp tls_tmp
  local template_root="$REPO_ROOT"
  source_is_valid && template_root="${INSTALL_DIR}/source"
  tmp="$(mktemp)"
  tls_tmp="$(mktemp)"
  sed 's#context: ../..#context: ./source#g' "${template_root}/infra/vps/compose.yml" >"$tmp"
  sed 's#context: ../..#context: ./source#g' "${template_root}/infra/vps/compose.tls.yml" >"$tls_tmp"
  if [[ ! -f "$COMPOSE_FILE" ]] || ! cmp -s "$tmp" "$COMPOSE_FILE"; then as_root install -m 644 "$tmp" "$COMPOSE_FILE"; fi
  if [[ ! -f "$TLS_COMPOSE_FILE" ]] || ! cmp -s "$tls_tmp" "$TLS_COMPOSE_FILE"; then as_root install -m 644 "$tls_tmp" "$TLS_COMPOSE_FILE"; fi
  rm -f "$tmp" "$tls_tmp"
}

apt_bounded() {
  local status
  if as_root timeout --foreground "${APT_TIMEOUT_SECONDS}s" apt-get \
    -o DPkg::Lock::Timeout="${APT_TIMEOUT_SECONDS}" \
    -o Acquire::http::Timeout="${APT_TIMEOUT_SECONDS}" \
    -o Acquire::https::Timeout="${APT_TIMEOUT_SECONDS}" "$@"; then
    return 0
  else
    status=$?
  fi
  if [[ "$status" -eq 124 || "$status" -eq 137 ]]; then
    fail "Timed out after ${APT_TIMEOUT_SECONDS}s during apt-get $*." 1
  fi
  fail "apt-get $* failed with status ${status}." "$status"
}

compose() { as_root docker compose -f "$COMPOSE_FILE" -f "$TLS_COMPOSE_FILE" --project-directory "$INSTALL_DIR" "$@"; }

validate_compose() {
  info "Validating base Compose plus the Traefik overlay without interpolation or profiles."
  compose config --no-interpolate >/dev/null
}

main() {
  parse_args "$@"
  if [[ "${CHECK}" == "1" ]]; then
    if [[ "${NOOP}" == "1" ]]; then
      fail "--check cannot be combined with --noop." 2
    fi
    trap - ERR
    check_prerequisites
    return $?
  fi
  install_log_setup
  if [[ "${INTERACTIVE}" == "1" ]]; then
    [[ "$(prompt_value 'Install Docker prerequisites and Compose templates?' 'yes')" == "yes" ]] || fail "Installation cancelled." 1
    info "Interactive prerequisite confirmation accepted."
  else
    info "Running in explicit non-interactive mode."
  fi
  if [[ "${NOOP}" == "1" ]]; then
   info "Noop mode: skipping preflight, Docker install, and Compose preparation."
    return 0
  fi
  state_prepare_dir
  acquire_state_lock || return $?
  trap release_state_lock EXIT
   run_progress_step 1 "Host preflight" preflight || return $?
     load_installer_state || { local state_status=$?; ACTIVE_STEP="installer state load/validation"; _report_error "$state_status"; }
    repair_installed_artifacts
   run_progress_step 2 "curl" run_install_curl_step || return $?
   run_progress_step 3 "Docker/Compose" run_install_docker_step || return $?
    run_progress_step 4 "Install directory and overlay copy" run_prepare_install_dir_step || return $?
   run_progress_step 5 "Config validation" validate_compose || return $?
    run_progress_step 6 "P1 handoff" p1_handoff || return $?
 }

p1_handoff() {
  install_runtime_handoff
  info "P0 prerequisite setup is complete; runtime setup was not executed by P0. No runtime secrets were generated or persisted, and no services were started."
  if source_is_valid; then info "Runtime command: sudo /opt/deploylite/runtime-handoff.sh --env-file <operator-file>"; else info "Runtime handoff unavailable; run the exact-SHA bootstrap to install a verified source bundle."; fi
  info "Limits: operator must provide a root-owned 0600 env file; DNS must resolve to this host and HTTPS/ACME must be verified externally."
}

install_runtime_handoff() {
  local source="$REPO_ROOT/scripts/runtime-handoff.sh"
  source_is_valid && source="${INSTALL_DIR}/source/scripts/runtime-handoff.sh"
  [[ -f "$source" ]] || fail "Installer source contract is missing: ${source}." 2
  if [[ ! -f "${INSTALL_DIR}/runtime-handoff.sh" ]] || ! cmp -s "$source" "${INSTALL_DIR}/runtime-handoff.sh"; then as_root install -m 0755 -o 0 -g 0 "$source" "${INSTALL_DIR}/runtime-handoff.sh"; fi
  info "Refreshed runtime entrypoint at ${INSTALL_DIR}/runtime-handoff.sh."
}

run_install_curl_step() { run_durable_step install-curl install_curl; }
run_install_docker_step() { run_durable_step install-docker install_docker; }
run_prepare_install_dir_step() { run_durable_step prepare-install-dir prepare_install_dir; }
repair_installed_artifacts() {
  state_has_step prepare-install-dir || return 0
  source_is_valid || return 0
  install_compose_file
  install_runtime_handoff
}
load_installer_state() {
  ACTIVE_STEP="installer state load/validation"
  state_load
  ACTIVE_STEP=""
}

if [[ "${DEPLOYLITE_INSTALL_TESTING:-0}" != "1" ]]; then
  main "$@"
fi
